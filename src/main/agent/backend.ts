import { applyAgentEvent, outputsText, type AgentEvent, type AgentEventRecord, type AgentMessage, type AgentOutput, type ToolCallOutput } from '@shared/agent'
import type { ChatMessage, LlmProviderId, Panel } from '@shared/types'
import type { Store } from '../db/store'
import type { AgentRun, AgentStore, Approval, PendingStep, RunKind } from '../db/agent-store'
import type { SettingsService } from '../settings'
import { chatProviderConfig, createProviderFromConfig, describeLlmError, providerConfig } from '../llm'
import type { ModelMessage, RemoteFile } from '../llm/provider'
import type { AttachmentService } from '../attachments/service'
import { extractCitations } from '../ai/service'
import type { NewUsageEvent } from '@shared/usage'
import { llmUsageEvent, recordSafely, type RecordUsage } from '../usage'
import type { AgentFiles } from './files'
import type { RunOutcome, RunSpec, ToolCall, ToolCallReply } from './protocol'
import { parseArgs, policyFor, toolSpec, type AgentTool, type AssistantOps, type ToolEnv } from './tool'
import { findTool } from './tools'

const CHAT_FLUSH_MS = 150

/** Runs the model/tool loop for runs: the agent worker in production, an in-process runtime in tests. */
export interface AgentHost {
  start(runId: string): void
  cancel(runId: string): void
  stop(): void
}

/** Per-kind hooks: chat runs answer in chat_messages, Assistant runs in agent threads. */
export interface RunKindHandler {
  prepare(run: AgentRun, maxInputChars: number): { system: string; tools: AgentTool[]; maxSteps: number }
  finished?(run: AgentRun): void
  approvalRequested?(run: AgentRun, approval: Approval): void
  approvalDecided?(run: AgentRun, approval: Approval): void
}

export interface BackendDeps {
  store: Store
  agentStore: AgentStore
  files: AgentFiles
  settings: SettingsService
  /** Chat attachments; without it, attachments in a transcript are named but not sent. */
  attachments?: AttachmentService | null
  rewriteNotes(documentId: string, instructions: string): Panel
  emitChatMessage(m: ChatMessage): void
  emitAgentMessage(m: AgentMessage): void
  emitAgentEvent(r: AgentEventRecord): void
  recordUsage?: RecordUsage
}

/** Stand-in when no Assistant is wired up (chat-only tests): Assistant tools fail with a clear message. */
const NO_ASSISTANT = new Proxy({} as AssistantOps, {
  get: () => () => {
    throw new Error('The Assistant is not available.')
  }
})

const isTerminal = (s: AgentRun['status']): boolean => s === 'completed' || s === 'failed' || s === 'cancelled'

/**
 * The agent's backend (main process), in the role Granola's servers play for Keto workers: it owns the database,
 * hands runs to the runtime, executes tools (pausing for approval where needed), folds the events a run reports into
 * its message and broadcasts them.
 */
export class AgentBackend {
  readonly handlers: Partial<Record<RunKind, RunKindHandler>> = {}
  assistantOps: AssistantOps | null = null
  host: AgentHost | null = null
  /** Live outputs of runs in progress, so events don't re-read the message each time. */
  private live = new Map<string, { outputs: AgentOutput[]; flushTimer: ReturnType<typeof setTimeout> | null; lastFlush: number }>()

  constructor(private readonly deps: BackendDeps) {}

  // ------------------------------------------------------------- lifecycle

  createRun(init: { kind: RunKind; threadId: string; messageId: string; context: AgentRun['context']; input?: string | null; llm?: string | null }): AgentRun {
    const run = this.deps.agentStore.createRun(init)
    this.host?.start(run.id)
    return run
  }

