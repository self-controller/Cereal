import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { migrate, openDatabase } from '../src/main/db'
import { MIGRATIONS } from '../src/main/db/migrations'
import { Store } from '../src/main/db/store'
import { AiService } from '../src/main/ai/service'
import { TranscriptSummaryService } from '../src/main/ai/transcriptSummary'
import { generatedDecorations } from '@shared/generatedLines'
import { docToMarkdown, markdownLineText, markdownToDoc, parseLines, type PMNode } from '@shared/markdown'
import { generatedLineTexts } from '@shared/attribution'
import { findInChunks } from '@shared/transcript'
import { NO_CONTEXT, canExplainLine, matchQuote, parseSummary, selectTranscriptChunks } from '@shared/transcriptSummary'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { TranscriptSummaryUpdate } from '@shared/ipc'
import type { GenerateOptions, LlmProvider } from '../src/main/llm/provider'
import type { Panel, TranscriptChunk } from '@shared/types'

const schema = getSchema([StarterKit.configure({ heading: { levels: [1, 2, 3] } }), TaskList, TaskItem.configure({ nested: true })])

const t0 = Date.parse('2026-10-19T15:00:00.000Z')
function chunk(id: string, startS: number, text: string, opts: Partial<TranscriptChunk> = {}): TranscriptChunk {
  return {
    id,
    document_id: 'd1',
    source: 'system',
    text,
    start_timestamp: new Date(t0 + startS * 1000).toISOString(),
    end_timestamp: new Date(t0 + (startS + 3) * 1000).toISOString(),
    is_final: true,
    ...opts
  }
}

const NOTES = [
  '### Budget',
  '- Pilot budget is **$50k**',
  '  - Legal must approve the [data agreement](https://example.com) by Friday',
  '- [ ] Send the contract draft',
  '- [x] Book the room',
  '',
  '1. First step',
  '2. Second `step`',
  '',
  '> A quoted line',
  '',
  '```',
  'code here',
  '```',
  '',
  '---',
  '',
  '#### Deep heading',
  'A closing paragraph with *emphasis* and ~~strike~~.'
].join('\n')

function texts(node: PMNode, out: string[] = []): string[] {
  if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'codeBlock') {
    out.push((node.content ?? []).map((n) => n.text ?? '').join(''))
    return out
  }
  node.content?.forEach((c) => texts(c, out))
  return out
}

describe('markdownToDoc', () => {
  it('produces a document the note editor schema accepts', () => {
    const doc = markdownToDoc(NOTES)
    expect(() => schema.nodeFromJSON(doc).check()).not.toThrow()
    expect(doc.content!.map((n) => n.type)).toEqual(['heading', 'bulletList', 'taskList', 'orderedList', 'blockquote', 'codeBlock', 'horizontalRule', 'heading', 'paragraph'])
    // The nested bullet sits inside the first item; the deep heading is clamped to h3.
    expect(doc.content![1].content![0].content![1].type).toBe('bulletList')
    expect(doc.content![7].attrs).toEqual({ level: 3 })
    expect(doc.content![2].content!.map((i) => i.attrs?.checked)).toEqual([false, true])
  })

  it('gives every line the text markdownLineText predicts', () => {
    const expected = parseLines(NOTES)
      .map(markdownLineText)
      .filter(Boolean)
    expect(texts(markdownToDoc(NOTES)).map((t) => t.trim())).toEqual(expected)
  })

  it('round-trips through Markdown without drifting', () => {
    const once = docToMarkdown(markdownToDoc(NOTES))
    expect(docToMarkdown(markdownToDoc(once))).toBe(once)
    expect(once).toContain('- [ ] Send the contract draft')
    expect(once).toContain('**$50k**')
  })

  it('handles empty input and four-space indents', () => {
    expect(markdownToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] })
    const doc = markdownToDoc('- a\n    - b\n- c')
    expect(doc.content![0].content!.length).toBe(2)
    expect(doc.content![0].content![0].content![1].type).toBe('bulletList')
  })
})

describe('generated lines', () => {
  it('turns line indices into editor texts', () => {
    expect(generatedLineTexts('### A\n- **b** c\n\n- typed', [0, 1, 2])).toEqual(['A', 'b c'])
  })

  it('marks paragraphs and headings whose text was written by the AI', () => {
    const node = schema.nodeFromJSON(markdownToDoc('### Budget\n- Pilot budget is $50k\n- my own line'))
    const generated = new Set(['Budget', 'Pilot budget is $50k'])
    const found = generatedDecorations(node, (t) => generated.has(t))
      .find()
      .map((d) => node.nodeAt(d.from)?.textContent)
    expect(found).toEqual(['Budget', 'Pilot budget is $50k'])
  })
})

