import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../src/main/llm/anthropic'
import { OpenAIProvider } from '../src/main/llm/openai'
import { OllamaProvider } from '../src/main/llm/ollama'
import { GeminiProvider } from '../src/main/llm/gemini'
import type { AttachmentRef, FileAccess, ModelMessage, RemoteFile, ToolSpec, UsageReport } from '../src/main/llm/provider'

interface Captured {
  url: string
  method: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
  /** The raw body, for uploads that aren't JSON. */
  raw: string
}

let server: Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

/** A local HTTP server that records each request and answers with `respond`. */
async function mock(respond: (req: Captured, res: ServerResponse, n: number) => void): Promise<{ url: string; requests: Captured[] }> {
  const requests: Captured[] = []
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        // multipart or binary upload
      }
      const captured = { url: req.url ?? '', method: req.method ?? '', headers: req.headers, body, raw }
      requests.push(captured)
      respond(captured, res, requests.length - 1)
    })
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  return { url: `http://127.0.0.1:${addr.port}`, requests }
}

function sse(res: ServerResponse, events: Record<string, unknown>[], named = true): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const e of events) res.write(`${named ? `event: ${String(e.type)}\n` : ''}data: ${JSON.stringify(e)}\n\n`)
  if (!named) res.write('data: [DONE]\n\n')
  res.end()
}