  /** Stop a run. A run waiting for approval has its pending calls declined so the transcript stays complete. */
  cancelRun(runId: string): void {
    const run = this.deps.agentStore.getRun(runId)
    if (!run || isTerminal(run.status)) return
    if (run.status === 'waiting') {
      const pending = run.pending
      if (pending) {
        const declined = pending.waiting.map((c) => ({ id: c.id, name: c.name, content: 'The user stopped this before it ran.', isError: true }))
        this.deps.agentStore.appendTranscript(run.thread_id, [{ role: 'tool', results: [...pending.results, ...declined] }])
      }
      this.finishRun(run, { status: 'cancelled' })
      return
    }
    if (run.status === 'queued') {
      this.host?.cancel(runId)
      this.finishRun(run, { status: 'cancelled' })
      return
    }
    this.host?.cancel(runId)
  }

  /** The user's decision on a pending tool call. Once every waiting call of the step is decided, the run resumes. */
  decide(approvalId: string, decision: 'approved' | 'denied', always = false): void {
    const { agentStore, settings } = this.deps
    const before = agentStore.getApproval(approvalId)
    if (!before || before.status !== 'pending') return
    const approval = agentStore.decideApproval(approvalId, decision)
    if (always && decision === 'approved') {
      const allow = new Set(settings.get().assistant.alwaysAllow)
      allow.add(approval.tool_name)
      settings.update({ assistant: { alwaysAllow: [...allow] } })
    }
    const run = agentStore.getRun(approval.run_id)
    if (!run) return
    const messageId = run.message_id ?? ''
    this.emit(run, [{ type: 'approval.decided', messageId, toolCallId: approval.tool_call_id, approval: { id: approval.id, status: approval.status } }])
    if (decision === 'denied') {
      // A declined call is finished as far as the UI is concerned; the model hears about it when the run resumes.
      const tool = findTool(approval.tool_name, run.context)
      const declined: ToolCallOutput = {
        type: 'tool_call',
        id: approval.tool_call_id,
        name: approval.tool_name,
        label: tool?.label.done ?? approval.tool_name,
        args: (approval.args ?? {}) as Record<string, unknown>,
        completed: true,
        completedAtMs: Date.now(),
        error: 'Declined'
      }
      this.emit(run, [{ type: 'tool.completed', messageId, toolCall: declined }])
    }
    this.handlers[run.kind]?.approvalDecided?.(run, approval)
    if (run.status !== 'waiting' || !run.pending) return
    const decided = new Set(agentStore.approvalsForRun(run.id).filter((a) => a.status !== 'pending').map((a) => a.tool_call_id))
    if (run.pending.waiting.every((c) => decided.has(c.id))) {
      agentStore.updateRun(run.id, { status: 'queued' })
      this.host?.start(run.id)
    }
  }

  /** Runs interrupted by quitting can't continue: fail them. Runs waiting for approval stay resumable. */
  recover(): void {
    for (const run of this.deps.agentStore.activeRuns()) {
      if (run.status === 'waiting') continue
      this.finishRun(run, { status: 'failed', error: 'Cereal was closed before this finished.' })
    }
  }

  /** Fail a run the runtime was executing when the agent process died. */
  failIfRunning(runId: string, error: string): void {
    const run = this.deps.agentStore.getRun(runId)
    if (run && (run.status === 'running' || run.status === 'queued')) this.finishRun(run, { status: 'failed', error })
  }

  // ------------------------------------------------------ runtime actions

  claim(runId: string): RunSpec | null {
    const { agentStore, settings } = this.deps
    const run = agentStore.getRun(runId)
    if (!run || run.status !== 'queued') return null
    const handler = this.handlers[run.kind]
    try {
      if (!handler) throw new Error(`No handler for ${run.kind} runs`)
      const llm = run.kind === 'chat' ? chatProviderConfig(settings, run.llm) : providerConfig(settings)
      const maxInputChars = createProviderFromConfig(llm).maxInputChars
      const { system, tools, maxSteps } = handler.prepare(run, maxInputChars)
      let resume: RunSpec['resume'] = null
      if (run.pending) {
        const decisions: Record<string, 'approved' | 'denied'> = {}
        for (const a of agentStore.approvalsForRun(run.id)) if (a.status !== 'pending') decisions[a.tool_call_id] = a.status
        resume = { pending: run.pending, decisions }
      }
      const claimed = agentStore.updateRun(runId, { status: 'running', started_at: run.started_at ?? new Date().toISOString(), pending: null })
      this.emit(claimed, [{ type: 'run.status', status: 'running' }])
      const transcript = agentStore.transcript(run.thread_id)
      return { run: claimed, llm, system, tools: tools.map(toolSpec), transcript, maxSteps, resume, uploads: this.uploadsFor(transcript) }
    } catch (e) {
      this.finishRun(run, { status: 'failed', error: describeLlmError(e) })
      return null
    }
  }

