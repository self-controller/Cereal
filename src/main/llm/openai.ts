import OpenAI, { toFile } from 'openai'
import type {
  FunctionTool,
  Response,
  ResponseInputContent,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseReasoningItem,
  ResponseUsage
} from 'openai/resources/responses/responses'
import { INLINE_IMAGE_MAX_BYTES, attachmentAsText, attachmentPlaceholder, base64, uploadOnce } from './files'
import { reportUsage, type AttachmentRef, type FileAccess, type GenerateOptions, type LlmProvider, type ModelBlock, type ModelMessage, type StepOptions, type StepResult, type StepUsage, type StopReason } from './provider'

/** Models that reason (and so take `reasoning` and return encrypted reasoning items to replay). */
const REASONING_MODELS = /^(gpt-5|gpt-6|o\d)/

/**
 * OpenAI through the Responses API: the API where uploaded files (`input_file`, `input_image` with a `file_id`)
 * work. Nothing is stored on OpenAI's side (`store: false`); reasoning carries over between turns as encrypted
 * reasoning items, replayed from the transcript.
 */
export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const
  readonly maxInputChars = 600_000
  private readonly client: OpenAI

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly fastModel: string,
    baseURL?: string
  ) {
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
  }

  private reasoning(model: string, tier: 'quality' | 'fast'): Record<string, unknown> {
    return REASONING_MODELS.test(model)
      ? { reasoning: { effort: tier === 'fast' ? 'low' : 'medium', summary: 'auto' }, include: ['reasoning.encrypted_content'] }
      : {}
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const model = opts.tier === 'fast' ? this.fastModel : this.model
    const stream = await this.client.responses.create(
      {
        model,
        stream: true,
        store: false,
        max_output_tokens: opts.maxTokens ?? 16_000,
        instructions: opts.system,
        input: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        ...this.reasoning(model, opts.tier)
      },
      { signal: opts.signal }
    )
    let text = ''
    let usage: StepUsage = {}
    try {
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
          text += event.delta
          opts.onText?.(event.delta)
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          usage = openaiUsage(event.response.usage)
        } else if (event.type === 'response.failed') {
          usage = openaiUsage(event.response.usage)
          throw new Error(event.response.error?.message ?? 'OpenAI could not answer this request.')
        } else if (event.type === 'error') {
          throw new Error(event.message)
        }
      }
      return text
    } finally {
      reportUsage(opts.onUsage, 'openai', model, usage)
    }
  }

  async step(opts: StepOptions): Promise<StepResult> {
    const model = opts.tier === 'fast' ? this.fastModel : this.model
    const tools: FunctionTool[] = opts.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }))
    const io = opts.files ? { files: opts.files, upload: (ref: AttachmentRef, bytes: Uint8Array) => this.upload(ref, bytes) } : undefined
    const stream = await this.client.responses.create(
      {
        model,
        stream: true,
        store: false,
        max_output_tokens: opts.maxTokens ?? 32_000,
        instructions: opts.system,
        input: await toOpenAIInput(opts.messages, io),
        ...(tools.length ? { tools } : {}),
        ...this.reasoning(model, opts.tier)
      },
      { signal: opts.signal }
    )
    let final: Response | null = null
    let usage: StepUsage = {}
    try {
      for await (const event of stream) {
        if (event.type === 'response.output_text.delta') opts.onText?.(event.delta)
        else if (event.type === 'response.reasoning_summary_text.delta') opts.onReasoning?.(event.delta)
        else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          final = event.response
          usage = openaiUsage(event.response.usage)
        } else if (event.type === 'response.failed') {
          usage = openaiUsage(event.response.usage)
          throw new Error(event.response.error?.message ?? 'OpenAI could not answer this request.')
        } else if (event.type === 'error') throw new Error(event.message)
      }
    } finally {
      reportUsage(opts.onUsage, 'openai', model, usage)
    }
    if (!final) throw new Error('OpenAI ended the response without finishing it.')

    const blocks: ModelBlock[] = []
    let refusal = ''
    for (const item of final.output) {
      if (item.type === 'reasoning') {
        const text = item.summary.map((s) => s.text).join('\n\n')
        if (text) blocks.push({ type: 'reasoning', text })
      } else if (item.type === 'message') {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) blocks.push({ type: 'text', text: c.text })
          else if (c.type === 'refusal') refusal += c.refusal
        }
      } else if (item.type === 'function_call') {
        blocks.push({ type: 'tool_call', id: item.call_id, name: item.name, args: parseArgs(item.arguments) })
      }
    }
    const calls = blocks.some((b) => b.type === 'tool_call')
    const incomplete = final.status === 'incomplete' ? final.incomplete_details?.reason : null
    const stopReason: StopReason = calls
      ? 'tool_use'
      : refusal || incomplete === 'content_filter'
        ? 'refusal'
        : incomplete === 'max_output_tokens'
          ? 'max_tokens'
          : final.status === 'completed'
            ? 'end_turn'
            : 'other'
    return {
      blocks,
      stopReason,
      model: final.model,
      usage,
      replay: { provider: 'openai', content: final.output },
      refusal: stopReason === 'refusal' ? refusal || 'OpenAI declined this request (content filter).' : undefined
    }
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    for await (const m of this.client.models.list()) ids.push(m.id)
    return ids.filter((id) => /^(gpt|o\d|chatgpt)/.test(id)).sort()
  }

  /** Upload to the Files API: images for vision, everything else as user data. */
  private async upload(ref: AttachmentRef, bytes: Uint8Array): Promise<string> {
    const file = await this.client.files.create({ file: await toFile(bytes, ref.name, { type: ref.mime }), purpose: ref.kind === 'image' ? 'vision' : 'user_data' })
    return file.id
  }

  async deleteFile(remoteId: string): Promise<void> {
    await this.client.files.delete(remoteId)
  }
}

