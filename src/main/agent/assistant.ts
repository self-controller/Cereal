import { TASK_STATUS_LABELS, type AgentHome, type AgentMessage, type AgentRoutine, type AgentThread, type AssistantSnapshot, type ToolCallOutput } from '@shared/agent'
import type { Store } from '../db/store'
import type { AgentRun, AgentStore, Approval, Delivery, InboxItem, InboxSource } from '../db/agent-store'
import type { SettingsService } from '../settings'
import { providerConfig } from '../llm'
import type { AgentBackend, RunKindHandler } from './backend'
import type { AgentFiles } from './files'
import { conversationSystemPrompt, taskSystemPrompt } from './prompts'
import { describeSchedule, nextFireAfter } from './schedule'
import type { AssistantOps } from './tool'
import { toolsFor } from './tools'

const HOME_KEY = 'agent.home'

export interface AssistantDeps {
  store: Store
  agentStore: AgentStore
  backend: AgentBackend
  settings: SettingsService
  files: AgentFiles
  emitMessage(m: AgentMessage): void
  emitThread(t: AgentThread): void
  emitHome(h: AgentHome | null): void
  emitRoutines(): void
  /** Desktop notification that opens `route` when clicked. Only used while Cereal isn't focused. */
  notify(title: string, body: string, route: string): void
  isFocused(): boolean
}

function stamp(d = new Date()): string {
  return d.toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * The Assistant, after Granola's "Keto" runtime: one conversation thread that delegates work to task threads (each
 * its own agent run, in parallel), an inbox that turns user messages, task results, routine firings and events into
 * runs, routines on at/rate/cron schedules, a published Home, and approvals that pause a task until the user decides.
 */
export class Assistant implements RunKindHandler, AssistantOps {
  constructor(private readonly deps: AssistantDeps) {
    deps.backend.handlers.assistant = this
    deps.backend.assistantOps = this
  }

  private get enabled(): boolean {
    return this.deps.settings.get().assistant.enabled
  }

  // -------------------------------------------------------------- UI API

  open(): AssistantSnapshot {
    const { agentStore, store } = this.deps
    const conversation = agentStore.conversation()
    return {
      enabled: this.enabled,
      conversation,
      messages: agentStore.listMessages(conversation.id),
      tasks: agentStore.listTasks(conversation.id),
      home: store.getSetting<AgentHome | null>(HOME_KEY, null),
      activeRuns: agentStore.activeRuns('assistant').map((r) => ({ run_id: r.id, thread_id: r.thread_id, message_id: r.message_id, status: r.status }))
    }
  }

  readThread(threadId: string): { thread: AgentThread; messages: AgentMessage[] } {
    const thread = this.deps.agentStore.getThread(threadId)
    if (!thread) throw new Error('That task no longer exists.')
    return { thread, messages: this.deps.agentStore.listMessages(threadId) }
  }

  /** A message from the user, to the conversation or straight to a task. */
  send(input: { threadId?: string | null; text: string; clientMessageId?: string }): AgentMessage {
    const { agentStore, backend } = this.deps
    if (!this.enabled) throw new Error('The Assistant is turned off. Turn it on in Settings → Assistant.')
    const text = input.text.trim()
    if (!text) throw new Error('Type a message first.')
    providerConfig(this.deps.settings)
    const thread = input.threadId ? agentStore.getThread(input.threadId) : agentStore.conversation()
    if (!thread) throw new Error('That task no longer exists.')
    // Sending while a step waits for approval declines it (Granola does the same in chat).
    const active = agentStore.activeRunForThread(thread.id)
    if (active?.status === 'waiting') backend.cancelRun(active.id)
    const message = agentStore.addMessage(thread.id, { author: 'user', text, status: 'completed', clientMessageId: input.clientMessageId ?? null })
    this.deps.emitMessage(message)
    this.enqueue(thread.id, 'user', `[${stamp()}] ${text}`)
    return message
  }

