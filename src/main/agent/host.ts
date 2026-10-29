import { createProviderFromConfig } from '../llm'
import type { LlmProvider, ProviderConfig } from '../llm/provider'
import type { AgentBackend, AgentHost } from './backend'
import type { BackendApi, BackendMethod } from './protocol'
import { AgentRuntime } from './runtime'

const METHODS: BackendMethod[] = ['claim', 'appendTranscript', 'startEpoch', 'callTool', 'events', 'suspend', 'finish', 'attachmentBytes', 'attachmentText', 'recordUpload']

/** The backend's runtime-facing actions as an async API (what the worker sees over its message port). */
export function backendApi(backend: AgentBackend): BackendApi {
  const api = {} as Record<BackendMethod, (...args: unknown[]) => Promise<unknown>>
  for (const m of METHODS) api[m] = async (...args: unknown[]) => (backend[m] as (...a: unknown[]) => unknown)(...args)
  return api as unknown as BackendApi
}

/** Runs the agent loop in this process. Used by tests (and as a fallback when the worker can't start). */
export class InProcessHost implements AgentHost {
  readonly runtime: AgentRuntime
  private pending = new Set<Promise<void>>()

  constructor(backend: AgentBackend, createProvider: (config: ProviderConfig) => LlmProvider = createProviderFromConfig) {
    this.runtime = new AgentRuntime(backendApi(backend), createProvider)
  }

  start(runId: string): void {
    // Deferred so the caller finishes its own writes before the run is claimed.
    const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.runtime.execute(runId)).finally(() => this.pending.delete(p))
    this.pending.add(p)
  }

  cancel(runId: string): void {
    this.runtime.cancel(runId)
  }

  stop(): void {}

  /** Wait for every started run to finish or suspend (tests). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending])
  }
}