/** Gemini's stream: bare `data:` events and no end marker. */
function geminiSse(res: ServerResponse, chunks: Record<string, unknown>[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`)
  res.end()
}

/** In-memory attachment access: fixed bytes and text, and a provider upload cache like the backend's. */
function fakeFiles(): FileAccess & { uploads: Map<string, RemoteFile> } {
  const uploads = new Map<string, RemoteFile>()
  return {
    uploads,
    bytes: async (ref) => new TextEncoder().encode(`bytes of ${ref.name}`),
    text: async (ref) => `text of ${ref.name}`,
    remote: (ref, provider) => uploads.get(`${provider}:${ref.id}`) ?? null,
    remember: async (ref, provider, remote) => void uploads.set(`${provider}:${ref.id}`, remote)
  }
}

const PDF: AttachmentRef = { id: '00000000-0000-4000-8000-000000000001', name: 'report.pdf', mime: 'application/pdf', kind: 'pdf', size: 5000, pages: 2, textChars: 40 }
const PNG: AttachmentRef = { id: '00000000-0000-4000-8000-000000000002', name: 'chart.png', mime: 'image/png', kind: 'image', size: 2000 }
const DOCX: AttachmentRef = {
  id: '00000000-0000-4000-8000-000000000003',
  name: 'plan.docx',
  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  kind: 'office',
  size: 3000,
  textChars: 30
}
const B64 = (s: string): string => Buffer.from(s).toString('base64')

const TOOLS: ToolSpec[] = [{ name: 'searchMeetings', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }]

describe('Anthropic step()', () => {
  it('streams thinking, text and a tool call, and replays the content verbatim with tool results', async () => {
    const turn = [
      { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Look it up.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-123' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Searching.' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'searchMeetings', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query":' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"budget"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } },
      { type: 'message_stop' }
    ]
    const { url, requests } = await mock((_req, res) => sse(res, turn))
    const p = new AnthropicProvider('key', 'claude-opus-5-5', 'claude-haiku-5-5', url)
    const text: string[] = []
    const reasoning: string[] = []
    const r = await p.step({ system: 'sys', messages: [{ role: 'user', content: 'Budget?' }], tools: TOOLS, tier: 'quality', onText: (d) => text.push(d), onReasoning: (d) => reasoning.push(d) })

    expect(text.join('')).toBe('Searching.')
    expect(reasoning.join('')).toBe('Look it up.')
    expect(r.stopReason).toBe('tool_use')
    expect(r.blocks).toEqual([
      { type: 'reasoning', text: 'Look it up.' },
      { type: 'text', text: 'Searching.' },
      { type: 'tool_call', id: 'toolu_1', name: 'searchMeetings', args: { query: 'budget' } }
    ])
    expect(r.usage).toMatchObject({ inputTokens: 12, outputTokens: 30, cacheReadTokens: 7 })

    const body = requests[0].body
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'sys',
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      fallbacks: 'default'
    })
    expect(body.tools).toEqual([{ name: 'searchMeetings', description: 'Search', input_schema: TOOLS[0].parameters, eager_input_streaming: true }])
    expect(String(requests[0].headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01')
    expect(body).not.toHaveProperty('tool_choice')

    // Next turn: the assistant content goes back unchanged (thinking signature included), results in one user turn.
    const history: ModelMessage[] = [
      { role: 'user', content: 'Budget?' },
      { role: 'assistant', blocks: r.blocks, replay: r.replay },
      { role: 'tool', results: [{ id: 'toolu_1', name: 'searchMeetings', content: '[1] Budget review' }], note: 'Answer now.' }
    ]
    await p.step({ system: 'sys', messages: history, tools: TOOLS, tier: 'quality' })
    const messages = requests[1].body.messages as { role: string; content: unknown }[]
    expect(messages[1].role).toBe('assistant')
    expect((messages[1].content as { type: string; signature?: string }[])[0]).toMatchObject({ type: 'thinking', thinking: 'Look it up.', signature: 'sig-123' })
    expect(messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[1] Budget review' }, { type: 'text', text: 'Answer now.' }] })
  })

  it('reports refusals and leaves thinking off for models without adaptive thinking', async () => {
    const turn = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'refusal', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' }
    ]
    const { url, requests } = await mock((_req, res) => sse(res, turn))
    const r = await new AnthropicProvider('key', 'claude-haiku-4-5', 'claude-haiku-4-5', url).step({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], tier: 'quality' })
    expect(r.stopReason).toBe('refusal')
    expect(r.refusal).toMatch(/declined/)
    expect(requests[0].body).not.toHaveProperty('thinking')
    expect(requests[0].body).not.toHaveProperty('fallbacks')
  })
})

describe('OpenAI step()', () => {
  const response = (output: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'gpt-5.6',
    output,
    usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
    ...extra
  })

  it('streams through the Responses API, uploads files once, and replays reasoning and tool calls', async () => {
    const reasoningItem = { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Check the notes.' }], encrypted_content: 'enc-1', status: 'completed' }
    const message = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Let me check.', annotations: [] }] }
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'searchMeetings', arguments: '{"query":"budget"}', status: 'completed' }
    const { url, requests } = await mock((req, res) => {
      if (req.url.startsWith('/files')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'file-pdf', object: 'file', bytes: 10, created_at: 1, filename: 'report.pdf', purpose: 'user_data', status: 'processed' }))
      }
      sse(res, [
        { type: 'response.created', sequence_number: 0, response: response([], { status: 'in_progress' }) },
        { type: 'response.reasoning_summary_text.delta', sequence_number: 1, item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'Check the notes.' },
        { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Let me check.' },
        { type: 'response.completed', sequence_number: 3, response: response([reasoningItem, message, call]) }
      ])
    })
    const p = new OpenAIProvider('key', 'gpt-5.6', 'gpt-5.4-mini', url)
    const files = fakeFiles()
    const text: string[] = []
    const reasoning: string[] = []
    const question: ModelMessage = { role: 'user', content: 'Budget?', attachments: [PDF, PNG, DOCX] }
    const r = await p.step({ system: 'sys', messages: [question], tools: TOOLS, tier: 'quality', files, onText: (d) => text.push(d), onReasoning: (d) => reasoning.push(d) })

    expect(text.join('')).toBe('Let me check.')
    expect(reasoning.join('')).toBe('Check the notes.')
    expect(r.blocks).toEqual([
      { type: 'reasoning', text: 'Check the notes.' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_call', id: 'call_a', name: 'searchMeetings', args: { query: 'budget' } }
    ])
    expect(r.stopReason).toBe('tool_use')
    // input_tokens counts the 2 cache hits; Cereal's usage keeps them apart.
    expect(r.usage).toMatchObject({ inputTokens: 7, outputTokens: 4, cacheReadTokens: 2 })

    // The PDF was uploaded for user data; the small image went inline; the Word file as its text.
    const uploads = requests.filter((q) => q.url.startsWith('/files'))
    expect(uploads).toHaveLength(1)
    expect(uploads[0].raw).toContain('user_data')
    expect(files.uploads.get(`openai:${PDF.id}`)).toEqual({ remoteId: 'file-pdf' })
    const first = requests.find((q) => q.url.startsWith('/responses'))!.body
    expect(first).toMatchObject({ model: 'gpt-5.6', instructions: 'sys', stream: true, store: false, include: ['reasoning.encrypted_content'], reasoning: { effort: 'medium', summary: 'auto' } })
    expect(first.tools).toEqual([{ type: 'function', name: 'searchMeetings', description: 'Search', parameters: TOOLS[0].parameters, strict: false }])
    expect(first.input).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_file', file_id: 'file-pdf' },
          { type: 'input_image', detail: 'auto', image_url: `data:image/png;base64,${B64('bytes of chart.png')}` },
          { type: 'input_text', text: expect.stringContaining('text of plan.docx') },
          { type: 'input_text', text: 'Budget?' }
        ]
      }
    ])

    await p.step({
      system: 'sys',
      messages: [question, { role: 'assistant', blocks: r.blocks, replay: r.replay }, { role: 'tool', results: [{ id: 'call_a', name: 'searchMeetings', content: 'found' }] }],
      tools: TOOLS,
      tier: 'quality',
      files
    })
    // No second upload: the file id is reused.
    expect(requests.filter((q) => q.url.startsWith('/files'))).toHaveLength(1)
    const second = requests.filter((q) => q.url.startsWith('/responses'))[1].body.input as unknown[]
    expect(second.slice(1)).toEqual([
      { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Check the notes.' }], encrypted_content: 'enc-1' },
      { role: 'assistant', content: 'Let me check.' },
      { type: 'function_call', call_id: 'call_a', name: 'searchMeetings', arguments: '{"query":"budget"}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'found' }
    ])
  })

  it('reports refusals and cut-off answers', async () => {
    const refused = { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'I can’t help with that.' }] }
    const { url } = await mock((_req, res) => sse(res, [{ type: 'response.completed', sequence_number: 0, response: response([refused]) }]))
    const r = await new OpenAIProvider('key', 'gpt-5.6', 'gpt-5.4-mini', url).step({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], tier: 'quality' })
    expect(r.stopReason).toBe('refusal')
    expect(r.refusal).toBe('I can’t help with that.')

    server?.close()
    const cut = await mock((_req, res) =>
      sse(res, [{ type: 'response.incomplete', sequence_number: 0, response: response([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }) }])
    )
    const r2 = await new OpenAIProvider('key', 'gpt-5.6', 'gpt-5.4-mini', cut.url).step({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], tier: 'quality' })
    expect(r2.stopReason).toBe('max_tokens')
  })
})

describe('Anthropic attachments', () => {
  it('uploads PDFs to the Files API once, inlines small images and sends other files as text documents', async () => {
    const turn = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Read it.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
      { type: 'message_stop' }
    ]
    const { url, requests } = await mock((req, res) => {
      if (req.url.startsWith('/v1/files')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ id: 'file_abc', type: 'file', filename: 'report.pdf', mime_type: 'application/pdf', size_bytes: 10, created_at: '2026-10-20T00:00:00Z', downloadable: false }))
      }
      sse(res, turn)
    })
    const p = new AnthropicProvider('key', 'claude-opus-5-5', 'claude-haiku-5-5', url)
    const files = fakeFiles()
    const messages: ModelMessage[] = [{ role: 'user', content: 'Summarise these', attachments: [PDF, PNG, DOCX] }]
    await p.step({ system: 'sys', messages, tools: [], tier: 'quality', files })
    await p.step({ system: 'sys', messages, tools: [], tier: 'quality', files })

    expect(requests.filter((q) => q.url.startsWith('/v1/files'))).toHaveLength(1)
    const content = (requests.find((q) => q.url.startsWith('/v1/messages'))!.body.messages as { content: unknown }[])[0].content
    expect(content).toEqual([
      { type: 'document', title: 'report.pdf', source: { type: 'file', file_id: 'file_abc' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64('bytes of chart.png') } },
      { type: 'document', title: 'plan.docx', source: { type: 'text', media_type: 'text/plain', data: 'text of plan.docx' } },
      { type: 'text', text: 'Summarise these' }
    ])
  })

  it('names the files when it has no way to read them', async () => {
    const turn = [
      { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' }
    ]
    const { url, requests } = await mock((_req, res) => sse(res, turn))
    await new AnthropicProvider('key', 'claude-opus-5-5', 'claude-haiku-5-5', url).step({ system: 's', messages: [{ role: 'user', content: 'q', attachments: [PDF] }], tools: [], tier: 'quality' })
    expect((requests[0].body.messages as { content: unknown }[])[0].content).toEqual([
      { type: 'text', text: '[Attached file: report.pdf]' },
      { type: 'text', text: 'q' }
    ])
  })
})

describe('Gemini step()', () => {
  it('streams thoughts, text and calls, uploads files through the Files API and replays parts with signatures', async () => {
    const chunks = [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Thinking about it.', thought: true }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me check.' }] } }] },
      {
        candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'searchMeetings', args: { query: 'budget' } }, thoughtSignature: 'sig-g' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5, thoughtsTokenCount: 2, cachedContentTokenCount: 3 },
        modelVersion: 'gemini-3.1-pro-preview'
      }
    ]
    let base = ''
    const { url, requests } = await mock((req, res) => {
      if (req.url.startsWith('/upload/v1beta/files')) {
        res.writeHead(200, { 'content-type': 'application/json', 'x-goog-upload-url': `${base}/upload-session/1` })
        return res.end('{}')
      }
      if (req.url.startsWith('/upload-session')) {
        res.writeHead(200, { 'content-type': 'application/json', 'x-goog-upload-status': 'final' })
        return res.end(JSON.stringify({ file: { name: 'files/abc', uri: 'https://generativelanguage.example/files/abc', mimeType: 'application/pdf', state: 'ACTIVE' } }))
      }
      geminiSse(res, chunks)
    })
    base = url
    const p = new GeminiProvider('key', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', url)
    const files = fakeFiles()
    const text: string[] = []
    const reasoning: string[] = []
    const question: ModelMessage = { role: 'user', content: 'Budget?', attachments: [PDF, PNG] }
    const r = await p.step({ system: 'sys', messages: [question], tools: TOOLS, tier: 'quality', files, onText: (d) => text.push(d), onReasoning: (d) => reasoning.push(d) })

    expect(text.join('')).toBe('Let me check.')
    expect(reasoning.join('')).toBe('Thinking about it.')
    expect(r.stopReason).toBe('tool_use')
    expect(r.blocks).toEqual([
      { type: 'reasoning', text: 'Thinking about it.' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_call', id: expect.stringMatching(/^call_/), name: 'searchMeetings', args: { query: 'budget' } }
    ])
    // promptTokenCount counts the 3 cached tokens; thoughts bill as output.
    expect(r.usage).toEqual({ inputTokens: 8, outputTokens: 7, cacheReadTokens: 3 })
    expect(files.uploads.get(`gemini:${PDF.id}`)).toMatchObject({ remoteId: 'files/abc', uri: 'https://generativelanguage.example/files/abc' })

    const gen = requests.find((q) => q.url.includes(':streamGenerateContent'))!
    expect(gen.url).toContain('/models/gemini-3.1-pro-preview:streamGenerateContent')
    expect(gen.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'sys' }] },
      generationConfig: { thinkingConfig: { includeThoughts: true } },
      tools: [{ functionDeclarations: [{ name: 'searchMeetings', description: 'Search', parametersJsonSchema: TOOLS[0].parameters }] }]
    })
    expect(gen.body.contents).toEqual([
      {
        role: 'user',
        parts: [{ fileData: { fileUri: 'https://generativelanguage.example/files/abc', mimeType: 'application/pdf' } }, { inlineData: { mimeType: 'image/png', data: B64('bytes of chart.png') } }, { text: 'Budget?' }]
      }
    ])

    const id = (r.blocks[2] as { id: string }).id
    await p.step({
      system: 'sys',
      messages: [question, { role: 'assistant', blocks: r.blocks, replay: r.replay }, { role: 'tool', results: [{ id, name: 'searchMeetings', content: 'found' }] }],
      tools: TOOLS,
      tier: 'quality',
      files
    })
    expect(requests.filter((q) => q.url.startsWith('/upload/'))).toHaveLength(1)
    const next = requests.filter((q) => q.url.includes(':streamGenerateContent'))[1].body.contents as { role: string; parts: Record<string, unknown>[] }[]
    expect(next[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Thinking about it.', thought: true },
        { text: 'Let me check.' },
        { functionCall: { id, name: 'searchMeetings', args: { query: 'budget' } }, thoughtSignature: 'sig-g' }
      ]
    })
    expect(next[2]).toEqual({ role: 'user', parts: [{ functionResponse: { id, name: 'searchMeetings', response: { output: 'found' } } }] })
  })

  it('treats safety stops as refusals', async () => {
    const { url } = await mock((_req, res) => geminiSse(res, [{ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'SAFETY' }] }]))
    const r = await new GeminiProvider('key', 'gemini-3.5-flash', 'gemini-3.5-flash', url).step({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], tier: 'quality' })
    expect(r.stopReason).toBe('refusal')
    expect(r.refusal).toMatch(/declined/)
  })
})

describe('Ollama step()', () => {
  it('reads tool calls, numbers them, and returns results with tool_name', async () => {
    const { url, requests } = await mock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'searchMeetings', arguments: { query: 'budget' } } }] }, done: false }) + '\n')
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 5, eval_count: 3 }) + '\n')
    })
    const p = new OllamaProvider(url, 'llama3.1')
    const r = await p.step({ system: 'sys', messages: [{ role: 'user', content: 'Budget?' }], tools: TOOLS, tier: 'quality' })
    expect(r.stopReason).toBe('tool_use')
    expect(r.blocks).toEqual([{ type: 'tool_call', id: expect.stringMatching(/^call_[0-9a-f]{32}$/), name: 'searchMeetings', args: { query: 'budget' } }])
    expect(requests[0].body.tools).toEqual([{ type: 'function', function: { name: 'searchMeetings', description: 'Search', parameters: TOOLS[0].parameters } }])

    const id = (r.blocks[0] as { id: string }).id
    await p.step({ system: 'sys', messages: [{ role: 'user', content: 'Budget?' }, { role: 'assistant', blocks: r.blocks }, { role: 'tool', results: [{ id, name: 'searchMeetings', content: 'found' }] }], tools: TOOLS, tier: 'quality' })
    expect((requests[1].body.messages as unknown[]).slice(2)).toEqual([
      { role: 'assistant', content: '', tool_calls: [{ function: { name: 'searchMeetings', arguments: { query: 'budget' } } }] },
      { role: 'tool', content: 'found', tool_name: 'searchMeetings' }
    ])
  })

  it('sends images in `images` and other files as text', async () => {
    const { url, requests } = await mock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'A chart.' }, done: true, done_reason: 'stop' }) + '\n')
    })
    await new OllamaProvider(url, 'qwen2.5vl').step({ system: 's', messages: [{ role: 'user', content: 'What is this?', attachments: [PNG, PDF] }], tools: [], tier: 'quality', files: fakeFiles() })
    const user = (requests[0].body.messages as Record<string, unknown>[])[1]
    expect(user.images).toEqual([B64('bytes of chart.png')])
    expect(user.content).toContain('text of report.pdf')
    expect(String(user.content).endsWith('What is this?')).toBe(true)
  })

  it('explains when a model cannot use tools', async () => {
    const { url } = await mock((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'registry.ollama.ai/library/gemma:2b does not support tools' }))
    })
    await expect(new OllamaProvider(url, 'gemma:2b').step({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: TOOLS, tier: 'quality' })).rejects.toThrow(/can't use tools/)
  })
})

describe('usage reporting', () => {
  const anthropicTurn = (usage: Record<string, number>): Record<string, unknown>[] => [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A title' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } },
    { type: 'message_stop' }
  ]

  it('Anthropic generate() reports the requested model and its uncached, cached and output tokens', async () => {
    const { url } = await mock((_req, res) => sse(res, anthropicTurn({ input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 5, cache_creation_input_tokens: 3 })))
    const reports: UsageReport[] = []
    const text = await new AnthropicProvider('key', 'claude-opus-5-5', 'claude-haiku-5-5', url).generate({ tier: 'fast', system: 's', messages: [{ role: 'user', content: 'x' }], onUsage: (r) => reports.push(r) })
    expect(text).toBe('A title')
    expect(reports).toEqual([{ provider: 'anthropic', model: 'claude-haiku-5-5', usage: { inputTokens: 20, outputTokens: 9, cacheReadTokens: 5, cacheWriteTokens: 3 } }])
  })

  it('Anthropic reports what a stopped turn had used by then', async () => {
    const { url } = await mock((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const e of anthropicTurn({ input_tokens: 12, output_tokens: 1 }).slice(0, 3)) res.write(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)
      setTimeout(() => res.end(), 1_000)
    })
    const abort = new AbortController()
    const reports: UsageReport[] = []
    const step = new AnthropicProvider('key', 'claude-opus-5-5', 'claude-haiku-5-5', url).step({
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: [],
      tier: 'quality',
      signal: abort.signal,
      onText: () => abort.abort(),
      onUsage: (r) => reports.push(r)
    })
    await expect(step).rejects.toThrow()
    expect(reports).toEqual([{ provider: 'anthropic', model: 'claude-opus-5-5', usage: { inputTokens: 12, outputTokens: 1 } }])
  })

  it('OpenAI generate() takes cache hits out of input', async () => {
    const completed = { id: 'r', object: 'response', created_at: 1, status: 'completed', model: 'gpt-5.4-mini-2026-03-01', output: [], usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } } }
    const { url } = await mock((_req, res) =>
      sse(res, [
        { type: 'response.output_text.delta', sequence_number: 1, item_id: 'm', output_index: 0, content_index: 0, delta: 'OK' },
        { type: 'response.completed', sequence_number: 2, response: completed }
      ])
    )
    const reports: UsageReport[] = []
    await new OpenAIProvider('key', 'gpt-5.6', 'gpt-5.4-mini', url).generate({ tier: 'fast', system: 's', messages: [{ role: 'user', content: 'x' }], onUsage: (r) => reports.push(r) })
    expect(reports).toEqual([{ provider: 'openai', model: 'gpt-5.4-mini', usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 2 } }])
  })

  it('Gemini generate() takes cached tokens out of input and counts thoughts as output', async () => {
    const { url } = await mock((_req, res) =>
      geminiSse(res, [
        { candidates: [{ content: { role: 'model', parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 2, thoughtsTokenCount: 40, cachedContentTokenCount: 10 } }
      ])
    )
    const reports: UsageReport[] = []
    await new GeminiProvider('key', 'gemini-3.1-pro-preview', 'gemini-3.5-flash', url).generate({ tier: 'quality', system: 's', messages: [{ role: 'user', content: 'x' }], onUsage: (r) => reports.push(r) })
    expect(reports).toEqual([{ provider: 'gemini', model: 'gemini-3.1-pro-preview', usage: { inputTokens: 20, outputTokens: 42, cacheReadTokens: 10 } }])
  })

  it('Ollama generate() reports its prompt and generated counts', async () => {
    const { url } = await mock((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'OK' }, done: true, done_reason: 'stop', prompt_eval_count: 15, eval_count: 2 }) + '\n')
    })
    const reports: UsageReport[] = []
    await new OllamaProvider(url, 'llama3.1').generate({ tier: 'fast', system: 's', messages: [{ role: 'user', content: 'x' }], onUsage: (r) => reports.push(r) })
    expect(reports).toEqual([{ provider: 'ollama', model: 'llama3.1', usage: { inputTokens: 15, outputTokens: 2 } }])
  })
})
