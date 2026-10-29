// The contract between the agent runtime (the model/tool loop, in the agent utility process) and the backend (main:
// SQLite, tools, broadcasting). It mirrors the action protocol Granola's Keto workers use with their backend:
// claim a run, append to the model transcript, execute a tool, report events, suspend on approvals, finish.
import type { AgentEvent } from '@shared/agent'
import type { AgentRun, PendingStep } from '../db/agent-store'
import type { LlmProviderId } from '@shared/types'
import type { ModelMessage, ProviderConfig, RemoteFile, ToolSpec } from '../llm/provider'

export interface RunSpec {
  run: AgentRun
  llm: ProviderConfig
  system: string
  tools: ToolSpec[]
  /** The thread's model transcript (current epoch), including this run's input. */
  transcript: ModelMessage[]
  maxSteps: number
  /** Set when the run resumes a step that waited for approvals. */
  resume: { pending: PendingStep; decisions: Record<string, 'approved' | 'denied'> } | null
  /** Provider-side copies of the transcript's attachments, by attachment id and provider. */
  uploads: Record<string, Partial<Record<LlmProviderId, RemoteFile>>>
}

export interface ToolCall {
  id: string
  name: string
  args: unknown
}

export type ToolCallReply = { kind: 'result'; content: string; isError?: boolean } | { kind: 'approval_required'; approvalId: string }

export type RunOutcome = { status: 'completed' } | { status: 'failed'; error: string } | { status: 'cancelled' }

/** Backend actions the runtime calls. Every call is async because it may cross a process boundary. */
export interface BackendApi {
  claim(runId: string): Promise<RunSpec | null>
  appendTranscript(runId: string, messages: ModelMessage[]): Promise<void>
  startEpoch(runId: string, messages: ModelMessage[]): Promise<void>
  callTool(runId: string, call: ToolCall, approved?: boolean): Promise<ToolCallReply>
  events(runId: string, events: AgentEvent[]): Promise<void>
  suspend(runId: string, pending: PendingStep): Promise<void>
  finish(runId: string, outcome: RunOutcome): Promise<void>
  /** An attachment's file, as the provider should receive it. */
  attachmentBytes(runId: string, attachmentId: string): Promise<Uint8Array>
  /** The text extracted from an attachment. */
  attachmentText(runId: string, attachmentId: string): Promise<string>
  /** Remember a provider's upload of an attachment so later turns reuse it. */
  recordUpload(runId: string, attachmentId: string, provider: LlmProviderId, remote: RemoteFile): Promise<void>
}

export type BackendMethod = keyof BackendApi

/** Messages from main to the worker. */
export type ToWorker = { type: 'run'; runId: string } | { type: 'cancel'; runId: string } | { type: 'reply'; id: number; result?: unknown; error?: string }

/** Messages from the worker to main. */
export type FromWorker = { type: 'ready' } | { type: 'call'; id: number; method: BackendMethod; args: unknown[] }
