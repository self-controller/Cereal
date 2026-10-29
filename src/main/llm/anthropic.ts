import Anthropic, { toFile } from '@anthropic-ai/sdk'
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaRawMessageStreamEvent, BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { INLINE_IMAGE_MAX_BYTES, attachmentPlaceholder, base64, uploadOnce } from './files'
import { reportUsage, type AttachmentRef, type FileAccess, type GenerateOptions, type LlmProvider, type ModelBlock, type ModelMessage, type StepOptions, type StepResult, type StepUsage, type StopReason, type ToolSpec } from './provider'

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = /^claude-(opus-5|sonnet-5-5|fable-5)/
/** Models that take adaptive thinking (`thinking: {type: "adaptive"}`); older ones would reject it. */
const ADAPTIVE_MODELS = /^claude-(fable|mythos|opus-5|opus-4-[6-9]|sonnet-5|sonnet-4-6|haiku-5)/

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const
  readonly maxInputChars = 2_000_000
  private readonly client: Anthropic

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly fastModel: string,
    baseURL?: string
  ) {
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })
  }

  private fallbacks(model: string): { betas: string[]; fallbacks: 'default' } | Record<string, never> {
    return FALLBACK_MODELS.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const model = opts.tier === 'fast' ? this.fastModel : this.model
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? 16_000,
        system: opts.system,
        messages: opts.messages,
        output_config: { effort: opts.tier === 'fast' ? 'low' : 'medium' },
        ...this.fallbacks(model)
      },
      { signal: opts.signal }
    )
    let text = ''
    const usage: StepUsage = {}
    try {
      for await (const event of stream) {
        trackUsage(usage, event)
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text
          opts.onText?.(event.delta.text)
        }
      }
      const final = await stream.finalMessage()
      if (final.stop_reason === 'refusal') {
        throw new Error(`Claude declined this request${final.stop_details?.category ? ` (${final.stop_details.category})` : ''}.`)
      }
      return text
    } finally {
      reportUsage(opts.onUsage, 'anthropic', model, usage)
    }
  }

  async step(opts: StepOptions): Promise<StepResult> {
    // With eager input streaming the API no longer validates tool inputs; a turn whose input can't be parsed at all
    // is re-issued (typed API errors are never retried here).
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.stepOnce(opts)
      } catch (e) {
        if (e instanceof Anthropic.APIError || opts.signal?.aborted || attempt >= 2) throw e
      }
    }
  }

  private async stepOnce(opts: StepOptions): Promise<StepResult> {
    const model = opts.tier === 'fast' ? this.fastModel : this.model
    const stream = this.client.beta.messages.stream(
      {
        model,
        max_tokens: opts.maxTokens ?? 32_000,
        // The system prompt and tool list stay byte-stable within a thread, so the automatic breakpoint caches them.
        system: opts.system,
        messages: await toAnthropicMessages(opts.messages, opts.files ? { files: opts.files, upload: (ref, bytes) => this.upload(ref, bytes) } : undefined),
        tools: toAnthropicTools(opts.tools),
        cache_control: { type: 'ephemeral' },
        ...(ADAPTIVE_MODELS.test(model) ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
        output_config: { effort: opts.tier === 'fast' ? 'low' : 'medium' },
        ...this.fallbacks(model)
      },
      { signal: opts.signal }
    )
    // Iterating and the final read are wrapped together: with eager input streaming a tool input that can't be
    // parsed rejects whichever of them is pending. Usage is reported either way: a stopped or failed turn still bills.
    const usage: StepUsage = {}
    let final: BetaMessage
    try {
      for await (const event of stream) {
        trackUsage(usage, event)
        if (event.type !== 'content_block_delta') continue
        if (event.delta.type === 'text_delta') opts.onText?.(event.delta.text)
        else if (event.delta.type === 'thinking_delta') opts.onReasoning?.(event.delta.thinking)
      }
      final = await stream.finalMessage()
    } finally {
      reportUsage(opts.onUsage, 'anthropic', model, usage)
    }

    const blocks: ModelBlock[] = []
    for (const b of final.content) {
      if (b.type === 'text') blocks.push({ type: 'text', text: b.text })
      else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'reasoning', text: b.thinking })
      else if (b.type === 'tool_use') blocks.push({ type: 'tool_call', id: b.id, name: b.name, args: b.input })
    }
    const stopReason: StopReason =
      final.stop_reason === 'tool_use'
        ? 'tool_use'
        : final.stop_reason === 'end_turn' || final.stop_reason === 'stop_sequence'
          ? 'end_turn'
          : final.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : final.stop_reason === 'refusal'
              ? 'refusal'
              : final.stop_reason === 'pause_turn'
                ? 'pause'
                : 'other'
    return {
      blocks,
      stopReason,
      model: final.model,
      usage,
      // The whole content goes back unchanged next turn, thinking blocks included.
      replay: { provider: 'anthropic', content: final.content },
      refusal: stopReason === 'refusal' ? `Claude declined this request${final.stop_details?.category ? ` (${final.stop_details.category})` : ''}.` : undefined
    }
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    for await (const m of this.client.models.list()) ids.push(m.id)
    return ids
  }

  /** Upload to the Files API; the id is reused on later turns. */
  private async upload(ref: AttachmentRef, bytes: Uint8Array): Promise<string> {
    const uploaded = await this.client.files.upload({ file: await toFile(bytes, ref.name, { type: ref.mime }) })
    return uploaded.id
  }

  async deleteFile(remoteId: string): Promise<void> {
    await this.client.files.delete(remoteId)
  }
}

