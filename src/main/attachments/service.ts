import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatAttachment, LlmProviderId } from '@shared/types'
import { ATTACHMENT_LIMITS, classifyFile, formatBytes, verifyBytes } from '@shared/attachments'
import type { Store } from '../db/store'
import { extractText } from './extract'

/** A rejection worded for the user, shown as is. */
class AttachmentRejected extends Error {}

/** Deletes a provider-side copy of a file (best effort; the provider may already have expired it). */
export type RemoteDeleter = (provider: LlmProviderId, remoteId: string) => Promise<void>

export interface AttachInput {
  documentId: string | null
  /** The thread the file is for, when it already exists: its files count towards the thread's budget. */
  threadId?: string | null
  /** Other draft files waiting in the same chat bar. */
  draftIds?: string[]
  name: string
  type: string
  bytes: Uint8Array
}

/**
 * Files added in the chat bar (docs/granola-chat-bar.md §7). Each lives in `<dir>/<id>/`: `original` as received,
 * and `text.md` with the text extracted from it. Granola's server processes uploads; Cereal does it here, and
 * the providers upload a file to their own Files API the first time a request needs it (src/main/llm/files.ts).
 */
export class AttachmentService {
  private processing = new Map<string, Promise<void>>()

  constructor(
    private readonly store: Store,
    readonly dir: string,
    private readonly emit: (a: ChatAttachment) => void,
    private readonly deleteRemote: RemoteDeleter
  ) {
    mkdirSync(dir, { recursive: true })
  }

  private folder(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid attachment id')
    return join(this.dir, id)
  }

  originalPath(id: string): string {
    return join(this.folder(id), 'original')
  }

  textPath(id: string): string {
    return join(this.folder(id), 'text.md')
  }

  /** Validate, store and start processing a file. Rejections throw with a message for the user. */
  async add(input: AttachInput): Promise<ChatAttachment> {
    const classified = classifyFile(input.name, input.type)
    if (!classified.ok) throw new Error(classified.message)
    const { kind, mime } = classified
    const bytes = input.bytes
    if (bytes.byteLength > ATTACHMENT_LIMITS.bytesPerFile) throw new Error(`${input.name} is ${formatBytes(bytes.byteLength)}. Files can be up to ${formatBytes(ATTACHMENT_LIMITS.bytesPerFile)}.`)
    if (bytes.byteLength === 0) throw new Error(`${input.name} is empty.`)
    const mismatch = verifyBytes(input.name, kind, mime, bytes)
    if (mismatch) throw new Error(mismatch)
    const budget = this.budget(input.threadId ?? null, input.draftIds ?? [])
    if (budget.bytes + bytes.byteLength > ATTACHMENT_LIMITS.bytesPerThread) {
      throw new Error(`This chat already has ${formatBytes(budget.bytes)} of files; a chat can hold up to ${formatBytes(ATTACHMENT_LIMITS.bytesPerThread)}. Start a new chat to add more.`)
    }

    const id = randomUUID()
    mkdirSync(this.folder(id), { recursive: true })
    await writeFile(this.originalPath(id), bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const created = this.store.createAttachment({ id, documentId: input.documentId, name: input.name, mime, kind, size: bytes.byteLength, sha256 })
    const job = this.process(created, bytes, budget.pages).finally(() => this.processing.delete(id))
    this.processing.set(id, job)
    return created
  }

  /** Wait until a file has finished processing (tests, and sending right after attaching). */
  async settled(id: string): Promise<ChatAttachment | null> {
    await this.processing.get(id)
    return this.store.getAttachment(id)
  }

  private budget(threadId: string | null, draftIds: string[]): { bytes: number; pages: number } {
    const files = [...(threadId ? this.store.threadAttachments(threadId) : []), ...draftIds.map((id) => this.store.getAttachment(id))]
    const live = files.filter((a): a is ChatAttachment => !!a && a.status !== 'failed')
    return { bytes: live.reduce((n, a) => n + a.size, 0), pages: live.reduce((n, a) => n + (a.pages ?? 0), 0) }
  }

  private async process(a: ChatAttachment, bytes: Uint8Array, pagesUsed: number): Promise<void> {
    try {
      const { text, pages } = await extractText(a.kind, a.mime, bytes)
      if (pages !== null && pages > ATTACHMENT_LIMITS.pdfPagesPerFile) throw new AttachmentRejected(`${a.name} has ${pages} pages. PDFs can have up to ${ATTACHMENT_LIMITS.pdfPagesPerFile}.`)
      if (pages !== null && pagesUsed + pages > ATTACHMENT_LIMITS.pdfPagesPerThread) {
        throw new AttachmentRejected(`Adding ${a.name} would put this chat over ${ATTACHMENT_LIMITS.pdfPagesPerThread} PDF pages. Start a new chat to add more.`)
      }
      if ((a.kind === 'office' || a.kind === 'text') && !text.trim()) throw new AttachmentRejected(`${a.name} has no text Cereal can read.`)
      await writeFile(this.textPath(a.id), text)
      this.publish(this.store.updateAttachment(a.id, { status: 'ready', pages, text_chars: text.length, error: null }))
    } catch (e) {
      const error = e instanceof AttachmentRejected ? e.message : `Couldn’t read ${a.name}${e instanceof Error && e.message ? `: ${e.message}` : '.'}`
      this.publish(this.store.updateAttachment(a.id, { status: 'failed', error }))
    }
  }

  private publish(a: ChatAttachment | null): void {
    if (a) this.emit(a)
  }

  async readOriginal(id: string): Promise<Buffer> {
    return readFile(this.originalPath(id))
  }

  async readText(id: string): Promise<string> {
    try {
      return await readFile(this.textPath(id), 'utf8')
    } catch {
      return ''
    }
  }

  /** Remove a draft (or sent) file, its folder and its provider-side copies. */
  remove(id: string): void {
    const uploads = this.store.uploads(id)
    this.store.deleteAttachment(id)
    this.cleanup([{ id, uploads }])
  }

  /** Call before deleting a thread: returns a function that removes its files once the rows are gone. */
  forThreadDeletion(threadId: string): () => void {
    const files = this.store.threadAttachments(threadId).map((a) => ({ id: a.id, uploads: this.store.uploads(a.id) }))
    return () => this.cleanup(files)
  }

  private cleanup(files: { id: string; uploads: ReturnType<Store['uploads']> }[]): void {
    for (const f of files) {
      rmSync(this.folder(f.id), { recursive: true, force: true })
      for (const [provider, u] of Object.entries(f.uploads)) void this.deleteRemote(provider as LlmProviderId, u.remoteId).catch(() => undefined)
    }
  }

  /** At startup: drop drafts that were never sent and folders whose rows are gone. */
  purge(maxDraftAgeMs = 24 * 60 * 60 * 1000): void {
    for (const id of this.store.staleDraftAttachments(new Date(Date.now() - maxDraftAgeMs).toISOString())) this.remove(id)
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter((n) => /^[0-9a-f-]{36}$/.test(n))
    } catch {
      return
    }
    for (const id of this.store.missingAttachments(names)) rmSync(join(this.dir, id), { recursive: true, force: true })
  }
}
