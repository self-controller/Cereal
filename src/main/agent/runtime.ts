import type { AgentEvent } from '@shared/agent'
import { describeLlmError } from '../llm'
import { modelMessageChars, type FileAccess, type LlmProvider, type ModelMessage, type ProviderConfig, type ToolResultMessage, type UsageReport } from '../llm/provider'
import type { BackendApi, RunSpec, ToolCall } from './protocol'
import { COMPACT_SYSTEM_PROMPT } from './prompts'

const STEP_LIMIT_NOTE = "You've reached the step limit for this turn. Answer now with what you have; don't call more tools."

/** Coalesces streamed deltas and sends events in small ordered batches (Keto's `events` action takes up to 20). */
class EventBatcher {
  private queue: AgentEvent[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly send: (events: AgentEvent[]) => Promise<void>) {}

  push(e: AgentEvent): void {
    const last = this.queue[this.queue.length - 1]
    if (last && (e.type === 'message.delta' || e.type === 'reasoning.delta') && last.type === e.type && last.messageId === e.messageId) {
      this.queue[this.queue.length - 1] = { ...last, delta: last.delta + e.delta }
    } else {
      this.queue.push(e)
    }
    if (this.queue.length >= 20) void this.flush()
    else this.timer ??= setTimeout(() => void this.flush(), 100)
  }

  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const batch = this.queue.splice(0)
    if (batch.length) this.chain = this.chain.then(() => this.send(batch))
    return this.chain
  }
}

/** Attachment access for one run: bytes and text from the backend, uploads cached in the run's spec and saved back. */
function fileAccess(backend: BackendApi, spec: RunSpec): FileAccess {
  const uploads = spec.uploads
  return {
    bytes: (ref) => backend.attachmentBytes(spec.run.id, ref.id),
    text: (ref) => backend.attachmentText(spec.run.id, ref.id),
    remote: (ref, provider) => {
      const r = uploads[ref.id]?.[provider]
      // Treat a file about to expire as gone, so the request doesn't race its deletion.
      if (!r || (r.expiresAt && Date.parse(r.expiresAt) < Date.now() + 5 * 60 * 1000)) return null
      return r
    },
    remember: async (ref, provider, remote) => {
      uploads[ref.id] = { ...uploads[ref.id], [provider]: remote }
      await backend.recordUpload(spec.run.id, ref.id, provider, remote)
    }
  }
}

/**
 * The agent loop: model step → run the tool calls (in parallel) → append their results → repeat, until the model
 * answers without tools. Everything is persisted through the backend as it happens, so a run that waits for approval
 * resumes later from the transcript, even after a restart.
 */
export class AgentRuntime {
  private running = new Map<string, AbortController>()

  constructor(
    private readonly backend: BackendApi,
    private readonly createProvider: (config: ProviderConfig) => LlmProvider
  ) {}

  start(runId: string): void {
    void this.execute(runId)
  }

  cancel(runId: string): void {
    this.running.get(runId)?.abort()
  }

  get activeRunIds(): string[] {
    return [...this.running.keys()]
  }

