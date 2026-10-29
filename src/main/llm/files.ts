// Shared pieces of how providers send attachments: upload once per provider (cached through FileAccess), and the
// text form a file takes when a provider can't read it natively.
import type { LlmProviderId } from '@shared/types'
import type { AttachmentRef, FileAccess, RemoteFile } from './provider'

/** Images up to this size go inline (base64); bigger ones are uploaded to the provider's Files API. */
export const INLINE_IMAGE_MAX_BYTES = 256 * 1024

/** Uploads in flight, so parallel steps (or two turns referencing one file) don't upload it twice. */
const inflight = new Map<string, Promise<RemoteFile>>()

/** This provider's upload of a file, uploading it the first time a request needs it. */
export async function uploadOnce(files: FileAccess, ref: AttachmentRef, provider: LlmProviderId, upload: () => Promise<RemoteFile>): Promise<RemoteFile> {
  const cached = files.remote(ref, provider)
  if (cached) return cached
  const key = `${provider}:${ref.id}`
  let pending = inflight.get(key)
  if (!pending) {
    pending = (async () => {
      const remote = await upload()
      await files.remember(ref, provider, remote)
      return remote
    })().finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

/** A file's extracted text, delimited so the model can tell it apart from the question. */
export async function attachmentAsText(files: FileAccess | undefined, ref: AttachmentRef): Promise<string> {
  const text = files ? await files.text(ref) : ''
  if (!text.trim()) return `[Attached file: ${ref.name} (${ref.mime}). Its contents aren't available to this model.]`
  return `<attached_file name="${ref.name.replace(/"/g, "'")}" type="${ref.mime}">\n${text}\n</attached_file>`
}

/** What a file is called when there is no way to send it at all. */
export function attachmentPlaceholder(ref: AttachmentRef): string {
  return `[Attached file: ${ref.name}]`
}

export function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

/** A Blob for SDK uploads (Node 20+ has a global Blob and File). */
export function fileOf(bytes: Uint8Array, name: string, mime: string): File {
  return new File([new Uint8Array(bytes)], name, { type: mime })
}
