import { randomUUID } from 'node:crypto'
import type { DB } from './index'
import type {
  Attendee,
  CalendarEvent,
  CerealDocument,
  ChatAttachment,
  ChatCitation,
  ChatMessage,
  ChatMessageContext,
  ChatThread,
  DocumentPatch,
  DocumentSummary,
  Folder,
  NoteMode,
  Panel,
  Recipe,
  SearchHit,
  SpeakerAssignment,
  Template,
  TemplateSection,
  TranscriptChunk
} from '@shared/types'
import type { AgentOutput, MessageStatus } from '@shared/agent'
import { BUILTIN_RECIPES, BUILTIN_TEMPLATES } from '@shared/defaults'
import { formatTranscript } from '@shared/transcript'
import { markdownToDoc, type PMNode } from '@shared/markdown'

const now = (): string => new Date().toISOString()

function parse<T>(json: string | null | undefined, fallback: T): T {
  if (json == null || json === '') return fallback
  try {
    return JSON.parse(json) as T
  } catch {
    return fallback
  }
}

interface DocumentRow {
  id: string
  title: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  notes: string | null
  notes_plain: string
  notes_markdown: string
  calendar_event: string | null
  people: string
  selected_template: string | null
  mode: NoteMode
  speakers: string
}

interface PanelRow {
  id: string
  document_id: string
  title: string
  template_slug: string
  content: string
  content_json: string | null
  generated_lines: string
  created_at: string
  updated_at: string
  generation_started_at: string | null
  generation_finished_at: string | null
  generation_failed_at: string | null
  error: string | null
}

interface ChunkRow extends Omit<TranscriptChunk, 'is_final'> {
  is_final: number
}

/** All persistence for Cereal. Synchronous (better-sqlite3); safe to call from the main process. */
export class Store {
  constructor(readonly db: DB) {
    this.seedBuiltins()
  }

  // ---------------------------------------------------------------- documents

  private toDocument(row: DocumentRow): CerealDocument {
    return {
      id: row.id,
      title: row.title,
      created_at: row.created_at,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at,
      notes: parse(row.notes, null),
      notes_plain: row.notes_plain,
      notes_markdown: row.notes_markdown,
      calendar_event: parse<CalendarEvent | null>(row.calendar_event, null),
      people: parse<Attendee[]>(row.people, []),
      selected_template: row.selected_template,
      mode: row.mode,
      folder_ids: this.folderIdsFor(row.id),
      speakers: parse<Record<string, SpeakerAssignment>>(row.speakers, {})
    }
  }

  private folderIdsFor(documentId: string): string[] {
    return (this.db.prepare('SELECT folder_id FROM folder_documents WHERE document_id = ?').all(documentId) as { folder_id: string }[]).map(
      (r) => r.folder_id
    )
  }

