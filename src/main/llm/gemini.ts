import { randomUUID } from 'node:crypto'
import { ApiError, FileState, FinishReason, GoogleGenAI, type Content, type GenerateContentConfig, type GenerateContentResponseUsageMetadata, type Part } from '@google/genai'
import { INLINE_IMAGE_MAX_BYTES, attachmentAsText, attachmentPlaceholder, base64, fileOf, uploadOnce } from './files'
import { reportUsage, type AttachmentRef, type FileAccess, type GenerateOptions, type LlmProvider, type ModelBlock, type ModelMessage, type RemoteFile, type StepOptions, type StepResult, type StepUsage, type StopReason } from './provider'

/** Gemini deletes uploaded files after 48 hours; re-upload a little before that. */
const FILE_LIFETIME_MS = 47 * 60 * 60 * 1000
const FILE_POLL_MS = 1000
const FILE_POLL_LIMIT = 120

const BLOCKED: string[] = [FinishReason.SAFETY, FinishReason.RECITATION, FinishReason.BLOCKLIST, FinishReason.PROHIBITED_CONTENT, FinishReason.SPII]

/**
 * Google Gemini through the Gemini API (`@google/genai`). Files go through the Gemini Files API, and the model's
 * parts are replayed verbatim on the next request so thought signatures round-trip with their function calls.
 */
export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const
  readonly maxInputChars = 2_000_000
  private readonly client: GoogleGenAI

  constructor(
    apiKey: string,
    private readonly model: string,
    private readonly fastModel: string,
    baseURL?: string
  ) {
    this.client = new GoogleGenAI({ apiKey, ...(baseURL ? { httpOptions: { baseUrl: baseURL } } : {}) })
  }

  async generate(opts: GenerateOptions): Promise<string> {
    const model = opts.tier === 'fast' ? this.fastModel : this.model
    const stream = await this.client.models.generateContentStream({
      model,
      contents: opts.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      config: { systemInstruction: opts.system, maxOutputTokens: opts.maxTokens ?? 16_000, abortSignal: opts.signal }
    })
    let text = ''
    let usage: StepUsage = {}
    try {
      for await (const chunk of stream) {
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.text && !part.thought) {
            text += part.text
            opts.onText?.(part.text)
          }
        }
        if (chunk.usageMetadata) usage = geminiUsage(chunk.usageMetadata)
      }
      return text
    } finally {
      reportUsage(opts.onUsage, 'gemini', model, usage)
    }
  }

  async step(opts: StepOptions): Promise<StepResult> {
    const model = opts.tier === 'fast' ? this.fastModel : this.model
    const config: GenerateContentConfig = {
      systemInstruction: opts.system,
      maxOutputTokens: opts.maxTokens ?? 32_000,
      thinkingConfig: { includeThoughts: true },
      abortSignal: opts.signal,
      ...(opts.tools.length ? { tools: [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] } : {})
    }
    const io = opts.files ? { files: opts.files, upload: (ref: AttachmentRef, bytes: Uint8Array) => this.upload(ref, bytes) } : undefined
    const stream = await this.client.models.generateContentStream({ model, contents: await toGeminiContents(opts.messages, io), config })

    const parts: Part[] = []
    let finish: string | undefined
    let usage: StepUsage = {}
    let modelVersion = model
    try {
      for await (const chunk of stream) {
        const candidate = chunk.candidates?.[0]
        for (const part of candidate?.content?.parts ?? []) {
          parts.push(part)
          if (part.text && part.thought) opts.onReasoning?.(part.text)
          else if (part.text) opts.onText?.(part.text)
        }
        if (candidate?.finishReason) finish = candidate.finishReason
        if (chunk.usageMetadata) usage = geminiUsage(chunk.usageMetadata)
        if (chunk.modelVersion) modelVersion = chunk.modelVersion
        if (chunk.promptFeedback?.blockReason) finish = FinishReason.SAFETY
      }
    } finally {
      reportUsage(opts.onUsage, 'gemini', model, usage)
    }

    // Gemini may leave out call ids; give each call one so its result can be matched up (and replay keeps it).
    for (const part of parts) if (part.functionCall && !part.functionCall.id) part.functionCall.id = `call_${randomUUID().replace(/-/g, '')}`
    const blocks: ModelBlock[] = []
    let text = ''
    let reasoning = ''
    for (const part of parts) {
      if (part.text && part.thought) reasoning += part.text
      else if (part.text) text += part.text
    }
    if (reasoning) blocks.push({ type: 'reasoning', text: reasoning })
    if (text) blocks.push({ type: 'text', text })
    for (const part of parts) {
      const call = part.functionCall
      if (call?.name) blocks.push({ type: 'tool_call', id: call.id!, name: call.name, args: call.args ?? {} })
    }
    const calls = blocks.some((b) => b.type === 'tool_call')
    const blocked = !!finish && BLOCKED.includes(finish)
    const stopReason: StopReason = calls ? 'tool_use' : blocked ? 'refusal' : finish === FinishReason.MAX_TOKENS ? 'max_tokens' : finish === FinishReason.STOP || !finish ? 'end_turn' : 'other'
    return {
      blocks,
      stopReason,
      model: modelVersion,
      usage,
      replay: { provider: 'gemini', content: parts },
      refusal: blocked ? `Gemini declined this request (${finish!.toLowerCase().replace(/_/g, ' ')}).` : undefined
    }
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = []
    const pager = await this.client.models.list()
    for await (const m of pager) {
      if (m.name && (m.supportedActions ?? []).includes('generateContent')) ids.push(m.name.replace(/^models\//, ''))
    }
    return ids.filter((id) => id.startsWith('gemini')).sort()
  }

  /** Upload to the Files API and wait until Gemini has processed the file. */
  private async upload(ref: AttachmentRef, bytes: Uint8Array): Promise<RemoteFile> {
    let file = await this.client.files.upload({ file: fileOf(bytes, ref.name, ref.mime), config: { mimeType: ref.mime, displayName: ref.name } })
    for (let i = 0; file.state === FileState.PROCESSING && i < FILE_POLL_LIMIT; i++) {
      await new Promise((r) => setTimeout(r, FILE_POLL_MS))
      file = await this.client.files.get({ name: file.name! })
    }
    if (file.state === FileState.FAILED) throw new Error(`Gemini couldn't process ${ref.name}${file.error?.message ? `: ${file.error.message}` : '.'}`)
    if (!file.name || !file.uri) throw new Error(`Gemini didn't accept ${ref.name}.`)
    const expires = file.expirationTime ? Date.parse(file.expirationTime) - 60 * 60 * 1000 : Date.now() + FILE_LIFETIME_MS
    return { remoteId: file.name, uri: file.uri, expiresAt: new Date(Math.min(expires, Date.now() + FILE_LIFETIME_MS)).toISOString() }
  }

  async deleteFile(remoteId: string): Promise<void> {
    await this.client.files.delete({ name: remoteId })
  }
}

/** Gemini counts cache hits inside `promptTokenCount`; Cereal's usage keeps them apart. Thoughts bill as output. */
function geminiUsage(m: GenerateContentResponseUsageMetadata): StepUsage {
  const cached = m.cachedContentTokenCount ?? 0
  return { inputTokens: (m.promptTokenCount ?? 0) - cached, outputTokens: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0), cacheReadTokens: cached }
}