  /** Stop whatever the thread is doing. */
  stop(threadId: string): void {
    const run = this.deps.agentStore.activeRunForThread(threadId)
    if (run) this.deps.backend.cancelRun(run.id)
  }

  /** Archive the conversation and its tasks and start over. */
  reset(): AssistantSnapshot {
    const { agentStore, store, backend } = this.deps
    for (const run of agentStore.activeRuns('assistant')) backend.cancelRun(run.id)
    const old = agentStore.conversation()
    agentStore.archiveConversation(old.id)
    store.deleteSetting(HOME_KEY)
    this.deps.emitHome(null)
    return this.open()
  }

  updateRoutine(id: string, patch: { enabled: boolean }): AgentRoutine {
    const r = this.deps.agentStore.getRoutine(id)
    if (!r) throw new Error('That routine no longer exists.')
    const next = patch.enabled ? (nextFireAfter(r.expression, new Date(), r.timezone)?.toISOString() ?? null) : r.next_fire_at
    const updated = this.deps.agentStore.updateRoutine(id, { enabled: patch.enabled, next_fire_at: next })
    this.deps.emitRoutines()
    return updated
  }

  // ------------------------------------------------------------ inbox

  private enqueue(threadId: string, source: InboxSource, message: string, delivery: Delivery = 'immediate'): InboxItem {
    const item = this.deps.agentStore.enqueue({ threadId, source, message, delivery })
    this.drain()
    return item
  }

  /** Start a run for every thread with deliverable inbox items and nothing running (one run per thread). */
  drain(): void {
    if (!this.enabled) return
    const { agentStore, backend } = this.deps
    const agentIdle = !agentStore.activeRuns('assistant').some((r) => r.status === 'queued' || r.status === 'running')
    for (const threadId of agentStore.readyInboxThreads(new Date().toISOString(), agentIdle)) {
      if (agentStore.activeRunForThread(threadId)) continue
      const thread = agentStore.getThread(threadId)
      const items = agentStore.takeInbox(threadId)
      if (!thread || !items.length) continue
      const input = items.map((i) => i.message).join('\n\n')
      agentStore.appendTranscript(threadId, [{ role: 'user', content: input }])
      const reply = agentStore.addMessage(threadId, { author: 'agent', status: 'in_progress' })
      if (thread.kind === 'task' && thread.status !== 'active') this.deps.emitThread(agentStore.updateThread(threadId, { status: 'active', pending_approval: null }))
      const run = backend.createRun({ kind: 'assistant', threadId, messageId: reply.id, context: thread.kind === 'task' ? 'task' : 'conversation', input })
      this.deps.emitMessage(agentStore.updateMessage(reply.id, { run_id: run.id }))
    }
  }

  /** Fire due routines (catching up once on fires missed while Cereal was closed) and deliver batched items. */
  tick(now = new Date()): void {
    if (!this.enabled) return
    const { agentStore } = this.deps
    let changed = false
    for (const r of agentStore.dueRoutines(now.toISOString())) {
      const target = r.task_thread_id ? agentStore.getThread(r.task_thread_id) : null
      const threadId = target && target.status !== 'cancelled' ? target.id : agentStore.conversation().id
      agentStore.enqueue({ threadId, source: 'scheduler', message: `[Routine ${r.id}: ${describeSchedule(r.expression, r.timezone)}, ${stamp(now)}] ${r.message}`, delivery: r.delivery })
      const next = nextFireAfter(r.expression, now, r.timezone)
      agentStore.updateRoutine(r.id, { last_fired_at: now.toISOString(), next_fire_at: next?.toISOString() ?? null, ...(next ? {} : { enabled: false }) })
      changed = true
    }
    if (changed) this.deps.emitRoutines()
    this.drain()
  }

  // ------------------------------------------------------------ run hooks