  listDocuments(query: { folderId?: string | null; limit?: number } = {}): DocumentSummary[] {
    const limit = query.limit ?? 500
    const rows = (
      query.folderId
        ? this.db
            .prepare(
              `SELECT d.* FROM documents d JOIN folder_documents f ON f.document_id = d.id
               WHERE f.folder_id = ? AND d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT ?`
            )
            .all(query.folderId, limit)
        : this.db.prepare('SELECT * FROM documents WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?').all(limit)
    ) as DocumentRow[]
    const hasTranscript = this.db.prepare('SELECT 1 FROM transcript_chunks WHERE document_id = ? LIMIT 1')
    const hasPanels = this.db.prepare('SELECT 1 FROM document_panels WHERE document_id = ? LIMIT 1')
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      created_at: r.created_at,
      updated_at: r.updated_at,
      calendar_event: parse<CalendarEvent | null>(r.calendar_event, null),
      folder_ids: this.folderIdsFor(r.id),
      mode: r.mode,
      has_transcript: !!hasTranscript.get(r.id),
      has_panels: !!hasPanels.get(r.id),
      preview: r.notes_plain.slice(0, 160)
    }))
  }

  getDocument(id: string): CerealDocument | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(id) as DocumentRow | undefined
    return row ? this.toDocument(row) : null
  }

  createDocument(init: { title?: string; calendar_event?: CalendarEvent | null; folder_id?: string | null; created_at?: string; mode?: NoteMode } = {}): CerealDocument {
    const id = randomUUID()
    const ts = init.created_at ?? now()
    const event = init.calendar_event ?? null
    this.db
      .prepare(
        `INSERT INTO documents (id, title, created_at, updated_at, calendar_event, people, mode)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, init.title ?? event?.title ?? '', ts, ts, event ? JSON.stringify(event) : null, JSON.stringify(event?.attendees ?? []), init.mode ?? 'meeting')
    if (init.folder_id) this.addToFolder(init.folder_id, id)
    this.reindex(id)
    return this.getDocument(id)!
  }

  findDocumentForEvent(eventId: string): CerealDocument | null {
    const row = this.db
      .prepare(`SELECT * FROM documents WHERE json_extract(calendar_event, '$.id') = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`)
      .get(eventId) as DocumentRow | undefined
    return row ? this.toDocument(row) : null
  }

  updateDocument(id: string, patch: DocumentPatch): CerealDocument {
    const sets: string[] = []
    const values: unknown[] = []
    const json = (v: unknown): string | null => (v == null ? null : JSON.stringify(v))
    if (patch.title !== undefined) sets.push('title = ?'), values.push(patch.title)
    if (patch.notes !== undefined) sets.push('notes = ?'), values.push(json(patch.notes))
    if (patch.notes_plain !== undefined) sets.push('notes_plain = ?'), values.push(patch.notes_plain)
    if (patch.notes_markdown !== undefined) sets.push('notes_markdown = ?'), values.push(patch.notes_markdown)
    if (patch.calendar_event !== undefined) sets.push('calendar_event = ?'), values.push(json(patch.calendar_event))
    if (patch.people !== undefined) sets.push('people = ?'), values.push(JSON.stringify(patch.people))
    if (patch.selected_template !== undefined) sets.push('selected_template = ?'), values.push(patch.selected_template)
    if (patch.mode !== undefined) sets.push('mode = ?'), values.push(patch.mode)
    if (patch.speakers !== undefined) sets.push('speakers = ?'), values.push(JSON.stringify(this.mergeSpeakers(id, patch.speakers)))
    if (sets.length) {
      sets.push('updated_at = ?')
      values.push(now(), id)
      this.db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...values)
      this.reindex(id)
    }
    const doc = this.getDocument(id)
    if (!doc) throw new Error(`Document ${id} not found`)
    return doc
  }

  private mergeSpeakers(id: string, patch: Record<string, SpeakerAssignment | null>): Record<string, SpeakerAssignment> {
    const row = this.db.prepare('SELECT speakers FROM documents WHERE id = ?').get(id) as { speakers: string } | undefined
    const merged = parse<Record<string, SpeakerAssignment>>(row?.speakers ?? null, {})
    for (const [key, value] of Object.entries(patch)) {
      const name = value?.name.trim()
      if (name) merged[key] = { name, ...(value!.email ? { email: value!.email } : {}), ...(value!.self ? { self: true } : {}) }
      else delete merged[key]
    }
    return merged
  }

  deleteDocument(id: string): void {
    this.db.prepare('UPDATE documents SET deleted_at = ? WHERE id = ?').run(now(), id)
    this.db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(id)
  }

  // --------------------------------------------------------------- transcript

  getTranscript(documentId: string): TranscriptChunk[] {
    const rows = this.db
      .prepare('SELECT * FROM transcript_chunks WHERE document_id = ? ORDER BY start_timestamp, end_timestamp, id')
      .all(documentId) as ChunkRow[]
    return rows.map((r) => ({ ...r, is_final: !!r.is_final }))
  }

  /** Persist chunks (upsert by id). Empty-text chunks are deleted. */
  upsertChunks(chunks: TranscriptChunk[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO transcript_chunks (id, document_id, source, text, start_timestamp, end_timestamp, is_final, speaker, speaker_session)
       VALUES (@id, @document_id, @source, @text, @start_timestamp, @end_timestamp, @is_final, @speaker, @speaker_session)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text, start_timestamp = excluded.start_timestamp,
         end_timestamp = excluded.end_timestamp, is_final = excluded.is_final, speaker = excluded.speaker,
         speaker_session = excluded.speaker_session`
    )
    const del = this.db.prepare('DELETE FROM transcript_chunks WHERE id = ?')
    this.db.transaction(() => {
      for (const c of chunks) {
        if (c.text.trim()) upsert.run({ ...c, is_final: c.is_final ? 1 : 0, speaker: c.speaker ?? null, speaker_session: c.speaker_session ?? null })
        else del.run(c.id)
      }
    })()
  }

  finalizeTranscript(documentId: string): void {
    this.db.prepare('UPDATE transcript_chunks SET is_final = 1 WHERE document_id = ?').run(documentId)
    this.reindex(documentId)
  }

  clearTranscript(documentId: string): void {
    this.db.prepare('DELETE FROM transcript_chunks WHERE document_id = ?').run(documentId)
    this.reindex(documentId)
  }

  // ------------------------------------------------------------------- panels

  private toPanel(r: PanelRow): Panel {
    const generated = parse<unknown[]>(r.generated_lines, [])
    const finished = !!(r.generation_finished_at || r.generation_failed_at)
    // Unedited panels keep only Markdown; deriving the JSON on read lets converter fixes reach old notes.
    const json = parse<PMNode | null>(r.content_json, null) ?? (finished && r.content ? markdownToDoc(r.content) : null)
    return { ...r, content_json: json, generated_lines: Array.isArray(generated) ? generated.filter((t): t is string => typeof t === 'string') : [] }
  }

  listPanels(documentId: string): Panel[] {
    return (this.db.prepare('SELECT * FROM document_panels WHERE document_id = ? ORDER BY created_at').all(documentId) as PanelRow[]).map((r) =>
      this.toPanel(r)
    )
  }

  getPanel(id: string): Panel | null {
    const r = this.db.prepare('SELECT * FROM document_panels WHERE id = ?').get(id) as PanelRow | undefined
    return r ? this.toPanel(r) : null
  }

  createPanel(documentId: string, title: string, templateSlug: string): Panel {
    const id = randomUUID()
    const ts = now()
    this.db
      .prepare(
        `INSERT INTO document_panels (id, document_id, title, template_slug, created_at, updated_at, generation_started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, documentId, title, templateSlug, ts, ts, ts)
    return this.getPanel(id)!
  }

  updatePanel(id: string, patch: Partial<Omit<Panel, 'id' | 'document_id' | 'created_at'>>): Panel {
    const cols = Object.keys(patch) as (keyof typeof patch)[]
    if (cols.length) {
      const values = cols.map((c) => (c === 'generated_lines' || c === 'content_json' ? (patch[c] == null ? null : JSON.stringify(patch[c])) : patch[c]))
      this.db
        .prepare(`UPDATE document_panels SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, now(), id)
    }
    const panel = this.getPanel(id)
    if (!panel) throw new Error(`Panel ${id} not found`)
    if (patch.content !== undefined && (patch.generation_finished_at || patch.content_json)) this.reindex(panel.document_id)
    return panel
  }

  deletePanel(id: string): void {
    const panel = this.getPanel(id)
    this.db.prepare('DELETE FROM document_panels WHERE id = ?').run(id)
    if (panel) this.reindex(panel.document_id)
  }

  // ------------------------------------------------------------------ folders

  listFolders(): Folder[] {
    return this.db
      .prepare(
        `SELECT f.id, f.title, f.created_at, COUNT(d.id) AS document_count
         FROM folders f
         LEFT JOIN folder_documents fd ON fd.folder_id = f.id
         LEFT JOIN documents d ON d.id = fd.document_id AND d.deleted_at IS NULL
         GROUP BY f.id ORDER BY f.title COLLATE NOCASE`
      )
      .all() as Folder[]
  }

  createFolder(title: string): Folder {
    const id = randomUUID()
    this.db.prepare('INSERT INTO folders (id, title, created_at) VALUES (?, ?, ?)').run(id, title.trim() || 'Untitled folder', now())
    return this.listFolders().find((f) => f.id === id)!
  }

  renameFolder(id: string, title: string): void {
    this.db.prepare('UPDATE folders SET title = ? WHERE id = ?').run(title.trim() || 'Untitled folder', id)
  }

  deleteFolder(id: string): void {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(id)
  }

  addToFolder(folderId: string, documentId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO folder_documents (folder_id, document_id, added_at) VALUES (?, ?, ?)').run(folderId, documentId, now())
  }

  removeFromFolder(folderId: string, documentId: string): void {
    this.db.prepare('DELETE FROM folder_documents WHERE folder_id = ? AND document_id = ?').run(folderId, documentId)
  }

  // ---------------------------------------------------------------- templates

  private seedBuiltins(): void {
    const ts = now()
    const tpl = this.db.prepare(
      `INSERT INTO templates (slug, title, description, sections, builtin, updated_at) VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(slug) DO UPDATE SET title = excluded.title, description = excluded.description,
         sections = excluded.sections, updated_at = excluded.updated_at WHERE templates.builtin = 1`
    )
    const recipe = this.db.prepare(
      `INSERT INTO recipes (id, slug, name, prompt, description, builtin, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, prompt = excluded.prompt, description = excluded.description
       WHERE recipes.builtin = 1`
    )
    this.db.transaction(() => {
      for (const t of BUILTIN_TEMPLATES) tpl.run(t.slug, t.title, t.description, JSON.stringify(t.sections), ts)
      for (const r of BUILTIN_RECIPES) recipe.run(`builtin-${r.slug}`, r.slug, r.name, r.prompt, r.description, ts)
    })()
  }

  listTemplates(): Template[] {
    const rows = this.db.prepare('SELECT * FROM templates ORDER BY builtin DESC, title COLLATE NOCASE').all() as (Omit<Template, 'sections' | 'builtin'> & {
      sections: string
      builtin: number
    })[]
    return rows.map((r) => ({ ...r, sections: parse<TemplateSection[]>(r.sections, []), builtin: !!r.builtin }))
  }

  getTemplate(slug: string): Template | null {
    return this.listTemplates().find((t) => t.slug === slug) ?? null
  }

  upsertTemplate(t: Omit<Template, 'builtin' | 'updated_at'>): Template {
    const existing = this.getTemplate(t.slug)
    if (existing?.builtin) throw new Error('Built-in templates cannot be edited; duplicate it instead.')
    this.db
      .prepare(
        `INSERT INTO templates (slug, title, description, sections, builtin, updated_at) VALUES (?, ?, ?, ?, 0, ?)
         ON CONFLICT(slug) DO UPDATE SET title = excluded.title, description = excluded.description,
           sections = excluded.sections, updated_at = excluded.updated_at`
      )
      .run(t.slug, t.title, t.description, JSON.stringify(t.sections), now())
    return this.getTemplate(t.slug)!
  }

  deleteTemplate(slug: string): void {
    this.db.prepare('DELETE FROM templates WHERE slug = ? AND builtin = 0').run(slug)
  }

  // ------------------------------------------------------------------ recipes

  listRecipes(): Recipe[] {
    return (this.db.prepare('SELECT * FROM recipes ORDER BY builtin DESC, name COLLATE NOCASE').all() as (Omit<Recipe, 'builtin'> & { builtin: number })[]).map(
      (r) => ({ ...r, builtin: !!r.builtin })
    )
  }

  upsertRecipe(r: { id?: string; name: string; slug: string; prompt: string; description?: string }): Recipe {
    const id = r.id ?? randomUUID()
    const slug = r.slug.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || id.slice(0, 8)
    this.db
      .prepare(
        `INSERT INTO recipes (id, slug, name, prompt, description, builtin, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, prompt = excluded.prompt,
           description = excluded.description, updated_at = excluded.updated_at`
      )
      .run(id, slug, r.name, r.prompt, r.description ?? '', now())
    return this.listRecipes().find((x) => x.id === id)!
  }

  /** Count a use of a recipe, for the recipe menu's "Recent" section and ranking. */
  recordRecipeUse(id: string): void {
    this.db.prepare('UPDATE recipes SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?').run(now(), id)
  }

  deleteRecipe(id: string): void {
    this.db.prepare('DELETE FROM recipes WHERE id = ? AND builtin = 0').run(id)
  }

  // --------------------------------------------------------------------- chat

  listThreads(documentId: string | null): ChatThread[] {
    return (
      documentId
        ? this.db.prepare('SELECT * FROM chat_threads WHERE document_id = ? ORDER BY updated_at DESC').all(documentId)
        : this.db.prepare('SELECT * FROM chat_threads WHERE document_id IS NULL ORDER BY updated_at DESC').all()
    ) as ChatThread[]
  }

  getThread(id: string): ChatThread | null {
    return (this.db.prepare('SELECT * FROM chat_threads WHERE id = ?').get(id) as ChatThread | undefined) ?? null
  }

  createThread(documentId: string | null, title: string, model: string | null = null): ChatThread {
    const id = randomUUID()
    const ts = now()
    this.db
      .prepare('INSERT INTO chat_threads (id, document_id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, documentId, title, model, ts, ts)
    return this.getThread(id)!
  }

  updateThread(id: string, patch: { title?: string; model?: string | null }): ChatThread | null {
    if (patch.title !== undefined) this.db.prepare('UPDATE chat_threads SET title = ? WHERE id = ?').run(patch.title, id)
    if (patch.model !== undefined) this.db.prepare('UPDATE chat_threads SET model = ? WHERE id = ?').run(patch.model, id)
    return this.getThread(id)
  }

  deleteThread(id: string): void {
    this.db.prepare('DELETE FROM chat_threads WHERE id = ?').run(id)
  }

  private toMessage(
    r: Omit<ChatMessage, 'citations' | 'outputs' | 'attachments' | 'context'> & { citations: string; outputs: string; context: string | null },
    attachments: ChatAttachment[]
  ): ChatMessage {
    return {
      ...r,
      citations: parse<ChatCitation[]>(r.citations, []),
      outputs: parse<AgentOutput[]>(r.outputs, []),
      context: parse<ChatMessageContext | null>(r.context, null),
      attachments
    }
  }

  listMessages(threadId: string): ChatMessage[] {
    const rows = this.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as Parameters<Store['toMessage']>[0][]
    const byMessage = new Map<string, ChatAttachment[]>()
    for (const a of this.threadAttachments(threadId)) if (a.message_id) byMessage.set(a.message_id, [...(byMessage.get(a.message_id) ?? []), a])
    return rows.map((r) => this.toMessage(r, byMessage.get(r.id) ?? []))
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(id) as Parameters<Store['toMessage']>[0] | undefined
    return row ? this.toMessage(row, this.messageAttachments(id)) : null
  }

  addMessage(
    threadId: string,
    role: ChatMessage['role'],
    content: string,
    status: MessageStatus = 'completed',
    extra: { id?: string; context?: ChatMessageContext | null } = {}
  ): ChatMessage {
    const id = extra.id ?? randomUUID()
    const ts = now()
    this.db
      .prepare('INSERT INTO chat_messages (id, thread_id, role, content, status, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, threadId, role, content, status, extra.context ? JSON.stringify(extra.context) : null, ts)
    this.db.prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(ts, threadId)
    return this.getMessage(id)!
  }

  /** Delete a message and everything after it in its thread (editing a sent message). Returns the deleted ids. */
  truncateThreadFrom(threadId: string, messageId: string): string[] {
    const messages = this.listMessages(threadId)
    const at = messages.findIndex((m) => m.id === messageId)
    if (at < 0) return []
    const ids = messages.slice(at).map((m) => m.id)
    const del = this.db.prepare('DELETE FROM chat_messages WHERE id = ?')
    this.db.transaction(() => ids.forEach((id) => del.run(id)))()
    return ids
  }

  // -------------------------------------------------------------- attachments

  private toAttachment(r: ChatAttachment & { sha256?: string; document_id?: string | null }): ChatAttachment {
    const { sha256: _sha, document_id: _doc, ...rest } = r
    return rest
  }

  createAttachment(a: { id: string; documentId: string | null; name: string; mime: string; kind: ChatAttachment['kind']; size: number; sha256: string }): ChatAttachment {
    this.db
      .prepare(
        `INSERT INTO chat_attachments (id, document_id, name, mime, kind, size, sha256, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'processing', ?)`
      )
      .run(a.id, a.documentId, a.name, a.mime, a.kind, a.size, a.sha256, now())
    return this.getAttachment(a.id)!
  }

  getAttachment(id: string): ChatAttachment | null {
    const r = this.db.prepare('SELECT * FROM chat_attachments WHERE id = ?').get(id) as Parameters<Store['toAttachment']>[0] | undefined
    return r ? this.toAttachment(r) : null
  }

  attachmentSha(id: string): string | null {
    return (this.db.prepare('SELECT sha256 FROM chat_attachments WHERE id = ?').get(id) as { sha256: string } | undefined)?.sha256 ?? null
  }

  updateAttachment(id: string, patch: Partial<Pick<ChatAttachment, 'status' | 'error' | 'pages' | 'text_chars' | 'size' | 'mime'>>): ChatAttachment | null {
    const cols = Object.keys(patch) as (keyof typeof patch)[]
    if (cols.length) this.db.prepare(`UPDATE chat_attachments SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map((c) => patch[c] ?? null), id)
    return this.getAttachment(id)
  }

  /** Attach draft files to the user message that carries them. */
  bindAttachments(ids: string[], threadId: string, messageId: string): void {
    const bind = this.db.prepare('UPDATE chat_attachments SET thread_id = ?, message_id = ? WHERE id = ?')
    this.db.transaction(() => ids.forEach((id) => bind.run(threadId, messageId, id)))()
  }

  threadAttachments(threadId: string): ChatAttachment[] {
    const rows = this.db.prepare('SELECT * FROM chat_attachments WHERE thread_id = ? ORDER BY created_at, rowid').all(threadId) as Parameters<Store['toAttachment']>[0][]
    return rows.map((r) => this.toAttachment(r))
  }

  messageAttachments(messageId: string): ChatAttachment[] {
    const rows = this.db.prepare('SELECT * FROM chat_attachments WHERE message_id = ? ORDER BY created_at, rowid').all(messageId) as Parameters<Store['toAttachment']>[0][]
    return rows.map((r) => this.toAttachment(r))
  }

  deleteAttachment(id: string): void {
    this.db.prepare('DELETE FROM chat_attachments WHERE id = ?').run(id)
  }

  /** Draft attachments never sent (the bar was closed, or Cereal quit), older than `before`. */
  staleDraftAttachments(before: string): string[] {
    return (this.db.prepare('SELECT id FROM chat_attachments WHERE message_id IS NULL AND created_at < ?').all(before) as { id: string }[]).map((r) => r.id)
  }

  /** Attachment ids whose rows are gone (their thread was deleted), from a list of ids found on disk. */
  missingAttachments(ids: string[]): string[] {
    const has = this.db.prepare('SELECT 1 FROM chat_attachments WHERE id = ?')
    return ids.filter((id) => !has.get(id))
  }

  uploads(attachmentId: string): Record<string, { remoteId: string; uri: string | null; expiresAt: string | null }> {
    const rows = this.db.prepare('SELECT provider, remote_id, uri, expires_at FROM chat_attachment_uploads WHERE attachment_id = ?').all(attachmentId) as {
      provider: string
      remote_id: string
      uri: string | null
      expires_at: string | null
    }[]
    return Object.fromEntries(rows.map((r) => [r.provider, { remoteId: r.remote_id, uri: r.uri, expiresAt: r.expires_at }]))
  }

  recordUpload(attachmentId: string, provider: string, remote: { remoteId: string; uri?: string | null; expiresAt?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO chat_attachment_uploads (attachment_id, provider, remote_id, uri, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(attachment_id, provider) DO UPDATE SET remote_id = excluded.remote_id, uri = excluded.uri, expires_at = excluded.expires_at,
           created_at = excluded.created_at`
      )
      .run(attachmentId, provider, remote.remoteId, remote.uri ?? null, remote.expiresAt ?? null, now())
  }

  /** Notes whose titles contain `q`, newest first (the chat bar's @ menu). */
  searchTitles(q: string, limit = 50, exclude: string[] = []): { id: string; title: string; created_at: string }[] {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    const rows = this.db
      .prepare(
        `SELECT id, title, created_at FROM documents WHERE deleted_at IS NULL AND (CASE WHEN title = '' THEN 'New note' ELSE title END) LIKE ? ESCAPE '\\'
         ORDER BY created_at DESC LIMIT ?`
      )
      .all(like, limit + exclude.length) as { id: string; title: string; created_at: string }[]
    return rows.filter((r) => !exclude.includes(r.id)).slice(0, limit)
  }

  updateMessage(id: string, patch: { content?: string; citations?: ChatCitation[]; outputs?: AgentOutput[]; status?: MessageStatus; error?: string | null }): ChatMessage {
    if (patch.content !== undefined) this.db.prepare('UPDATE chat_messages SET content = ? WHERE id = ?').run(patch.content, id)
    if (patch.citations !== undefined) this.db.prepare('UPDATE chat_messages SET citations = ? WHERE id = ?').run(JSON.stringify(patch.citations), id)
    if (patch.outputs !== undefined) this.db.prepare('UPDATE chat_messages SET outputs = ? WHERE id = ?').run(JSON.stringify(patch.outputs), id)
    if (patch.status !== undefined) this.db.prepare('UPDATE chat_messages SET status = ? WHERE id = ?').run(patch.status, id)
    if (patch.error !== undefined) this.db.prepare('UPDATE chat_messages SET error = ? WHERE id = ?').run(patch.error, id)
    const message = this.getMessage(id)
    if (!message) throw new Error(`Message ${id} not found`)
    return message
  }

  // ----------------------------------------------------------------- calendar

  replaceCalendarEvents(events: CalendarEvent[], windowStart: string, windowEnd: string): void {
    const insert = this.db.prepare('INSERT OR REPLACE INTO calendar_events (id, start_time, end_time, data) VALUES (?, ?, ?, ?)')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM calendar_events WHERE start_time >= ? AND start_time < ?').run(windowStart, windowEnd)
      for (const e of events) insert.run(e.id, e.start, e.end, JSON.stringify(e))
    })()
  }

  calendarEventsBetween(from: string, to: string): CalendarEvent[] {
    return (this.db.prepare('SELECT data FROM calendar_events WHERE end_time >= ? AND start_time < ? ORDER BY start_time').all(from, to) as {
      data: string
    }[]).map((r) => JSON.parse(r.data) as CalendarEvent)
  }

  clearCalendar(): void {
    this.db.prepare('DELETE FROM calendar_events').run()
  }

  // ----------------------------------------------------------------- settings

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? parse<T>(row.value, fallback) : fallback
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
  }

  deleteSetting(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  // ------------------------------------------------------------------- search

  reindex(documentId: string): void {
    const doc = this.db.prepare('SELECT title, notes_plain, deleted_at FROM documents WHERE id = ?').get(documentId) as
      | { title: string; notes_plain: string; deleted_at: string | null }
      | undefined
    this.db.prepare('DELETE FROM documents_fts WHERE document_id = ?').run(documentId)
    if (!doc || doc.deleted_at) return
    const transcript = formatTranscript(this.getTranscript(documentId), { timestamps: false })
    const panels = (this.db.prepare('SELECT content FROM document_panels WHERE document_id = ?').all(documentId) as { content: string }[])
      .map((p) => p.content)
      .join('\n\n')
    this.db
      .prepare('INSERT INTO documents_fts (document_id, title, notes, transcript, panels) VALUES (?, ?, ?, ?, ?)')
      .run(documentId, doc.title, doc.notes_plain, transcript, panels)
  }

  /** Full-text search with BM25 ranking (title weighted highest). */
  search(q: string, limit = 20): SearchHit[] {
    const match = toFtsQuery(q)
    if (!match) return []
    return this.db
      .prepare(
        `SELECT f.document_id, d.title, d.created_at,
                snippet(documents_fts, -1, '«', '»', '…', 12) AS snippet
         FROM documents_fts f JOIN documents d ON d.id = f.document_id
         WHERE documents_fts MATCH ? AND d.deleted_at IS NULL
         ORDER BY bm25(documents_fts, 0, 10.0, 4.0, 1.0, 2.0) LIMIT ?`
      )
      .all(match, limit) as SearchHit[]
  }
}

/** Turn free text into a safe FTS5 query: each word becomes a quoted prefix term, OR-ed together. */
export function toFtsQuery(q: string): string {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)
    .slice(0, 12)
  return terms.map((t) => `"${t}"*`).join(' OR ')
}