export interface GeminiFiles {
  files: FileAccess
  upload(ref: AttachmentRef, bytes: Uint8Array): Promise<RemoteFile>
}

async function attachmentParts(refs: AttachmentRef[], io: GeminiFiles | undefined): Promise<Part[]> {
  const parts: Part[] = []
  for (const ref of refs) {
    if (!io) {
      parts.push({ text: attachmentPlaceholder(ref) })
      continue
    }
    const { files } = io
    if (ref.kind === 'image' && ref.size <= INLINE_IMAGE_MAX_BYTES) {
      parts.push({ inlineData: { mimeType: ref.mime, data: base64(await files.bytes(ref)) } })
    } else if (ref.kind === 'image' || ref.kind === 'pdf') {
      const remote = await uploadOnce(files, ref, 'gemini', async () => io.upload(ref, await files.bytes(ref)))
      parts.push({ fileData: { fileUri: remote.uri ?? undefined, mimeType: ref.mime } })
    } else {
      parts.push({ text: await attachmentAsText(files, ref) })
    }
  }
  return parts
}

/** Neutral transcript → Gemini contents. Turns Gemini produced are replayed part for part. */
export async function toGeminiContents(messages: ModelMessage[], io?: GeminiFiles): Promise<Content[]> {
  const out: Content[] = []
  // Consecutive same-role turns are merged: Gemini expects user and model turns to alternate.
  const push = (role: 'user' | 'model', parts: Part[]): void => {
    if (!parts.length) return
    const last = out[out.length - 1]
    if (last?.role === role) last.parts = [...(last.parts ?? []), ...parts]
    else out.push({ role, parts })
  }
  for (const m of messages) {
    if (m.role === 'user') {
      push('user', [...(m.attachments?.length ? await attachmentParts(m.attachments, io) : []), { text: m.content }])
    } else if (m.role === 'assistant') {
      if (m.replay?.provider === 'gemini') {
        push('model', m.replay.content as Part[])
        continue
      }
      const parts: Part[] = []
      const text = m.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      if (text) parts.push({ text })
      for (const b of m.blocks) if (b.type === 'tool_call') parts.push({ functionCall: { id: b.id, name: b.name, args: (b.args ?? {}) as Record<string, unknown> } })
      push('model', parts)
    } else {
      const parts: Part[] = m.results.map((r) => ({ functionResponse: { id: r.id, name: r.name, response: r.isError ? { error: r.content } : { output: r.content } } }))
      if (m.note) parts.push({ text: m.note })
      push('user', parts)
    }
  }
  return out
}

/** Turn SDK errors into short messages for the UI. */
export function describeGeminiError(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null
  if (e.status === 400 && /api key/i.test(e.message)) return "Google rejected the API key. Check GEMINI_API_KEY in Cereal's .env file."
  if (e.status === 401 || e.status === 403) return "Google rejected the API key. Check GEMINI_API_KEY in Cereal's .env file."
  if (e.status === 404) return 'That Gemini model (or an uploaded file) was not found. Pick another model, or start a new chat.'
  if (e.status === 429) return 'Gemini rate limit reached. Try again in a moment.'
  return `Gemini API error ${e.status}: ${e.message}`
}