  prepare(run: AgentRun): ReturnType<RunKindHandler['prepare']> {
    const { agentStore, settings, files } = this.deps
    const thread = agentStore.getThread(run.thread_id)
    if (!thread) throw new Error('The thread for this run no longer exists.')
    const ctx = { settings: settings.get(), memory: files.memoryIndex(), skills: files.skills().skills }
    return thread.kind === 'task'
      ? { system: taskSystemPrompt(ctx, thread), tools: toolsFor('task'), maxSteps: 30 }
      : { system: conversationSystemPrompt(ctx), tools: toolsFor('conversation'), maxSteps: 16 }
  }

  finished(run: AgentRun): void {
    const { agentStore } = this.deps
    const thread = agentStore.getThread(run.thread_id)
    if (thread?.kind === 'task' && thread.status === 'active') {
      // The task ended without publishing a result: report what happened.
      const message = run.message_id ? agentStore.getMessage(run.message_id) : null
      if (run.status === 'cancelled') {
        this.deps.emitThread(agentStore.updateThread(thread.id, { status: 'cancelled', pending_approval: null }))
      } else if (run.status === 'failed') {
        this.settle(thread, 'failed', (run.error ?? 'Something went wrong.').slice(0, 200), run.error ?? '', run.message_id)
      } else {
        const text = message?.text.trim() ?? ''
        this.settle(thread, 'done', firstLine(text) || 'Finished', text || 'The task finished without a written result.', run.message_id)
      }
    }
    this.drain()
  }

  approvalRequested(run: AgentRun, approval: Approval): void {
    const { agentStore } = this.deps
    const thread = agentStore.getThread(run.thread_id)
    if (!thread) return
    if (thread.kind === 'task') this.deps.emitThread(agentStore.updateThread(thread.id, { status: 'needs_input', pending_approval: { id: approval.id, label: approval.label, detail: approval.detail } }))
    this.notify('Cereal Assistant needs your approval', approval.label, thread.kind === 'task' ? `/assistant/task/${thread.id}` : '/assistant')
  }

  approvalDecided(run: AgentRun, approval: Approval): void {
    const { agentStore } = this.deps
    const thread = agentStore.getThread(run.thread_id)
    if (thread?.kind === 'task' && thread.pending_approval?.id === approval.id) {
      this.deps.emitThread(agentStore.updateThread(thread.id, { status: 'active', pending_approval: null }))
    }
  }

  private notify(title: string, body: string, route: string): void {
    if (!this.deps.isFocused()) this.deps.notify(title, body, route)
  }

  /** Record a task's outcome and report it to the conversation (Keto's assistant.result.publish). */
  private settle(task: AgentThread, status: 'done' | 'needs_input' | 'failed', summary: string, text: string, resultMessageId: string | null): AgentThread {
    const { agentStore } = this.deps
    const updated = agentStore.updateThread(task.id, { status, summary, result_message_id: resultMessageId, pending_approval: null })
    this.deps.emitThread(updated)
    if (task.parent_thread_id) {
      this.deps.agentStore.enqueue({ threadId: task.parent_thread_id, source: 'child', message: `[Task "${task.title}" (task_id ${task.id}) — ${TASK_STATUS_LABELS[status]}] ${summary}\n\n${text}` })
    }
    const verb = status === 'done' ? 'Task done' : status === 'needs_input' ? 'A task needs you' : 'Task failed'
    this.notify(`${verb}: ${task.title ?? 'Task'}`, summary, `/assistant/task/${task.id}`)
    return updated
  }

  // ------------------------------------------------------- AssistantOps

  startTask(conversationId: string, init: { title: string; handoff: string; lifetime: 'once' | 'ongoing'; followsTaskId?: string }): AgentThread {
    const { agentStore } = this.deps
    const follows = init.followsTaskId ? this.task(init.followsTaskId) : null
    const task = agentStore.createThread({ kind: 'task', parentId: conversationId, followsId: follows?.thread.id ?? null, title: init.title, status: 'active', lifetime: init.lifetime })
    this.deps.emitThread(task)
    const handoff = follows?.result ? `${init.handoff}\n\nThis continues the task "${follows.thread.title}", whose result was:\n${follows.result}` : init.handoff
    this.deps.emitMessage(agentStore.addMessage(task.id, { author: 'parent', text: init.handoff, status: 'completed' }))
    this.enqueue(task.id, 'parent', handoff)
    return agentStore.getThread(task.id)!
  }