export interface AnthropicFiles {
  files: FileAccess
  upload(ref: AttachmentRef, bytes: Uint8Array): Promise<string>
}

/** A user turn's files as content blocks: images and PDFs natively (uploaded once), other files as text documents. */
async function attachmentBlocks(refs: AttachmentRef[], io: AnthropicFiles | undefined): Promise<BetaContentBlockParam[]> {
  const blocks: BetaContentBlockParam[] = []
  for (const ref of refs) {
    if (!io) {
      blocks.push({ type: 'text', text: attachmentPlaceholder(ref) })
      continue
    }
    const { files } = io
    const fileId = async (): Promise<string> => (await uploadOnce(files, ref, 'anthropic', async () => ({ remoteId: await io.upload(ref, await files.bytes(ref)) }))).remoteId
    if (ref.kind === 'image') {
      if (ref.size <= INLINE_IMAGE_MAX_BYTES) {
        const media_type = ref.mime === 'image/png' ? 'image/png' : 'image/jpeg'
        blocks.push({ type: 'image', source: { type: 'base64', media_type, data: base64(await files.bytes(ref)) } })
      } else {
        blocks.push({ type: 'image', source: { type: 'file', file_id: await fileId() } })
      }
    } else if (ref.kind === 'pdf') {
      blocks.push({ type: 'document', title: ref.name, source: { type: 'file', file_id: await fileId() } })
    } else {
      const text = await files.text(ref)
      blocks.push(text.trim() ? { type: 'document', title: ref.name, source: { type: 'text', media_type: 'text/plain', data: text } } : { type: 'text', text: attachmentPlaceholder(ref) })
    }
  }
  return blocks
}

/**
 * Keep a request's usage current as it streams: `message_start` has the input and cache counts, each `message_delta`
 * the cumulative counts so far. `input_tokens` excludes cache reads and writes, as Cereal's usage does.
 */
function trackUsage(usage: StepUsage, event: BetaRawMessageStreamEvent): void {
  const u = event.type === 'message_start' ? event.message.usage : event.type === 'message_delta' ? event.usage : null
  if (!u) return
  if (u.input_tokens != null) usage.inputTokens = u.input_tokens
  if (u.output_tokens != null) usage.outputTokens = u.output_tokens
  if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens
  if (u.cache_creation_input_tokens != null) usage.cacheWriteTokens = u.cache_creation_input_tokens
}

function toAnthropicTools(tools: ToolSpec[]): BetaToolUnion[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as { type: 'object' },
    eager_input_streaming: true
  }))
}

/** Neutral transcript → Messages API turns. Assistant turns Claude produced are replayed verbatim. */
export async function toAnthropicMessages(messages: ModelMessage[], io?: AnthropicFiles): Promise<BetaMessageParam[]> {
  const out: BetaMessageParam[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      // Files go before the question, as the API recommends for documents.
      if (m.attachments?.length) out.push({ role: 'user', content: [...(await attachmentBlocks(m.attachments, io)), { type: 'text', text: m.content }] })
      else out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.replay?.provider === 'anthropic') {
        out.push({ role: 'assistant', content: m.replay.content as BetaContentBlockParam[] })
        continue
      }
      const content: BetaContentBlockParam[] = []
      for (const b of m.blocks) {
        if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text })
        else if (b.type === 'tool_call') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.args ?? {} })
      }
      if (content.length) out.push({ role: 'assistant', content })
    } else {
      // All results of one step go back in a single user message.
      const content: BetaContentBlockParam[] = m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) }))
      if (m.note) content.push({ type: 'text', text: m.note })
      out.push({ role: 'user', content })
    }
  }
  return out
}

/** Turn SDK errors into short messages for the UI. */
export function describeAnthropicError(e: unknown): string | null {
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY in Cereal's .env file."
  if (e instanceof Anthropic.NotFoundError) return 'That Claude model was not found. Pick another in Settings → AI.'
  if (e instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached. Try again in a moment.'
  if (e instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your connection.'
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status ?? ''}: ${e.message}`
  return null
}