  appendTranscript(runId: string, messages: ModelMessage[]): void {
    const run = this.deps.agentStore.getRun(runId)
    if (run) this.deps.agentStore.appendTranscript(run.thread_id, messages)
  }

  startEpoch(runId: string, messages: ModelMessage[]): void {
    const run = this.deps.agentStore.getRun(runId)
    if (run) this.deps.agentStore.startEpoch(run.thread_id, messages)
  }

  events(runId: string, events: AgentEvent[]): void {
    const run = this.deps.agentStore.getRun(runId)
    if (!run) return
    for (const e of events) {
      if (e.type !== 'model.usage' || !e.provider) continue
      const { provider, model, purpose, ...usage } = e
      this.recordUsage(llmUsageEvent({ provider, model, usage }, purpose ?? run.kind, { thread_id: run.thread_id, run_id: run.id }))
    }
    this.emit(run, events)
  }

  /** Record API usage (a no-op when nothing records it); never throws. */
  recordUsage(e: NewUsageEvent): void {
    recordSafely(this.deps.recordUsage, e)
  }

  suspend(runId: string, pending: PendingStep): void {
    const run = this.deps.agentStore.getRun(runId)
    if (!run) return
    const waiting = this.deps.agentStore.updateRun(runId, { status: 'waiting', pending })
    this.emit(waiting, [{ type: 'run.status', status: 'waiting' }])
    this.flushChat(waiting)
  }

  finish(runId: string, outcome: RunOutcome): void {
    const run = this.deps.agentStore.getRun(runId)
    if (run && !isTerminal(run.status)) this.finishRun(run, outcome)
  }

  /** Validate and run one tool call, or hold it for the user's approval. */
  async callTool(runId: string, call: ToolCall, approved = false): Promise<ToolCallReply> {
    const { agentStore, settings } = this.deps
    const run = agentStore.getRun(runId)
    if (!run) return { kind: 'result', content: 'The run no longer exists.', isError: true }
    const messageId = run.message_id ?? ''
    const tool = findTool(call.name, run.context)
    const output: ToolCallOutput = {
      type: 'tool_call',
      id: call.id,
      name: call.name,
      label: tool?.label.active ?? call.name,
      args: (call.args && typeof call.args === 'object' ? call.args : {}) as Record<string, unknown>,
      startedAtMs: Date.now(),
      ...(tool?.affects ? { affects: tool.affects } : {})
    }
    const done = (patch: Partial<ToolCallOutput>, reply: ToolCallReply): ToolCallReply => {
      this.emit(run, [{ type: 'tool.completed', messageId, toolCall: { ...output, label: tool?.label.done ?? call.name, completed: true, completedAtMs: Date.now(), ...patch } }])
      return reply
    }
    if (!tool) {
      this.emit(run, [{ type: 'tool.started', messageId, toolCall: output }])
      const content = `There is no tool called ${call.name} here.`
      return done({ error: content }, { kind: 'result', content, isError: true })
    }
    const parsed = parseArgs(tool, call.args)
    if (parsed.ok) output.args = parsed.value as Record<string, unknown>
    this.emit(run, [{ type: 'tool.started', messageId, toolCall: output }])
    if (!parsed.ok) return done({ error: parsed.message }, { kind: 'result', content: parsed.message, isError: true })

    if (!approved && policyFor(tool, parsed.value) === 'ask' && !settings.get().assistant.alwaysAllow.includes(tool.name)) {
      const described = tool.approval?.(parsed.value) ?? { label: tool.label.active }
      const approval = agentStore.createApproval({ runId, messageId: run.message_id, toolCallId: call.id, toolName: tool.name, args: parsed.value, label: described.label, detail: described.detail ?? null })
      this.emit(run, [{ type: 'approval.requested', messageId, toolCallId: call.id, approval: { id: approval.id, status: 'pending' }, label: approval.label, detail: approval.detail }])
      this.handlers[run.kind]?.approvalRequested?.(run, approval)
      return { kind: 'approval_required', approvalId: approval.id }
    }

    try {
      const r = await tool.execute(parsed.value, this.env(run))
      return done(
        { result: r.data, ...(r.isError ? { error: r.content } : {}), ...(tool.clientApplied && !r.isError ? { applied: null } : {}) },
        { kind: 'result', content: r.content, isError: r.isError }
      )
    } catch (e) {
      const content = e instanceof Error ? e.message : String(e)
      return done({ error: content }, { kind: 'result', content, isError: true })
    }
  }

