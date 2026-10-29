import { useCallback, useEffect, useRef, useState } from 'react'
import { ATTACHMENT_LIMITS, ATTACHMENT_TYPES_LABEL, classifyFile, pastedTextName, type AttachmentKind } from '@shared/attachments'
import type { ChatAttachment } from '@shared/types'
import { call, errorMessage, useEvent } from '../../lib/api'
import { useApp } from '../../store'

/** A file in the chat bar: uploading to main, then processing there, then ready to send. */
export interface DraftFile {
  key: string
  id: string | null
  name: string
  mime: string
  kind: AttachmentKind
  size: number
  status: 'uploading' | 'processing' | 'ready' | 'failed'
  error: string | null
  /** A local preview for images while they upload. */
  previewUrl: string | null
}

export const attachmentUrl = (id: string): string => `cereal-attachment://file/${id}`

let nextKey = 1

/**
 * Re-encode an image whose longest side is over 1568px (what models are sent), keeping its format. Granola does
 * this before upload too; main only checks the bytes.
 */
async function prepareImage(file: File, mime: string): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  try {
    const max = ATTACHMENT_LIMITS.imageMaxSide
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height))
    if (scale === 1) return file
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return file
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await canvas.convertToBlob({ type: mime, quality: 0.9 })
  } finally {
    bitmap.close()
  }
}

/** The chat bar's files: add from the picker, paste or drop; removed drafts are deleted in main. */
export function useAttachments(opts: { documentId: string | null; threadId: string | null }) {
  const [files, setFiles] = useState<DraftFile[]>([])
  const filesRef = useRef(files)
  filesRef.current = files
  const showToast = useApp((s) => s.showToast)
  const optsRef = useRef(opts)
  optsRef.current = opts

  const patch = useCallback((key: string, p: Partial<DraftFile>) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...p } : f))), [])

  const fromAttachment = (a: ChatAttachment): DraftFile => ({
    key: `att-${a.id}`,
    id: a.id,
    name: a.name,
    mime: a.mime,
    kind: a.kind,
    size: a.size,
    status: a.status,
    error: a.error,
    previewUrl: null
  })

  /** Status updates that arrive before `chat:attach` has returned the file's id (images finish almost at once). */
  const early = useRef(new Map<string, ChatAttachment>())

  const apply = useCallback(
    (f: DraftFile, a: ChatAttachment) => {
      if (a.status === 'failed') {
        showToast('error', a.error ?? `Couldn’t read ${a.name}.`)
        setFiles((list) => list.filter((x) => x.key !== f.key))
        void call('chat:remove-attachment', a.id).catch(() => undefined)
        return
      }
      patch(f.key, { status: a.status, error: a.error })
    },
    [patch, showToast]
  )

  useEvent('chat:attachment', (a) => {
    const f = filesRef.current.find((x) => x.id === a.id)
    if (f) apply(f, a)
    else if (filesRef.current.some((x) => !x.id)) early.current.set(a.id, a)
  })

  const add = useCallback(
    async (input: FileList | File[]) => {
      const list = Array.from(input)
      if (!list.length) return
      if (list.length + filesRef.current.length > ATTACHMENT_LIMITS.filesPerBatch) {
        showToast('error', `You can add up to ${ATTACHMENT_LIMITS.filesPerBatch} files at once.`)
        return
      }
      const unsupported: string[] = []
      for (const file of list) {
        const classified = classifyFile(file.name, file.type)
        if (!classified.ok) {
          unsupported.push(classified.message)
          continue
        }
        const key = `draft-${nextKey++}`
        const previewUrl = classified.kind === 'image' ? URL.createObjectURL(file) : null
        setFiles((l) => [
          ...l,
          { key, id: null, name: file.name, mime: classified.mime, kind: classified.kind, size: file.size, status: 'uploading', error: null, previewUrl }
        ])
        void (async () => {
          try {
            const blob = classified.kind === 'image' ? await prepareImage(file, classified.mime) : file
            const bytes = new Uint8Array(await blob.arrayBuffer())
            const draftIds = filesRef.current.flatMap((f) => (f.id && f.key !== key ? [f.id] : []))
            const a = await call('chat:attach', { documentId: optsRef.current.documentId, threadId: optsRef.current.threadId, draftIds, name: file.name, type: classified.mime, bytes })
            // The bar may have been cleared (or the chip removed) while uploading.
            if (!filesRef.current.some((f) => f.key === key)) {
              void call('chat:remove-attachment', a.id).catch(() => undefined)
              return
            }
            patch(key, { id: a.id, status: a.status, size: a.size })
            // A status event landing before the next render must already find the file by its id, or it would be
            // parked in `early` after that has been read below and never applied (the chip would spin forever).
            filesRef.current = filesRef.current.map((f) => (f.key === key ? { ...f, id: a.id } : f))
            const update = early.current.get(a.id)
            early.current.delete(a.id)
            if (update) apply({ ...filesRef.current.find((f) => f.key === key)!, id: a.id }, update)
          } catch (e) {
            showToast('error', errorMessage(e))
            setFiles((l) => l.filter((f) => f.key !== key))
            if (previewUrl) URL.revokeObjectURL(previewUrl)
          }
        })()
      }
      if (unsupported.length) showToast('error', unsupported.length === 1 ? unsupported[0] : `${unsupported.length} files weren’t added. Cereal accepts ${ATTACHMENT_TYPES_LABEL}.`)
    },
    [patch, showToast, apply]
  )

  /** Long pasted text becomes a text file instead of filling the bar. */
  const addPastedText = useCallback((text: string) => void add([new File([text], pastedTextName(), { type: 'text/plain' })]), [add])

  const remove = useCallback((key: string, { keepRemote = false }: { keepRemote?: boolean } = {}) => {
    const f = filesRef.current.find((x) => x.key === key)
    if (!f) return
    setFiles((l) => l.filter((x) => x.key !== key))
    if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
    if (f.id && !keepRemote) void call('chat:remove-attachment', f.id).catch(() => undefined)
  }, [])

  /** Empty the bar after sending (the files now belong to the message). */
  const clear = useCallback(() => {
    for (const f of filesRef.current) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
    setFiles([])
  }, [])

  /** Show a sent message's files again (editing it); they are kept, not re-uploaded. */
  const load = useCallback((attachments: ChatAttachment[]) => setFiles(attachments.map(fromAttachment)), [])

  useEffect(
    () => () => {
      // Drafts left in a bar that goes away are dropped (Cereal purges any that slip through at startup).
      for (const f of filesRef.current) {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
        if (f.id && f.key.startsWith('draft-')) void call('chat:remove-attachment', f.id).catch(() => undefined)
      }
    },
    []
  )

  const ids = files.flatMap((f) => (f.id ? [f.id] : []))
  const loading = files.some((f) => f.status === 'uploading' || f.status === 'processing')
  return { files, ids, loading, add, addPastedText, remove, clear, load }
}

export type Attachments = ReturnType<typeof useAttachments>