describe('Transcript Summary helpers', () => {
  const chunks = [
    chunk('c1', 0, 'Thanks for joining everyone.'),
    chunk('c2', 4, 'The pilot budget is fifty thousand dollars for the quarter.', { source: 'microphone' }),
    chunk('c3', 8, 'Legal has to approve the data agreement by Friday,'),
    chunk('c4', 11, 'otherwise we slip to Q4.'),
    chunk('c5', 15, 'interim words', { is_final: false })
  ]

  it('only explains lines with words in them', () => {
    expect(canExplainLine('Budget')).toBe(true)
    expect(canExplainLine(' x ')).toBe(false)
    expect(canExplainLine('—!')).toBe(false)
  })

  it('splits a reply into text and quotes', () => {
    const reply = ['Legal set a deadline.', '> [00:08] Them: Legal has to approve the data agreement by Friday,', '"otherwise we slip to Q4 and lose the whole pilot window here"', 'A short "quote" stays text.'].join('\n')
    expect(parseSummary(reply, false)).toEqual({
      noContext: false,
      parts: [
        { kind: 'text', text: 'Legal set a deadline.' },
        { kind: 'quote', text: 'Legal has to approve the data agreement by Friday,' },
        { kind: 'quote', text: 'otherwise we slip to Q4 and lose the whole pilot window here' },
        { kind: 'text', text: 'A short "quote" stays text.' }
      ]
    })
    // While streaming, the last (incomplete) line waits.
    expect(parseSummary('First line.\nSecond li', true).parts).toEqual([{ kind: 'text', text: 'First line.' }])
    expect(parseSummary(NO_CONTEXT, false)).toEqual({ parts: [], noContext: true })
    expect(parseSummary('NO_CON', true)).toEqual({ parts: [], noContext: false })
  })

  it('matches quotes to the chunks they came from, across chunks and despite small changes', () => {
    expect(matchQuote('Legal has to approve the data agreement by Friday', chunks)).toMatchObject({ chunkIds: ['c3'], score: 1 })
    expect(matchQuote('legal has to approve the data agreement by friday otherwise we slip to Q4', chunks)?.chunkIds).toEqual(['c3', 'c4'])
    expect(matchQuote('The pilot budget is 50 thousand dollars for this quarter', chunks)?.chunkIds).toEqual(['c2'])
    expect(matchQuote('Completely unrelated sentence about lunch plans', chunks)).toBeNull()
    expect(matchQuote('interim words', chunks)).toBeNull()
  })

  it('keeps the turns that relate to the line when the transcript is over budget', () => {
    expect(selectTranscriptChunks(chunks, 'anything', 10_000).map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4'])
    const long = Array.from({ length: 40 }, (_, i) => chunk(`l${i}`, i * 100, i === 30 ? 'We agreed the budget is fifty thousand.' : `Filler sentence number ${i} about nothing much.`, { source: i % 2 ? 'microphone' : 'system' }))
    const picked = selectTranscriptChunks(long, 'Budget is fifty thousand', 300).map((c) => c.id)
    expect(picked).toContain('l30')
    expect(picked.length).toBeLessThan(10)
    expect(picked).toEqual([...picked].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))))
  })

  it('finds text in the transcript, in order', () => {
    expect(findInChunks(chunks, 'the')).toEqual([
      { chunkId: 'c2', start: 0, end: 3 },
      { chunkId: 'c2', start: 47, end: 50 },
      { chunkId: 'c3', start: 21, end: 24 },
      { chunkId: 'c4', start: 1, end: 4 }
    ])
    expect(findInChunks(chunks, '  ')).toEqual([])
  })
})

describe('panel storage', () => {
  it('migrates index-based generated lines to texts', () => {
    const db = new Database(':memory:')
    for (const m of MIGRATIONS.slice(0, 4)) db.exec(m as string)
    db.pragma('user_version = 4')
    db.prepare(`INSERT INTO documents (id, created_at, updated_at) VALUES ('d', 'x', 'x')`).run()
    db.prepare(
      `INSERT INTO document_panels (id, document_id, title, template_slug, content, generated_lines, created_at, updated_at, generation_finished_at)
       VALUES ('p', 'd', 'Summary', 'auto', ?, '[0,2]', 'x', 'x', 'x')`
    ).run('### Budget\n- typed by me\n- added by **AI**')
    migrate(db)
    const store = new Store(db)
    const panel = store.getPanel('p')!
    expect(panel.generated_lines).toEqual(['Budget', 'added by AI'])
    // Unedited panels get their editor JSON from the Markdown.
    expect(panel.content_json?.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 3 } })
  })
})

class FakeProvider implements LlmProvider {
  readonly id = 'anthropic' as const
  calls: GenerateOptions[] = []
  constructor(
    private readonly reply: (opts: GenerateOptions) => string,
    readonly maxInputChars = 1_000_000
  ) {}
  async generate(opts: GenerateOptions): Promise<string> {
    this.calls.push(opts)
    const text = this.reply(opts)
    for (const part of text.match(/.{1,7}/gs) ?? []) {
      if (opts.signal?.aborted) throw new Error('aborted')
      opts.onText?.(part)
      await new Promise((r) => setTimeout(r, 1))
    }
    return text
  }
  async step(): Promise<never> {
    throw new Error('not used')
  }
  async listModels(): Promise<string[]> {
    return []
  }
}