  // ------------------------------------------------------------ attachments

  /** The cached provider uploads of every attachment a transcript refers to. */
  private uploadsFor(transcript: ModelMessage[]): RunSpec['uploads'] {
    const out: RunSpec['uploads'] = {}
    for (const m of transcript) {
      if (m.role !== 'user') continue
      for (const a of m.attachments ?? []) {
        const rows = this.deps.store.uploads(a.id)
        out[a.id] = Object.fromEntries(Object.entries(rows).map(([provider, r]) => [provider, { remoteId: r.remoteId, uri: r.uri, expiresAt: r.expiresAt }]))
      }
    }
    return out
  }

  private attachmentOf(runId: string, attachmentId: string): void {
    const run = this.deps.agentStore.getRun(runId)
    const a = this.deps.store.getAttachment(attachmentId)
    // A run reads only files that belong to its own thread.
    if (!run || !a || a.thread_id !== run.thread_id) throw new Error('That attachment is not part of this chat.')
  }

  async attachmentBytes(runId: string, attachmentId: string): Promise<Uint8Array> {
    this.attachmentOf(runId, attachmentId)
    if (!this.deps.attachments) throw new Error('Attachments are not available.')
    return new Uint8Array(await this.deps.attachments.readOriginal(attachmentId))
  }

  async attachmentText(runId: string, attachmentId: string): Promise<string> {
    this.attachmentOf(runId, attachmentId)
    return this.deps.attachments ? this.deps.attachments.readText(attachmentId) : ''
  }

  recordUpload(runId: string, attachmentId: string, provider: LlmProviderId, remote: RemoteFile): void {
    this.attachmentOf(runId, attachmentId)
    this.deps.store.recordUpload(attachmentId, provider, remote)
  }

  // ------------------------------------------------------------ internals

  private env(run: AgentRun): ToolEnv {
    const { store, agentStore, files, settings } = this.deps
    return {
      store,
      agentStore,
      files,
      settings: settings.get(),
      run,
      documentId: run.kind === 'chat' ? (store.getThread(run.thread_id)?.document_id ?? null) : null,
      calendarBetween: (from, to) => store.calendarEventsBetween(from, to),
      rewriteNotes: (documentId, instructions) => this.deps.rewriteNotes(documentId, instructions),
      assistant: this.assistantOps ?? NO_ASSISTANT,
      emit: (e) => this.emit(run, [e])
    }
  }

  private currentOutputs(run: AgentRun): AgentOutput[] {
    const live = this.live.get(run.id)
    if (live) return live.outputs
    if (!run.message_id) return []
    return (run.kind === 'chat' ? this.deps.store.getMessage(run.message_id)?.outputs : this.deps.agentStore.getMessage(run.message_id)?.outputs) ?? []
  }

