import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Store, toFtsQuery } from '../src/main/db/store'
import type { TranscriptChunk } from '@shared/types'

let store: Store

beforeEach(() => {
  store = new Store(openDatabase(':memory:'))
})

const chunk = (id: string, documentId: string, text: string, is_final = true): TranscriptChunk => ({
  id,
  document_id: documentId,
  source: 'system',
  text,
  start_timestamp: '2026-10-19T15:00:00.000Z',
  end_timestamp: '2026-10-19T15:00:02.000Z',
  is_final
})

describe('Store', () => {
  it('migrates and seeds built-in templates and recipes', () => {
    expect(store.db.pragma('user_version', { simple: true })).toBe(7)
    const slugs = store.listTemplates().map((t) => t.slug)
    expect(slugs).toEqual(expect.arrayContaining(['auto', 'one-on-one', 'stand-up', 'customer-call', 'interview', 'lecture']))
    expect(store.getTemplate('one-on-one')!.sections[0].heading).toBe('Check-in')
    expect(store.listRecipes().some((r) => r.slug === 'follow-up-email' && r.builtin)).toBe(true)
    // Re-seeding (next launch) is idempotent.
    new Store(store.db)
    expect(store.listTemplates().filter((t) => t.slug === 'auto')).toHaveLength(1)
  })

  it('creates, updates, lists and soft-deletes documents', () => {
    const event = { id: 'ev1', title: 'Acme sync', start: '2026-10-19T15:00:00Z', end: '2026-10-19T15:30:00Z', attendees: [{ name: 'Bo', email: 'bo@acme.com' }] }
    const doc = store.createDocument({ calendar_event: event })
    expect(doc.title).toBe('Acme sync')
    expect(doc.people).toHaveLength(1)
    expect(store.findDocumentForEvent('ev1')!.id).toBe(doc.id)

    const updated = store.updateDocument(doc.id, { notes_plain: 'pricing talk', notes_markdown: '- pricing talk', notes: { type: 'doc' } })
    expect(updated.notes).toEqual({ type: 'doc' })
    expect(store.listDocuments()[0]).toMatchObject({ id: doc.id, preview: 'pricing talk', has_transcript: false })

    store.deleteDocument(doc.id)
    expect(store.getDocument(doc.id)).toBeNull()
    expect(store.listDocuments()).toHaveLength(0)
  })

  it('stores the note mode, defaulting to meeting', () => {
    const meeting = store.createDocument({})
    expect(meeting.mode).toBe('meeting')
    const lecture = store.createDocument({ mode: 'lecture' })
    expect(store.getDocument(lecture.id)!.mode).toBe('lecture')
    expect(store.listDocuments().find((d) => d.id === lecture.id)!.mode).toBe('lecture')
    expect(store.updateDocument(meeting.id, { mode: 'lecture' }).mode).toBe('lecture')
    expect(() => store.db.prepare('UPDATE documents SET mode = ? WHERE id = ?').run('podcast', meeting.id)).toThrow()
  })

  it('upserts transcript chunks by id and finalizes', () => {
    const doc = store.createDocument({})
    store.upsertChunks([chunk('c1', doc.id, 'draft', false)])
    store.upsertChunks([chunk('c1', doc.id, 'Final text.', false), chunk('c2', doc.id, 'Second.')])
    store.upsertChunks([chunk('c3', doc.id, '  ')])
    expect(store.getTranscript(doc.id).map((c) => [c.id, c.text, c.is_final])).toEqual([
      ['c1', 'Final text.', false],
      ['c2', 'Second.', true]
    ])
    store.finalizeTranscript(doc.id)
    expect(store.getTranscript(doc.id).every((c) => c.is_final)).toBe(true)
    expect(store.listDocuments()[0].has_transcript).toBe(true)
  })

  it('stores diarized speakers on chunks and the names the user gave them on the note', () => {
    const doc = store.createDocument({})
    expect(doc.speakers).toEqual({})
    store.upsertChunks([{ ...chunk('c1', doc.id, 'Hi there', false), speaker: '1', speaker_session: 'r-system-0' }])
    store.upsertChunks([{ ...chunk('c1', doc.id, 'Hi there.'), speaker: '0', speaker_session: 'r-system-0' }, chunk('c2', doc.id, 'Plain.')])
    expect(store.getTranscript(doc.id).map((c) => [c.id, c.speaker, c.speaker_session])).toEqual([
      ['c1', '0', 'r-system-0'],
      ['c2', null, null]
    ])
    let updated = store.updateDocument(doc.id, { speakers: { 'system:r-system-0:0': { name: ' Alex ', email: 'alex@x.com' }, 'system:r-system-0:1': { name: 'Me', self: true } } })
    expect(updated.speakers).toEqual({ 'system:r-system-0:0': { name: 'Alex', email: 'alex@x.com' }, 'system:r-system-0:1': { name: 'Me', self: true } })
    updated = store.updateDocument(doc.id, { speakers: { 'system:r-system-0:1': null, system: { name: 'Them all' } } })
    expect(updated.speakers).toEqual({ 'system:r-system-0:0': { name: 'Alex', email: 'alex@x.com' }, system: { name: 'Them all' } })
    expect(store.updateDocument(doc.id, { speakers: { system: { name: '  ' } } }).speakers).toEqual({ 'system:r-system-0:0': { name: 'Alex', email: 'alex@x.com' } })
  })

  it('manages panels, folders and chat', () => {
    const doc = store.createDocument({ title: 'Weekly' })
    const panel = store.createPanel(doc.id, 'Summary', 'auto')
    store.updatePanel(panel.id, { content: '### A\n- b', generated_lines: ['A', 'b'], generation_finished_at: new Date().toISOString() })
    expect(store.listPanels(doc.id)[0]).toMatchObject({ content: '### A\n- b', generated_lines: ['A', 'b'] })

    const folder = store.createFolder('Clients')
    store.addToFolder(folder.id, doc.id)
    expect(store.listFolders()[0]).toMatchObject({ title: 'Clients', document_count: 1 })
    expect(store.listDocuments({ folderId: folder.id })).toHaveLength(1)
    expect(store.getDocument(doc.id)!.folder_ids).toEqual([folder.id])

    const thread = store.createThread(doc.id, 'q')
    store.addMessage(thread.id, 'user', 'What did we decide?')
    const reply = store.addMessage(thread.id, 'assistant', '')
    store.updateMessage(reply.id, { content: 'Ship it [1]', citations: [{ n: 1, document_id: doc.id, title: 'Weekly' }] })
    expect(store.listMessages(thread.id).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(store.listThreads(doc.id)).toHaveLength(1)
    expect(store.listThreads(null)).toHaveLength(0)
  })

  it('refuses to edit built-in templates but stores custom ones', () => {
    expect(() => store.upsertTemplate({ slug: 'auto', title: 'x', description: '', sections: [] })).toThrow()
    const t = store.upsertTemplate({ slug: 'board', title: 'Board meeting', description: 'Quarterly', sections: [{ heading: 'KPIs', section_description: 'Numbers' }] })
    expect(t.builtin).toBe(false)
    store.deleteTemplate('board')
    expect(store.getTemplate('board')).toBeNull()
  })

  it('full-text searches titles, notes, transcripts and panels', () => {
    const a = store.createDocument({ title: 'Acme renewal' })
    const b = store.createDocument({ title: 'Hiring sync' })
    store.updateDocument(b.id, { notes_plain: 'candidate pipeline' })
    store.upsertChunks([chunk('x', a.id, 'They want a discount on the enterprise plan')])
    store.finalizeTranscript(a.id)
    expect(store.search('enterprise discount').map((h) => h.document_id)).toEqual([a.id])
    expect(store.search('pipelin').map((h) => h.document_id)).toEqual([b.id])
    expect(store.search('acme')[0].document_id).toBe(a.id)
    expect(store.search('"); DROP TABLE documents; --')).toEqual([])
    expect(toFtsQuery('Hello, world!')).toBe('"hello"* OR "world"*')
  })

  it('stores calendar events in a window and settings as JSON', () => {
    store.replaceCalendarEvents(
      [{ id: 'e1', title: 'Standup', start: '2026-10-20T09:00:00.000Z', end: '2026-10-20T09:15:00.000Z', attendees: [] }],
      '2026-10-18T00:00:00.000Z',
      '2026-11-01T00:00:00.000Z'
    )
    expect(store.calendarEventsBetween('2026-10-20T00:00:00.000Z', '2026-10-21T00:00:00.000Z').map((e) => e.id)).toEqual(['e1'])
    store.setSetting('k', { a: 1 })
    expect(store.getSetting('k', null)).toEqual({ a: 1 })
  })
})
