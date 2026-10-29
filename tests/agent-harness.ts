// Test harness: the whole agent (backend, chat, Assistant) on an in-memory database, with the runtime in-process
// and a scripted model in place of a real provider.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/main/db'
import { Store } from '../src/main/db/store'
import { AgentStore } from '../src/main/db/agent-store'
import { UsageStore } from '../src/main/db/usage-store'
import { AgentFiles } from '../src/main/agent/files'
import { AgentBackend } from '../src/main/agent/backend'
import { ChatAgent } from '../src/main/agent/chat'
import { Assistant } from '../src/main/agent/assistant'
import { InProcessHost } from '../src/main/agent/host'
import { AttachmentService } from '../src/main/attachments/service'
import { deepMerge } from '../src/main/settings.pure'
import type { GenerateOptions, LlmProvider, ModelBlock, ModelMessage, ProviderConfig, StepOptions, StepResult } from '../src/main/llm/provider'
import type { DeepPartial } from '@shared/ipc'
import type { AgentEventRecord, AgentHome, AgentMessage, AgentThread } from '@shared/agent'
import type { ChatAttachment, ChatMessage, Panel, Settings } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

/** What the scripted model does on one step: stream text/reasoning and/or call tools. */
export interface ScriptStep {
  text?: string
  reasoning?: string
  calls?: { name: string; args: unknown }[]
  /** Wait for this before answering (to test stopping mid-step). */
  until?: Promise<void>
}

export interface RecordedStep {
  system: string
  messages: ModelMessage[]
  tools: string[]
  /** What the model could read of the last user turn's attachments, through FileAccess. */
  files?: { name: string; text: string; bytes: number }[]
}

export class ScriptedProvider implements LlmProvider {
  readonly id = 'anthropic' as const
  steps: RecordedStep[] = []
  generated: GenerateOptions[] = []
  private callCount = 0

  constructor(
    private readonly script: (opts: StepOptions, index: number) => ScriptStep,
    readonly maxInputChars = 1_000_000
  ) {}

  async generate(opts: GenerateOptions): Promise<string> {
    this.generated.push(opts)
    opts.onUsage?.({ provider: 'anthropic', model: 'scripted-fast', usage: { inputTokens: 100, outputTokens: 20 } })
    return '- summary of earlier turns'
  }

  async step(opts: StepOptions): Promise<StepResult> {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')
    const refs = lastUser?.role === 'user' ? (lastUser.attachments ?? []) : []
    const files = opts.files ? await Promise.all(refs.map(async (r) => ({ name: r.name, text: await opts.files!.text(r), bytes: (await opts.files!.bytes(r)).byteLength }))) : []
    this.steps.push({ system: opts.system, messages: structuredClone(opts.messages), tools: opts.tools.map((t) => t.name), files })
    const s = this.script(opts, this.steps.length - 1)
    if (s.until) {
      await Promise.race([
        s.until,
        new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
      ])
    }
    const blocks: ModelBlock[] = []
    if (s.reasoning) {
      opts.onReasoning?.(s.reasoning)
      blocks.push({ type: 'reasoning', text: s.reasoning })
    }
    if (s.text) {
      for (const part of s.text.match(/.{1,6}/gs) ?? []) opts.onText?.(part)
      blocks.push({ type: 'text', text: s.text })
    }
    for (const c of s.calls ?? []) blocks.push({ type: 'tool_call', id: `call_${++this.callCount}`, name: c.name, args: c.args })
    opts.onUsage?.({ provider: 'anthropic', model: 'scripted', usage: { inputTokens: 10, outputTokens: 5 } })
    return { blocks, stopReason: s.calls?.length ? 'tool_use' : 'end_turn', model: 'scripted', usage: { inputTokens: 10, outputTokens: 5 } }
  }

  async listModels(): Promise<string[]> {
    return []
  }
}

