import type { LlmProviderId } from '@shared/types'
import type { AttachmentKind } from '@shared/attachments'

export interface LlmMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface GenerateOptions {
  system: string
  messages: LlmMessage[]
  /** 'quality' for notes and chat, 'fast' for titles and condensing. */
  tier: 'quality' | 'fast'
  maxTokens?: number
  signal?: AbortSignal
  /** Called with each streamed text delta. */
  onText?: (delta: string) => void
  onUsage?: (report: UsageReport) => void
}

// ---------------------------------------------------------------- tool calling

/** A tool the model may call. `parameters` is a JSON Schema object. */
export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type ModelBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }

/** Provider-native assistant content, replayed unchanged on the next request (thinking blocks must round-trip). */
export interface ProviderReplay {
  provider: LlmProviderId
  content: unknown
}

/** A file a user turn carries. The bytes stay on disk; providers read them through `FileAccess` when they need them. */
export interface AttachmentRef {
  id: string
  name: string
  mime: string
  kind: AttachmentKind
  size: number
  pages?: number | null
  /** Length of the extracted text. */
  textChars?: number
}

/** A provider-side copy of an attachment (an Anthropic or OpenAI file id, or a Gemini file name and URI). */
export interface RemoteFile {
  remoteId: string
  uri?: string | null
  /** When the provider deletes it (Gemini keeps files for 48 hours); null when it keeps it until asked. */
  expiresAt?: string | null
}

/** How a provider reaches a turn's attachments: their bytes, their extracted text, and its own uploads of them. */
export interface FileAccess {
  bytes(ref: AttachmentRef): Promise<Uint8Array>
  text(ref: AttachmentRef): Promise<string>
  /** This provider's upload of the file, if it has one that hasn't expired. */
  remote(ref: AttachmentRef, provider: LlmProviderId): RemoteFile | null
  remember(ref: AttachmentRef, provider: LlmProviderId, remote: RemoteFile): Promise<void>
}

/** A provider-neutral conversation turn, as stored in the append-only model transcript. */
export type ModelMessage =
  | { role: 'user'; content: string; attachments?: AttachmentRef[]; /** The chat message this turn came from (edit and resend). */ messageId?: string }
  | { role: 'assistant'; blocks: ModelBlock[]; replay?: ProviderReplay }
  | { role: 'tool'; results: ToolResultMessage[]; note?: string }

export interface ToolResultMessage {
  id: string
  name: string
  content: string
  isError?: boolean
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal' | 'pause' | 'other'

/** Token counts of one request, with the same meaning for every provider. */
export interface StepUsage {
  /** Uncached input: providers that count cache hits as input have them taken out. */
  inputTokens?: number
  /** Output, reasoning included. */
  outputTokens?: number
  cacheReadTokens?: number
  /** Written to the prompt cache (5-minute writes, the only kind Cereal makes). */
  cacheWriteTokens?: number
}

/**
 * What one API request used, reported once per request through `onUsage`. A request that fails or is stopped
 * part-way reports what the provider had counted by then (Anthropic streams it; the others only report at the end).
 */
export interface UsageReport {
  provider: LlmProviderId
  /** The model id requested, not the response's dated snapshot, so it matches the price table. */
  model: string
  usage: StepUsage
}

/** Report usage if the request got far enough to count any. */
export function reportUsage(onUsage: ((r: UsageReport) => void) | undefined, provider: LlmProviderId, model: string, usage: StepUsage): void {
  if (onUsage && Object.values(usage).some((n) => n !== undefined)) onUsage({ provider, model, usage })
}

export interface StepOptions {
  system: string
  messages: ModelMessage[]
  tools: ToolSpec[]
  tier: 'quality' | 'fast'
  maxTokens?: number
  signal?: AbortSignal
  onText?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onUsage?: (report: UsageReport) => void
  /** Needed when user turns carry attachments; without it a provider names the files instead of sending them. */
  files?: FileAccess
}

export interface StepResult {
  blocks: ModelBlock[]
  stopReason: StopReason
  model: string
  usage: StepUsage
  replay?: ProviderReplay
  /** Set when the provider declined the request (e.g. a refusal). */
  refusal?: string
}

export interface LlmProvider {
  readonly id: LlmProviderId
  /** Rough input budget in characters before content must be condensed. */
  readonly maxInputChars: number
  generate(opts: GenerateOptions): Promise<string>
  /** One model turn with tools: streams text and reasoning, returns the blocks (including tool calls) it produced. */
  step(opts: StepOptions): Promise<StepResult>
  listModels(): Promise<string[]>
  /** Delete this provider's copy of an uploaded file. */
  deleteFile?(remoteId: string): Promise<void>
}

export class LlmConfigError extends Error {}

/** Everything needed to build a provider without the settings service (the agent worker gets this from main). */
export interface ProviderConfig {
  provider: LlmProviderId
  apiKey: string | null
  model: string
  fastModel: string
  ollamaUrl: string
  baseURL?: string
}

/** Rough size of a transcript, used to decide when to compact it. */
export function modelMessageChars(m: ModelMessage): number {
  if (m.role === 'user') return m.content.length + (m.attachments ?? []).reduce((n, a) => n + (a.kind === 'image' ? 4_000 : (a.textChars ?? a.size)), 0)
  if (m.role === 'tool') return m.results.reduce((n, r) => n + r.content.length, 0) + (m.note?.length ?? 0)
  return m.blocks.reduce((n, b) => n + (b.type === 'tool_call' ? JSON.stringify(b.args ?? {}).length + b.name.length : b.text.length), 0)
}
