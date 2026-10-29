import { randomUUID } from 'node:crypto'
import { attachmentAsText, base64 } from './files'
import { reportUsage, type FileAccess, type GenerateOptions, type LlmProvider, type ModelBlock, type ModelMessage, type StepOptions, type StepResult, type StepUsage } from './provider'

const NUM_CTX = 32_768

interface OllamaChunk {
  message?: { content?: string; thinking?: string; tool_calls?: { function?: { name?: string; arguments?: unknown } }[] }
  error?: string
  done?: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
}

/** Local models through Ollama's HTTP API (NDJSON streaming). */
export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const
  // ~3.5 chars per token, leaving room for the prompt and the answer.
  readonly maxInputChars = Math.floor(NUM_CTX * 3.5 * 0.6)

  constructor(
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

  /** POST /api/chat and yield each NDJSON chunk. */
  private async *chat(body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<OllamaChunk> {
    let res: Response
    try {
      res = await fetch(new URL('/api/chat', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({ model: this.model, stream: true, ...body })
      })
    } catch (e) {
      if (signal?.aborted) throw e
      throw new Error(`Could not reach Ollama at ${this.baseUrl}. Is it running?`)
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      if (/does not support (images|vision)|image input|multimodal/i.test(text)) {
        throw new Error(`The Ollama model "${this.model}" can't read images. Pick a vision model (for example llava or qwen2.5vl) in Settings → AI, or remove the image.`)
      }
      if (/does not support tools/i.test(text)) {
        throw new Error(`The Ollama model "${this.model}" can't use tools, which Cereal's chat and Assistant need. Pick a model that can (for example llama3.1 or qwen3) in Settings → AI.`)
      }
      throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200)}`)
    }
    let buffered = ''
    const decoder = new TextDecoder()
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(part, { stream: true })
      let nl: number
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim()
        buffered = buffered.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line) as OllamaChunk
        if (msg.error) throw new Error(`Ollama: ${msg.error}`)
        yield msg
      }
    }
    if (buffered.trim()) yield JSON.parse(buffered) as OllamaChunk
  }

  async generate(opts: GenerateOptions): Promise<string> {
    let text = ''
    const usage: StepUsage = {}
    const body = { options: { num_ctx: NUM_CTX, num_predict: opts.maxTokens ?? 4096 }, messages: [{ role: 'system', content: opts.system }, ...opts.messages] }
    try {
      for await (const msg of this.chat(body, opts.signal)) {
        const delta = msg.message?.content
        if (delta) {
          text += delta
          opts.onText?.(delta)
        }
        if (msg.done) Object.assign(usage, ollamaUsage(msg))
      }
      return text
    } finally {
      reportUsage(opts.onUsage, 'ollama', this.model, usage)
    }
  }

  async step(opts: StepOptions): Promise<StepResult> {
    let text = ''
    let reasoning = ''
    let doneReason: string | undefined
    const usage: StepUsage = {}
    const calls: ModelBlock[] = []
    const body = {
      options: { num_ctx: NUM_CTX, num_predict: opts.maxTokens ?? 4096 },
      messages: [{ role: 'system', content: opts.system }, ...(await toOllamaMessages(opts.messages, opts.files))],
      ...(opts.tools.length ? { tools: opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {})
    }
    try {
      for await (const msg of this.chat(body, opts.signal)) {
        const m = msg.message
        if (m?.content) {
          text += m.content
          opts.onText?.(m.content)
        }
        if (m?.thinking) {
          reasoning += m.thinking
          opts.onReasoning?.(m.thinking)
        }
        for (const tc of m?.tool_calls ?? []) {
          if (!tc.function?.name) continue
          const args = typeof tc.function.arguments === 'string' ? safeJson(tc.function.arguments) : (tc.function.arguments ?? {})
          // Ollama doesn't number its tool calls; give each an id so results can be matched up.
          calls.push({ type: 'tool_call', id: `call_${randomUUID().replace(/-/g, '')}`, name: tc.function.name, args })
        }
        if (msg.done) {
          doneReason = msg.done_reason
          Object.assign(usage, ollamaUsage(msg))
        }
      }
    } finally {
      reportUsage(opts.onUsage, 'ollama', this.model, usage)
    }
    const blocks: ModelBlock[] = [...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []), ...(text ? [{ type: 'text' as const, text }] : []), ...calls]
    return { blocks, stopReason: calls.length ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'end_turn', model: this.model, usage }
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(new URL('/api/tags', this.baseUrl))
    if (!res.ok) throw new Error(`Ollama error ${res.status}`)
    const json = (await res.json()) as { models?: { name: string }[] }
    return (json.models ?? []).map((m) => m.name)
  }
}

/** The final chunk's counts. Local, so free, but they size the what-if estimates in Settings → Usage. */
function ollamaUsage(msg: OllamaChunk): StepUsage {
  return { inputTokens: msg.prompt_eval_count, outputTokens: msg.eval_count }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return { __unparsed: raw }
  }
}

/** Neutral transcript → Ollama chat messages. Images go in `images` (vision models); other files as their text. */
export async function toOllamaMessages(messages: ModelMessage[], files?: FileAccess): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const refs = m.attachments ?? []
      const images: string[] = []
      const texts: string[] = []
      for (const ref of refs) {
        if (ref.kind === 'image' && files) images.push(base64(await files.bytes(ref)))
        else texts.push(await attachmentAsText(files, ref))
      }
      out.push({ role: 'user', content: [...texts, m.content].join('\n\n'), ...(images.length ? { images } : {}) })
    } else if (m.role === 'assistant') {
      const text = m.blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
      const toolCalls = m.blocks.flatMap((b) => (b.type === 'tool_call' ? [{ function: { name: b.name, arguments: b.args ?? {} } }] : []))
      out.push({ role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
    } else {
      for (const r of m.results) out.push({ role: 'tool', content: r.content, tool_name: r.name })
      if (m.note) out.push({ role: 'user', content: m.note })
    }
  }
  return out
}