describe('editing and explaining enhanced notes', () => {
  let store: Store
  let docId: string
  const settings = { get: () => DEFAULT_SETTINGS } as never
  beforeEach(() => {
    store = new Store(openDatabase(':memory:'))
    docId = store.createDocument({ title: 'Acme' }).id
    store.updateDocument(docId, { notes_markdown: '- budget 50k', notes_plain: 'budget 50k' })
    store.upsertChunks([
      { ...chunk('a', 0, 'Our budget is fifty thousand.', { source: 'microphone' }), document_id: docId },
      { ...chunk('b', 4, 'Legal has to approve the data agreement by Friday.'), document_id: docId }
    ])
  })

  async function enhanced(ai: AiService): Promise<Panel> {
    const panel = ai.enhance(docId, 'auto')
    await vi.waitFor(() => expect(store.getPanel(panel.id)!.generation_finished_at).not.toBeNull())
    return store.getPanel(panel.id)!
  }

  it('saves edits as JSON and Markdown, makes them searchable, and refuses them mid-generation', async () => {
    const ai = new AiService({ store, settings, provider: () => new FakeProvider(() => '### Budget\n- Budget 50k\n- Legal approves by Friday'), emitPanel: () => undefined, emitDocumentChanged: () => undefined })
    const panel = await enhanced(ai)
    expect(panel.content_json).toEqual(markdownToDoc(panel.content))
    expect(panel.generated_lines).toEqual(['Budget', 'Legal approves by Friday'])

    const edited = markdownToDoc('### Budget\n- Budget 50k\n- Legal approves by Thursday, says zanzibar')
    const saved = ai.saveEdit(panel.id, edited)
    expect(saved.content).toContain('Legal approves by Thursday, says zanzibar')
    expect(saved.content_json).toEqual(edited)
    expect(store.search('zanzibar').length).toBe(1)

    ai.rewrite(panel.id, 'shorter')
    expect(() => ai.saveEdit(panel.id, edited)).toThrow(/still being written/)
  })

  it('rewrites from the edited notes and keeps lines the user wrote black', async () => {
    let reply = '### Budget\n- Budget 50k\n- Legal approves by Friday'
    const provider = new FakeProvider(() => reply)
    const ai = new AiService({ store, settings, provider: () => provider, emitPanel: () => undefined, emitDocumentChanged: () => undefined })
    const panel = await enhanced(ai)
    ai.saveEdit(panel.id, markdownToDoc('### Budget\n- Budget 50k\n- Legal approves by Friday\n- My own addition about hiring'))
    reply = '### Budget\n- Budget 50k\n- My own addition about hiring\n- New AI point'
    ai.rewrite(panel.id, 'shorter')
    await vi.waitFor(() => expect(store.getPanel(panel.id)!.generation_finished_at).not.toBeNull())
    const prompt = provider.calls[provider.calls.length - 1].messages[0].content
    expect(prompt).toContain('<current_notes>')
    expect(prompt).toContain('My own addition about hiring')
    expect(store.getPanel(panel.id)!.generated_lines).toEqual(['Budget', 'New AI point'])
  })

  it('streams a Transcript Summary for one line, and can be cancelled', async () => {
    const updates: TranscriptSummaryUpdate[] = []
    const provider = new FakeProvider(() => 'Legal set a Friday deadline.\n> Legal has to approve the data agreement by Friday.')
    const service = new TranscriptSummaryService({ store, settings, provider: () => provider, emit: (u) => updates.push(u) })
    service.start('r1', docId, 'Legal approves by Friday')
    await vi.waitFor(() => expect(updates.some((u) => u.done)).toBe(true))
    const call = provider.calls[0]
    expect(call.tier).toBe('fast')
    expect(call.messages[0].content).toContain('Legal approves by Friday')
    expect(call.messages[0].content).toContain('Them: Legal has to approve the data agreement by Friday.')
    const last = updates[updates.length - 1]
    expect(last).toMatchObject({ requestId: 'r1', done: true, error: null })
    expect(parseSummary(last.text, false).parts[1]).toEqual({ kind: 'quote', text: 'Legal has to approve the data agreement by Friday.' })

    const before = updates.length
    service.start('r2', docId, 'Budget 50k')
    service.cancel('r2')
    await new Promise((r) => setTimeout(r, 120))
    expect(provider.calls[1].signal?.aborted).toBe(true)
    expect(updates.slice(before).some((u) => u.done)).toBe(false)
  })

  it('refuses to explain a note without a transcript', () => {
    const empty = store.createDocument({ title: 'Empty' }).id
    const service = new TranscriptSummaryService({ store, settings, provider: () => new FakeProvider(() => ''), emit: () => undefined })
    expect(() => service.start('r', empty, 'line')).toThrow(/no transcript/)
  })
})