  /** Run to completion (or suspension). Resolves when the run has been finished or suspended. */
  async execute(runId: string): Promise<void> {
    const spec = await this.backend.claim(runId)
    if (!spec) return
    const abort = new AbortController()
    this.running.set(runId, abort)
    const batcher = new EventBatcher((events) => this.backend.events(runId, events))
    const messageId = spec.run.message_id ?? ''
    // Every request's usage goes to main as an event, including requests that fail or are stopped.
    const usage =
      (purpose?: 'compaction') =>
      (r: UsageReport): void =>
        batcher.push({ type: 'model.usage', provider: r.provider, model: r.model, ...(purpose ? { purpose } : {}), ...r.usage })
    // Tool calls whose results aren't in the transcript yet; answered with an error if the run stops early, so the
    // transcript never ends on calls without results.
    let unanswered: ToolCall[] = []
    try {
      const provider = this.createProvider(spec.llm)
      const files = fileAccess(this.backend, { ...spec, uploads: spec.uploads ?? {} })
      let messages = spec.transcript

      if (spec.resume) {
        const results: ToolResultMessage[] = [...spec.resume.pending.results]
        unanswered = spec.resume.pending.waiting
        for (const call of spec.resume.pending.waiting) {
          if (spec.resume.decisions[call.id] === 'approved') {
            const reply = await this.backend.callTool(runId, call, true)
            results.push({ id: call.id, name: call.name, content: reply.kind === 'result' ? reply.content : 'Not run.', isError: reply.kind === 'result' ? reply.isError : true })
          } else {
            results.push({ id: call.id, name: call.name, content: 'The user declined this action. Do not try it again; explain or ask instead.', isError: true })
          }
        }
        messages = await this.append(runId, messages, { role: 'tool', results })
        unanswered = []
      }

      // Past ~60% of the model's input budget, older turns are summarised into a new epoch.
      messages = await this.compact(runId, provider, messages, Math.floor(provider.maxInputChars * 0.6), abort.signal, usage('compaction'))

      for (let step = 0; step < spec.maxSteps; step++) {
        const result = await provider.step({
          system: spec.system,
          messages,
          tools: spec.tools,
          tier: 'quality',
          signal: abort.signal,
          files,
          onText: (delta) => batcher.push({ type: 'message.delta', messageId, delta }),
          onReasoning: (delta) => batcher.push({ type: 'reasoning.delta', messageId, delta }),
          onUsage: usage()
        })
        await batcher.flush()
        if (result.stopReason === 'refusal') throw new Error(result.refusal ?? 'The model declined this request.')

        messages = await this.append(runId, messages, { role: 'assistant', blocks: result.blocks, replay: result.replay })
        const calls: ToolCall[] = result.blocks.flatMap((b) => (b.type === 'tool_call' ? [{ id: b.id, name: b.name, args: b.args }] : []))
        if (result.stopReason === 'pause' && !calls.length) continue
        if (!calls.length) break
        unanswered = calls
        // A tool input cut off at max_tokens can parse as a valid but partial object: never run it.
        if (result.stopReason === 'max_tokens') throw new Error('The reply was cut off before the model finished calling a tool. Try asking for less at once.')
        if (step === spec.maxSteps - 1) {
          messages = await this.append(runId, messages, { role: 'tool', results: calls.map((c) => ({ id: c.id, name: c.name, content: 'Not run: step limit reached.', isError: true })) })
          unanswered = []
          batcher.push({ type: 'message.delta', messageId, delta: '\n\n(Stopped after reaching the step limit.)' })
          break
        }

        const replies = await Promise.all(calls.map((c) => this.backend.callTool(runId, c)))
        if (abort.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const results: ToolResultMessage[] = []
        const waiting: ToolCall[] = []
        replies.forEach((r, i) => {
          if (r.kind === 'result') results.push({ id: calls[i].id, name: calls[i].name, content: r.content, isError: r.isError })
          else waiting.push(calls[i])
        })
        if (waiting.length) {
          await batcher.flush()
          await this.backend.suspend(runId, { results, waiting })
          return
        }
        messages = await this.append(runId, messages, { role: 'tool', results, ...(step === spec.maxSteps - 2 ? { note: STEP_LIMIT_NOTE } : {}) })
        unanswered = []
      }
      await batcher.flush()
      await this.backend.finish(runId, { status: 'completed' })
    } catch (e) {
      await batcher.flush().catch(() => undefined)
      if (unanswered.length) {
        const why = abort.signal.aborted ? 'Stopped by the user.' : 'Not run: the turn ended early.'
        await this.backend.appendTranscript(runId, [{ role: 'tool', results: unanswered.map((c) => ({ id: c.id, name: c.name, content: why, isError: true })) }]).catch(() => undefined)
      }
      await this.backend.finish(runId, abort.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: describeLlmError(e) }).catch(() => undefined)
    } finally {
      this.running.delete(runId)
    }
  }

  private async append(runId: string, messages: ModelMessage[], m: ModelMessage): Promise<ModelMessage[]> {
    await this.backend.appendTranscript(runId, [m])
    return [...messages, m]
  }

  /**
   * Keep the transcript within budget: summarise everything before a recent user turn into a new epoch. The kept turns
   * lose their provider replay (thinking blocks are only valid after the exact history that produced them).
   */
  private async compact(runId: string, provider: LlmProvider, messages: ModelMessage[], budget: number, signal: AbortSignal, onUsage: (r: UsageReport) => void): Promise<ModelMessage[]> {
    const total = messages.reduce((n, m) => n + modelMessageChars(m), 0)
    if (total <= budget) return messages
    let keepFrom = messages.length
    let kept = 0
    for (let i = messages.length - 1; i > 0; i--) {
      kept += modelMessageChars(messages[i])
      if (messages[i].role === 'user') {
        if (kept > budget / 2 && keepFrom < messages.length) break
        keepFrom = i
      }
    }
    if (keepFrom <= 0 || keepFrom >= messages.length) return messages
    const older = messages
      .slice(0, keepFrom)
      .map((m) =>
        m.role === 'user'
          ? `User: ${m.content}${m.attachments?.length ? ` [attached: ${m.attachments.map((a) => a.name).join(', ')}]` : ''}`
          : m.role === 'assistant'
            ? `Assistant: ${m.blocks.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_call' ? `[called ${b.name} ${JSON.stringify(b.args).slice(0, 300)}]` : '')).join(' ')}`
            : `Tool results: ${m.results.map((r) => `${r.name}: ${r.content.slice(0, 1500)}`).join('\n')}`
      )
      .join('\n\n')
      .slice(-Math.floor(provider.maxInputChars * 0.8))
    const summary = await provider.generate({ tier: 'fast', system: COMPACT_SYSTEM_PROMPT, messages: [{ role: 'user', content: older }], maxTokens: 4_000, signal, onUsage })
    const next: ModelMessage[] = [
      { role: 'user', content: `(Summary of the earlier conversation, which is no longer shown.)\n${summary.trim()}` },
      ...messages.slice(keepFrom).map((m) => (m.role === 'assistant' ? { role: 'assistant' as const, blocks: m.blocks } : m))
    ]
    await this.backend.startEpoch(runId, next)
    return next
  }
}