/** The last tool results the model was shown, by tool name. */
export function lastToolResults(step: RecordedStep): Record<string, string> {
  const last = [...step.messages].reverse().find((m) => m.role === 'tool')
  return last && last.role === 'tool' ? Object.fromEntries(last.results.map((r) => [r.name, r.content])) : {}
}

export function makeAgent(script: (opts: StepOptions, index: number) => ScriptStep, opts: { maxInputChars?: number; settings?: DeepPartial<Settings> } = {}) {
  const db = openDatabase(':memory:')
  const store = new Store(db)
  const agentStore = new AgentStore(db)
  const usage = new UsageStore(db)
  const files = new AgentFiles(mkdtempSync(join(tmpdir(), 'cereal-agent-')))
  let current: Settings = deepMerge(DEFAULT_SETTINGS, opts.settings ?? {})
  const settings = {
    get: () => current,
    update: (patch: DeepPartial<Settings>) => (current = deepMerge(current, patch)),
    getSecret: () => 'test-key',
    envFile: '/tmp/.env'
  }
  const provider = new ScriptedProvider(script, opts.maxInputChars)
  const chatMessages: ChatMessage[] = []
  const agentMessages: AgentMessage[] = []
  const threads: AgentThread[] = []
  const events: AgentEventRecord[] = []
  const homes: (AgentHome | null)[] = []
  const notifications: { title: string; body: string; route: string }[] = []
  const rewrites: { documentId: string; instructions: string }[] = []
  const attachmentEvents: ChatAttachment[] = []
  const remoteDeletes: { provider: string; remoteId: string }[] = []
  const attachments = new AttachmentService(store, mkdtempSync(join(tmpdir(), 'cereal-attachments-')), (a) => attachmentEvents.push(a), async (provider, remoteId) => {
    remoteDeletes.push({ provider, remoteId })
  })
  /** The provider configs runs were started with (the chat's model choice). */
  const configs: ProviderConfig[] = []
  const backend = new AgentBackend({
    store,
    agentStore,
    files,
    settings: settings as never,
    attachments,
    rewriteNotes: (documentId, instructions) => {
      rewrites.push({ documentId, instructions })
      return store.createPanel(documentId, 'Summary', 'auto') as Panel
    },
    emitChatMessage: (m) => chatMessages.push(m),
    emitAgentMessage: (m) => agentMessages.push(m),
    emitAgentEvent: (r) => events.push(r),
    recordUsage: (e) => usage.record(e)
  })
  const host = new InProcessHost(backend, (config) => {
    configs.push(config)
    return provider
  })
  backend.host = host
  const chatThreads: { id: string; title: string }[] = []
  const chat = new ChatAgent({
    store,
    agentStore,
    backend,
    settings: settings as never,
    files,
    attachments,
    emitMessage: (m) => chatMessages.push(m),
    emitThread: (t) => chatThreads.push({ id: t.id, title: t.title }),
    createProvider: () => provider
  })
  const assistant = new Assistant({
    store,
    agentStore,
    backend,
    settings: settings as never,
    files,
    emitMessage: (m) => agentMessages.push(m),
    emitThread: (t) => threads.push(t),
    emitHome: (h) => homes.push(h),
    emitRoutines: () => undefined,
    notify: (title, body, route) => notifications.push({ title, body, route }),
    isFocused: () => false
  })
  /** Let every started run (and the runs they start) finish or suspend. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) {
      await host.idle()
      await new Promise((r) => setImmediate(r))
      if (!agentStore.activeRuns().some((r) => r.status === 'queued' || r.status === 'running')) {
        await host.idle()
        return
      }
    }
  }
  return {
    store,
    agentStore,
    usage,
    files,
    settings,
    provider,
    backend,
    host,
    chat,
    assistant,
    attachments,
    attachmentEvents,
    remoteDeletes,
    configs,
    chatThreads,
    chatMessages,
    agentMessages,
    threads,
    events,
    homes,
    notifications,
    rewrites,
    settle
  }
}