  /** Fold events into the run's message, persist it, and broadcast (Assistant runs also keep the event log). */
  private emit(run: AgentRun, events: AgentEvent[]): void {
    if (!events.length) return
    let state = this.live.get(run.id)
    if (!state) {
      state = { outputs: this.currentOutputs(run), flushTimer: null, lastFlush: 0 }
      this.live.set(run.id, state)
    }
    for (const e of events) state.outputs = applyAgentEvent(state.outputs, e)
    // The message can be gone if its thread was deleted mid-run.
    if (!run.message_id || !(run.kind === 'chat' ? this.deps.store.getMessage(run.message_id) : this.deps.agentStore.getMessage(run.message_id))) return
    if (run.kind === 'assistant') {
      const records = this.deps.agentStore.appendEvents(run.id, events)
      const last = records[records.length - 1]
      this.deps.agentStore.updateMessage(run.message_id, { outputs: state.outputs, text: outputsText(state.outputs), ...(last ? { applied_sequence: last.sequence } : {}) })
      for (const r of records) this.deps.emitAgentEvent(r)
    } else {
      this.deps.store.updateMessage(run.message_id, { outputs: state.outputs, content: outputsText(state.outputs) })
      const s = state
      const wait = CHAT_FLUSH_MS - (Date.now() - s.lastFlush)
      if (wait <= 0) this.flushChat(run)
      else s.flushTimer ??= setTimeout(() => this.flushChat(run), wait)
    }
  }

  private flushChat(run: AgentRun): void {
    if (run.kind !== 'chat' || !run.message_id) return
    const state = this.live.get(run.id)
    if (state) {
      if (state.flushTimer) clearTimeout(state.flushTimer)
      state.flushTimer = null
      state.lastFlush = Date.now()
    }
    const message = this.deps.store.getMessage(run.message_id)
    if (message) this.deps.emitChatMessage(message)
  }

  private finishRun(run: AgentRun, outcome: RunOutcome): void {
    const { agentStore, store } = this.deps
    // Anything still waiting for approval is declined.
    for (const a of agentStore.approvalsForRun(run.id)) {
      if (a.status !== 'pending') continue
      const denied = agentStore.decideApproval(a.id, 'denied')
      this.emit(run, [{ type: 'approval.decided', messageId: run.message_id ?? '', toolCallId: a.tool_call_id, approval: { id: a.id, status: 'denied' } }])
      this.handlers[run.kind]?.approvalDecided?.(run, denied)
    }
    const status = outcome.status
    const error = outcome.status === 'failed' ? outcome.error : null
    this.emit(run, [{ type: 'run.status', status, ...(error ? { error } : {}) }])
    const finished = agentStore.updateRun(run.id, { status, error, pending: null, finished_at: new Date().toISOString() })

    // Tool calls that never completed are marked as stopped.
    const outputs = this.currentOutputs(run).map((o) => (o.type === 'tool_call' && !o.completed ? { ...o, completed: true, error: o.error ?? 'Stopped' } : o))
    const text = outputsText(outputs)
    const empty = !text && !outputs.some((o) => o.type === 'tool_call')
    const messageStatus = status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'error'
    const messageError = error ?? (status === 'completed' && empty ? 'No response from the model.' : null)
    const exists = !!run.message_id && !!(run.kind === 'chat' ? store.getMessage(run.message_id) : agentStore.getMessage(run.message_id))
    if (run.message_id && exists) {
      if (run.kind === 'chat') {
        const citations = extractCitations(text, agentStore.sources(run.thread_id))
        const message = store.updateMessage(run.message_id, { outputs, content: text, citations, status: messageStatus, error: messageError })
        const state = this.live.get(run.id)
        if (state?.flushTimer) clearTimeout(state.flushTimer)
        this.deps.emitChatMessage(message)
      } else {
        this.deps.emitAgentMessage(agentStore.updateMessage(run.message_id, { outputs, text, status: messageStatus, error: messageError }))
      }
    }
    this.live.delete(run.id)
    this.handlers[run.kind]?.finished?.(finished)
  }
}