/** OpenAI counts cache hits inside `input_tokens`; Cereal's usage keeps them apart. Output includes reasoning. */
function openaiUsage(u: ResponseUsage | null | undefined): StepUsage {
  if (!u) return {}
  const cached = u.input_tokens_details?.cached_tokens ?? 0
  return { inputTokens: u.input_tokens - cached, outputTokens: u.output_tokens, cacheReadTokens: cached }
}

/** Arguments that aren't valid JSON are kept as text so validation can report them back to the model. */
function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparsed: raw }
  }
}

export interface OpenAIFiles {
  files: FileAccess
  upload(ref: AttachmentRef, bytes: Uint8Array): Promise<string>
}

async function attachmentParts(refs: AttachmentRef[], io: OpenAIFiles | undefined): Promise<ResponseInputContent[]> {
  const parts: ResponseInputContent[] = []
  for (const ref of refs) {
    if (!io) {
      parts.push({ type: 'input_text', text: attachmentPlaceholder(ref) })
      continue
    }
    const { files } = io
    const fileId = async (): Promise<string> => (await uploadOnce(files, ref, 'openai', async () => ({ remoteId: await io.upload(ref, await files.bytes(ref)) }))).remoteId
    if (ref.kind === 'image') {
      parts.push(
        ref.size <= INLINE_IMAGE_MAX_BYTES
          ? { type: 'input_image', detail: 'auto', image_url: `data:${ref.mime};base64,${base64(await files.bytes(ref))}` }
          : { type: 'input_image', detail: 'auto', file_id: await fileId() }
      )
    } else if (ref.kind === 'pdf') {
      parts.push({ type: 'input_file', file_id: await fileId() })
    } else {
      parts.push({ type: 'input_text', text: await attachmentAsText(files, ref) })
    }
  }
  return parts
}

/** Output items from an earlier OpenAI turn as input items. Ids are dropped (nothing is stored server-side). */
function replayItems(output: ResponseOutputItem[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = []
  for (const item of output) {
    if (item.type === 'reasoning') {
      const { status: _status, ...rest } = item as ResponseReasoningItem
      if (rest.encrypted_content) items.push(rest)
    } else if (item.type === 'message') {
      const text = item.content.flatMap((c) => (c.type === 'output_text' ? [c.text] : [])).join('')
      if (text) items.push({ role: 'assistant', content: text })
    } else if (item.type === 'function_call') {
      items.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments })
    }
  }
  return items
}

/** Neutral transcript → Responses API input items. */
export async function toOpenAIInput(messages: ModelMessage[], io?: OpenAIFiles): Promise<ResponseInputItem[]> {
  const out: ResponseInputItem[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      if (m.attachments?.length) out.push({ role: 'user', content: [...(await attachmentParts(m.attachments, io)), { type: 'input_text', text: m.content }] })
      else out.push({ role: 'user', content: m.content })
    } else if (m.role === 'assistant') {
      if (m.replay?.provider === 'openai') {
        out.push(...replayItems(m.replay.content as ResponseOutputItem[]))
        continue
      }
      const text = m.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      if (text) out.push({ role: 'assistant', content: text })
      for (const b of m.blocks) if (b.type === 'tool_call') out.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.args ?? {}) })
    } else {
      for (const r of m.results) out.push({ type: 'function_call_output', call_id: r.id, output: r.content })
      if (m.note) out.push({ role: 'user', content: m.note })
    }
  }
  return out
}

/** Turn SDK errors into short messages for the UI. */
export function describeOpenAIError(e: unknown): string | null {
  if (e instanceof OpenAI.AuthenticationError) return "OpenAI rejected the API key. Check OPENAI_API_KEY in Cereal's .env file."
  if (e instanceof OpenAI.NotFoundError) return 'That OpenAI model (or an uploaded file) was not found. Pick another model, or start a new chat.'
  if (e instanceof OpenAI.RateLimitError) return 'OpenAI rate limit reached. Try again in a moment.'
  if (e instanceof OpenAI.APIConnectionError) return 'Could not reach OpenAI. Check your connection.'
  if (e instanceof OpenAI.APIError) return `OpenAI API error ${e.status ?? ''}: ${e.message}`
  return null
}