  messageTask(taskId: string, message: string): AgentThread {
    const { agentStore } = this.deps
    const task = agentStore.getThread(taskId)
    if (!task || task.kind !== 'task') throw new Error(`No task with id ${taskId}.`)
    if (task.status === 'cancelled') throw new Error('That task was stopped. Start a new one instead.')
    this.deps.emitMessage(agentStore.addMessage(taskId, { author: 'parent', text: message, status: 'completed' }))
    this.enqueue(taskId, 'parent', `[From the conversation, ${stamp()}] ${message}`)
    return agentStore.getThread(taskId)!
  }

  stopTask(taskId: string): AgentThread {
    const { agentStore, backend } = this.deps
    const task = agentStore.getThread(taskId)
    if (!task || task.kind !== 'task') throw new Error(`No task with id ${taskId}.`)
    agentStore.takeInbox(taskId)
    const run = agentStore.activeRunForThread(taskId)
    if (run) backend.cancelRun(run.id)
    const stopped = agentStore.updateThread(taskId, { status: 'cancelled', pending_approval: null })
    this.deps.emitThread(stopped)
    return stopped
  }

  task(taskId: string): { thread: AgentThread; result: string | null } | null {
    const { agentStore } = this.deps
    const thread = agentStore.getThread(taskId)
    if (!thread || thread.kind !== 'task') return null
    const message = thread.result_message_id ? agentStore.getMessage(thread.result_message_id) : null
    const published = message?.outputs.find((o): o is ToolCallOutput => o.type === 'tool_call' && o.name === 'publishResult' && !o.error)
    const result = published ? String((published.args as { text?: string }).text ?? '') : message?.text || null
    return { thread, result }
  }

  tasks(conversationId: string): AgentThread[] {
    return this.deps.agentStore.listTasks(conversationId)
  }

  publishResult(taskId: string, result: { status: 'done' | 'needs_input' | 'failed'; summary: string; text: string }): AgentThread {
    const { agentStore } = this.deps
    const task = agentStore.getThread(taskId)
    if (!task || task.kind !== 'task') throw new Error('publishResult only works inside a task.')
    const run = agentStore.activeRunForThread(taskId)
    return this.settle(task, result.status, result.summary, result.text, run?.message_id ?? null)
  }

  publishHome(home: Omit<AgentHome, 'updated_at'>): AgentHome {
    const known = new Set(this.deps.agentStore.listTasks(this.deps.agentStore.conversation().id).map((t) => t.id))
    const clean: AgentHome = { briefing: home.briefing, groups: home.groups.map((g) => ({ title: g.title, taskIds: g.taskIds.filter((id) => known.has(id)) })), updated_at: new Date().toISOString() }
    this.deps.store.setSetting(HOME_KEY, clean)
    this.deps.emitHome(clean)
    return clean
  }

  createRoutine(init: { message: string; expression: string; timezone: string; taskId: string | null }): AgentRoutine {
    const next = nextFireAfter(init.expression, new Date(), init.timezone)
    if (!next) throw new Error('That time is already in the past.')
    const r = this.deps.agentStore.createRoutine({ task_thread_id: init.taskId, message: init.message, expression: init.expression, timezone: init.timezone, delivery: 'immediate', next_fire_at: next.toISOString() })
    this.deps.emitRoutines()
    return r
  }

  routines(): AgentRoutine[] {
    return this.deps.agentStore.listRoutines()
  }

  deleteRoutine(id: string): void {
    if (!this.deps.agentStore.getRoutine(id)) throw new Error(`No routine with id ${id}.`)
    this.deps.agentStore.deleteRoutine(id)
    this.deps.emitRoutines()
  }
}

function firstLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').replace(/^[#>*\-\s]+/, '').slice(0, 200)
}
