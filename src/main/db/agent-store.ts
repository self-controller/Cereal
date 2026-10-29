import { randomUUID } from 'node:crypto'
import type { DB } from './index'
import type {
  AgentEvent,
  AgentEventRecord,
  AgentMessage,
  AgentOutput,
  AgentRoutine,
  AgentThread,
  MessageAuthor,
  MessageStatus,
  PendingApproval,
  RunStatus,
  TaskStatus,
  ToolContext
} from '@shared/agent'
import type { ModelMessage } from '../llm/provider'
import { describeSchedule } from '../agent/schedule'

const now = (): string => new Date().toISOString()

function parse<T>(json: string | null | undefined, fallback: T): T {
  if (json == null || json === '') return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

export type RunKind = 'chat' | 'assistant'

export interface AgentRun {
  id: string
  kind: RunKind
  thread_id: string
  message_id: string | null
  context: ToolContext
  status: RunStatus
  /** The chat's model choice ('auto' or `provider/model`); null for Settings' provider. */
  llm: string | null
  /** The model input this run was started with (user message or inbox items), already in the transcript. */
  input: string | null
  /** Tool results of a step that is waiting for approval. */
  pending: PendingStep | null
  error: string | null
  last_sequence: number
  created_at: string
  started_at: string | null
  finished_at: string | null
}

/** A step suspended on approvals: the results we already have and the calls still waiting. */
export interface PendingStep {
  results: { id: string; name: string; content: string; isError?: boolean }[]
  waiting: { id: string; name: string; args: unknown }[]
}

export interface Approval {
  id: string
  run_id: string
  message_id: string | null
  tool_call_id: string
  tool_name: string
  args: unknown
  label: string
  detail: string | null
  status: 'pending' | 'approved' | 'denied'
  created_at: string
  decided_at: string | null
}

export type InboxSource = 'user' | 'parent' | 'child' | 'scheduler' | 'event'
export type Delivery = 'immediate' | 'batch' | 'idle'

export interface InboxItem {
  id: string
  thread_id: string
  source: InboxSource
  message: string
  delivery: Delivery
  available_at: string
  created_at: string
}

export interface Source {
  n: number
  document_id: string
  title: string
}

type RunRow = Omit<AgentRun, 'pending'> & { pending: string | null }
type ThreadRow = Omit<AgentThread, 'pending_approval'> & { pending_approval: string | null; archived_at: string | null }
type MessageRow = Omit<AgentMessage, 'outputs'> & { outputs: string }
type RoutineRow = Omit<AgentRoutine, 'enabled' | 'description'> & { enabled: number }

/** Persistence for the agent runtime: transcripts, runs and their events, Assistant threads, inbox, routines. */
export class AgentStore {
  constructor(readonly db: DB) {}

  // ------------------------------------------------------------- transcript

  private epoch(threadId: string): number {
    const row = this.db.prepare('SELECT MAX(epoch) AS e FROM agent_model_messages WHERE thread_id = ?').get(threadId) as { e: number | null }
    return row.e ?? 0
  }

  /** The current epoch of a thread's model transcript, oldest first. */
  transcript(threadId: string): ModelMessage[] {
    return (
      this.db.prepare('SELECT message FROM agent_model_messages WHERE thread_id = ? AND epoch = ? ORDER BY sequence').all(threadId, this.epoch(threadId)) as {
        message: string
      }[]
    ).map((r) => JSON.parse(r.message) as ModelMessage)
  }

  /** Append turns. Earlier turns are never edited (the model's thinking blocks are bound to the exact history). */
  appendTranscript(threadId: string, messages: ModelMessage[]): void {
    const epoch = this.epoch(threadId)
    const row = this.db.prepare('SELECT MAX(sequence) AS s FROM agent_model_messages WHERE thread_id = ? AND epoch = ?').get(threadId, epoch) as { s: number | null }
    let seq = row.s ?? 0
    const insert = this.db.prepare('INSERT INTO agent_model_messages (thread_id, epoch, sequence, message, created_at) VALUES (?, ?, ?, ?, ?)')
    const ts = now()
    this.db.transaction(() => {
      for (const m of messages) insert.run(threadId, epoch, ++seq, JSON.stringify(m), ts)
    })()
  }

  /** Start a new epoch holding `messages` (a summary plus recent turns). Older epochs stay as they were. */
  startEpoch(threadId: string, messages: ModelMessage[]): void {
    const epoch = this.epoch(threadId) + 1
    const insert = this.db.prepare('INSERT INTO agent_model_messages (thread_id, epoch, sequence, message, created_at) VALUES (?, ?, ?, ?, ?)')
    const ts = now()
    this.db.transaction(() => messages.forEach((m, i) => insert.run(threadId, epoch, i + 1, JSON.stringify(m), ts)))()
  }

  // ---------------------------------------------------------------- sources

  sources(threadId: string): Source[] {
    return this.db.prepare('SELECT n, document_id, title FROM agent_sources WHERE thread_id = ? ORDER BY n').all(threadId) as Source[]
  }

  /** The stable citation number of a meeting within a thread, assigning the next one on first use. */
  sourceNumber(threadId: string, documentId: string, title: string): number {
    const existing = this.db.prepare('SELECT n FROM agent_sources WHERE thread_id = ? AND document_id = ?').get(threadId, documentId) as { n: number } | undefined
    if (existing) {
      this.db.prepare('UPDATE agent_sources SET title = ? WHERE thread_id = ? AND n = ?').run(title, threadId, existing.n)
      return existing.n
    }
    const row = this.db.prepare('SELECT MAX(n) AS n FROM agent_sources WHERE thread_id = ?').get(threadId) as { n: number | null }
    const n = (row.n ?? 0) + 1
    this.db.prepare('INSERT INTO agent_sources (thread_id, n, document_id, title) VALUES (?, ?, ?, ?)').run(threadId, n, documentId, title)
    return n
  }

  /** Drop everything the agent kept for a thread (transcript, sources, runs and their events). */
  deleteThreadData(threadId: string): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM agent_model_messages WHERE thread_id = ?').run(threadId)
      this.db.prepare('DELETE FROM agent_sources WHERE thread_id = ?').run(threadId)
      this.db.prepare('DELETE FROM agent_runs WHERE thread_id = ?').run(threadId)
    })()
  }

  // ------------------------------------------------------------------- runs

  private toRun(r: RunRow): AgentRun {
    return { ...r, pending: parse<PendingStep | null>(r.pending, null) }
  }

  createRun(init: { kind: RunKind; threadId: string; messageId: string | null; context: ToolContext; input?: string | null; llm?: string | null }): AgentRun {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO agent_runs (id, kind, thread_id, message_id, context, status, input, llm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, init.kind, init.threadId, init.messageId, init.context, 'queued', init.input ?? null, init.llm ?? null, now())
    return this.getRun(id)!
  }

  getRun(id: string): AgentRun | null {
    const r = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as RunRow | undefined
    return r ? this.toRun(r) : null
  }

  updateRun(id: string, patch: Partial<Pick<AgentRun, 'status' | 'pending' | 'error' | 'started_at' | 'finished_at' | 'message_id'>>): AgentRun {
    const cols = Object.keys(patch) as (keyof typeof patch)[]
    if (cols.length) {
      const values = cols.map((c) => (c === 'pending' ? (patch.pending ? JSON.stringify(patch.pending) : null) : patch[c]))
      this.db.prepare(`UPDATE agent_runs SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, id)
    }
    return this.getRun(id)!
  }

  /** Runs that are queued, running or waiting for approval. */
  activeRuns(kind?: RunKind): AgentRun[] {
    const rows = (
      kind
        ? this.db.prepare(`SELECT * FROM agent_runs WHERE status IN ('queued', 'running', 'waiting') AND kind = ? ORDER BY created_at`).all(kind)
        : this.db.prepare(`SELECT * FROM agent_runs WHERE status IN ('queued', 'running', 'waiting') ORDER BY created_at`).all()
    ) as RunRow[]
    return rows.map((r) => this.toRun(r))
  }

  activeRunForThread(threadId: string): AgentRun | null {
    const r = this.db.prepare(`SELECT * FROM agent_runs WHERE thread_id = ? AND status IN ('queued', 'running', 'waiting') ORDER BY created_at DESC LIMIT 1`).get(threadId) as
      | RunRow
      | undefined
    return r ? this.toRun(r) : null
  }

  lastRunForThread(threadId: string): AgentRun | null {
    const r = this.db.prepare('SELECT * FROM agent_runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1').get(threadId) as RunRow | undefined
    return r ? this.toRun(r) : null
  }

  // ----------------------------------------------------------------- events

  /** Append events with the run's next sequence numbers (Keto's per-run event log). */
  appendEvents(runId: string, events: AgentEvent[]): AgentEventRecord[] {
    const run = this.getRun(runId)
    if (!run) return []
    const ts = now()
    const insert = this.db.prepare('INSERT INTO agent_events (run_id, sequence, thread_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    const records: AgentEventRecord[] = []
    this.db.transaction(() => {
      let seq = run.last_sequence
      for (const event of events) {
        seq++
        insert.run(runId, seq, run.thread_id, event.type, JSON.stringify(event), ts)
        records.push({ run_id: runId, thread_id: run.thread_id, sequence: seq, created_at: ts, event })
      }
      this.db.prepare('UPDATE agent_runs SET last_sequence = ? WHERE id = ?').run(seq, runId)
    })()
    return records
  }

  eventsSince(runId: string, afterSequence: number): AgentEventRecord[] {
    return (
      this.db.prepare('SELECT run_id, thread_id, sequence, created_at, payload FROM agent_events WHERE run_id = ? AND sequence > ? ORDER BY sequence').all(runId, afterSequence) as {
        run_id: string
        thread_id: string
        sequence: number
        created_at: string
        payload: string
      }[]
    ).map((r) => ({ run_id: r.run_id, thread_id: r.thread_id, sequence: r.sequence, created_at: r.created_at, event: JSON.parse(r.payload) as AgentEvent }))
  }

  /** Forget the event logs of runs that finished before `before` (their messages keep the outcome). */
  pruneEvents(before: string): void {
    this.db.prepare(`DELETE FROM agent_events WHERE run_id IN (SELECT id FROM agent_runs WHERE finished_at IS NOT NULL AND finished_at < ?)`).run(before)
  }

  // -------------------------------------------------------------- approvals

  private toApproval(r: Omit<Approval, 'args'> & { args: string }): Approval {
    return { ...r, args: parse<unknown>(r.args, {}) }
  }

  createApproval(init: { runId: string; messageId: string | null; toolCallId: string; toolName: string; args: unknown; label: string; detail: string | null }): Approval {
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO agent_approvals (id, run_id, message_id, tool_call_id, tool_name, args, label, detail, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, init.runId, init.messageId, init.toolCallId, init.toolName, JSON.stringify(init.args ?? {}), init.label, init.detail, 'pending', now())
    return this.getApproval(id)!
  }

  getApproval(id: string): Approval | null {
    const r = this.db.prepare('SELECT * FROM agent_approvals WHERE id = ?').get(id) as (Omit<Approval, 'args'> & { args: string }) | undefined
    return r ? this.toApproval(r) : null
  }

  approvalsForRun(runId: string): Approval[] {
    return (this.db.prepare('SELECT * FROM agent_approvals WHERE run_id = ? ORDER BY created_at').all(runId) as (Omit<Approval, 'args'> & { args: string })[]).map((r) =>
      this.toApproval(r)
    )
  }

  decideApproval(id: string, status: 'approved' | 'denied'): Approval {
    this.db.prepare(`UPDATE agent_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'`).run(status, now(), id)
    return this.getApproval(id)!
  }

  // ---------------------------------------------------------------- threads

  private toThread(r: ThreadRow): AgentThread {
    const { archived_at: _archived, ...rest } = r
    return { ...rest, pending_approval: parse<PendingApproval | null>(r.pending_approval, null) }
  }

  /** The current Assistant conversation, created on first use. */
  conversation(): AgentThread {
    const r = this.db.prepare(`SELECT * FROM agent_threads WHERE kind = 'conversation' AND archived_at IS NULL ORDER BY created_at DESC LIMIT 1`).get() as ThreadRow | undefined
    if (r) return this.toThread(r)
    return this.createThread({ kind: 'conversation', title: 'Assistant' })
  }

  /** Archive the conversation and its tasks; the next `conversation()` call starts fresh. */
  archiveConversation(id: string): void {
    const ts = now()
    this.db.prepare('UPDATE agent_threads SET archived_at = ? WHERE id = ? OR parent_thread_id = ?').run(ts, id, id)
  }

  createThread(init: {
    kind: AgentThread['kind']
    parentId?: string | null
    followsId?: string | null
    title?: string | null
    status?: TaskStatus | null
    lifetime?: AgentThread['lifetime']
  }): AgentThread {
    const id = randomUUID()
    const ts = now()
    this.db
      .prepare(
        `INSERT INTO agent_threads (id, kind, parent_thread_id, follows_thread_id, title, status, lifetime, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, init.kind, init.parentId ?? null, init.followsId ?? null, init.title ?? null, init.status ?? null, init.lifetime ?? null, ts, ts)
    return this.getThread(id)!
  }

  getThread(id: string): AgentThread | null {
    const r = this.db.prepare('SELECT * FROM agent_threads WHERE id = ?').get(id) as ThreadRow | undefined
    return r ? this.toThread(r) : null
  }

  /** Update a thread; tasks bump their revision on every change. */
  updateThread(id: string, patch: Partial<Pick<AgentThread, 'title' | 'summary' | 'status' | 'result_message_id' | 'pending_approval' | 'lifetime'>>): AgentThread {
    const cols = Object.keys(patch) as (keyof typeof patch)[]
    if (cols.length) {
      const values = cols.map((c) => (c === 'pending_approval' ? (patch.pending_approval ? JSON.stringify(patch.pending_approval) : null) : patch[c]))
      this.db.prepare(`UPDATE agent_threads SET ${cols.map((c) => `${c} = ?`).join(', ')}, revision = revision + 1, updated_at = ? WHERE id = ?`).run(...values, now(), id)
    }
    const thread = this.getThread(id)
    if (!thread) throw new Error(`Thread ${id} not found`)
    return thread
  }

  listTasks(conversationId: string): AgentThread[] {
    return (this.db.prepare(`SELECT * FROM agent_threads WHERE parent_thread_id = ? AND archived_at IS NULL ORDER BY created_at DESC`).all(conversationId) as ThreadRow[]).map((r) =>
      this.toThread(r)
    )
  }

  // --------------------------------------------------------------- messages

  private toMessage(r: MessageRow): AgentMessage {
    return { ...r, outputs: parse<AgentOutput[]>(r.outputs, []) }
  }

  addMessage(threadId: string, init: { author: MessageAuthor; text?: string; status: MessageStatus; clientMessageId?: string | null; runId?: string | null }): AgentMessage {
    const id = randomUUID()
    const ts = now()
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT MAX(sequence) AS s FROM agent_messages WHERE thread_id = ?').get(threadId) as { s: number | null }
      this.db
        .prepare(
          `INSERT INTO agent_messages (id, thread_id, sequence, author, text, status, client_message_id, run_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, threadId, (row.s ?? 0) + 1, init.author, init.text ?? '', init.status, init.clientMessageId ?? null, init.runId ?? null, ts, ts)
      this.db.prepare('UPDATE agent_threads SET updated_at = ? WHERE id = ?').run(ts, threadId)
    })()
    return this.getMessage(id)!
  }

  getMessage(id: string): AgentMessage | null {
    const r = this.db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as MessageRow | undefined
    return r ? this.toMessage(r) : null
  }

  updateMessage(id: string, patch: Partial<Pick<AgentMessage, 'text' | 'outputs' | 'status' | 'error' | 'applied_sequence' | 'run_id'>>): AgentMessage {
    const cols = Object.keys(patch) as (keyof typeof patch)[]
    if (cols.length) {
      const values = cols.map((c) => (c === 'outputs' ? JSON.stringify(patch.outputs) : patch[c]))
      this.db.prepare(`UPDATE agent_messages SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now(), id)
    }
    const message = this.getMessage(id)
    if (!message) throw new Error(`Message ${id} not found`)
    return message
  }

  /** The most recent `limit` messages of a thread, oldest first. */
  listMessages(threadId: string, limit = 200): AgentMessage[] {
    return (this.db.prepare('SELECT * FROM agent_messages WHERE thread_id = ? ORDER BY sequence DESC LIMIT ?').all(threadId, limit) as MessageRow[]).reverse().map((r) => this.toMessage(r))
  }

  // ------------------------------------------------------------------ inbox

  enqueue(init: { threadId: string; source: InboxSource; message: string; delivery?: Delivery; delaySeconds?: number }): InboxItem {
    const id = randomUUID()
    const ts = now()
    const delivery = init.delivery ?? 'immediate'
    const available = delivery === 'batch' ? new Date(Date.now() + (init.delaySeconds ?? 60) * 1000).toISOString() : ts
    this.db
      .prepare('INSERT INTO agent_inbox (id, thread_id, source, message, delivery, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, init.threadId, init.source, init.message, delivery, available, ts)
    return this.db.prepare('SELECT * FROM agent_inbox WHERE id = ?').get(id) as InboxItem
  }

  /**
   * Threads with inbox items ready to deliver. Batched items wait until their window ends (then every item of the
   * thread goes together); idle items wait until no Assistant run is active anywhere.
   */
  readyInboxThreads(atIso: string, agentIdle: boolean): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT thread_id FROM agent_inbox
         WHERE (delivery = 'immediate' OR (delivery = 'batch' AND available_at <= ?) OR (delivery = 'idle' AND ?))
         ORDER BY created_at`
      )
      .all(atIso, agentIdle ? 1 : 0) as { thread_id: string }[]
    return rows.map((r) => r.thread_id)
  }

  /** Remove and return every pending item of a thread, oldest first. */
  takeInbox(threadId: string): InboxItem[] {
    const items = this.db.prepare('SELECT * FROM agent_inbox WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as InboxItem[]
    this.db.prepare('DELETE FROM agent_inbox WHERE thread_id = ?').run(threadId)
    return items
  }

  // --------------------------------------------------------------- routines

  private toRoutine(r: RoutineRow): AgentRoutine {
    return { ...r, enabled: !!r.enabled, description: describeSchedule(r.expression, r.timezone) }
  }

  createRoutine(init: Omit<AgentRoutine, 'id' | 'created_at' | 'last_fired_at' | 'enabled' | 'description'>): AgentRoutine {
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO agent_schedules (id, task_thread_id, message, expression, timezone, delivery, enabled, next_fire_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(id, init.task_thread_id, init.message, init.expression, init.timezone, init.delivery, init.next_fire_at, now())
    return this.getRoutine(id)!
  }

  getRoutine(id: string): AgentRoutine | null {
    const r = this.db.prepare('SELECT * FROM agent_schedules WHERE id = ?').get(id) as RoutineRow | undefined
    return r ? this.toRoutine(r) : null
  }

  listRoutines(): AgentRoutine[] {
    return (this.db.prepare('SELECT * FROM agent_schedules ORDER BY created_at').all() as RoutineRow[]).map((r) => this.toRoutine(r))
  }

  updateRoutine(id: string, patch: Partial<Pick<AgentRoutine, 'enabled' | 'next_fire_at' | 'last_fired_at'>>): AgentRoutine {
    const cols = Object.keys(patch) as (keyof typeof patch)[]
    if (cols.length) {
      const values = cols.map((c) => (c === 'enabled' ? (patch.enabled ? 1 : 0) : patch[c]))
      this.db.prepare(`UPDATE agent_schedules SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values, id)
    }
    return this.getRoutine(id)!
  }

  deleteRoutine(id: string): void {
    this.db.prepare('DELETE FROM agent_schedules WHERE id = ?').run(id)
  }

  dueRoutines(atIso: string): AgentRoutine[] {
    return (this.db.prepare('SELECT * FROM agent_schedules WHERE enabled = 1 AND next_fire_at IS NOT NULL AND next_fire_at <= ?').all(atIso) as RoutineRow[]).map((r) =>
      this.toRoutine(r)
    )
  }
}
