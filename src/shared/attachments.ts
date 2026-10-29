// Chat attachments: what the chat bar accepts and the limits it enforces (docs/granola-chat-bar.md §7).
// Pure, so the renderer can validate before sending bytes and main can re-check what arrives.

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'office'
export type AttachmentStatus = 'processing' | 'ready' | 'failed'

export const ATTACHMENT_LIMITS = {
  filesPerBatch: 200,
  bytesPerFile: 30 * 1024 * 1024,
  bytesPerThread: 30 * 1024 * 1024,
  pdfPagesPerFile: 100,
  pdfPagesPerThread: 100,
  /** Longest image side sent to a model; larger images are re-encoded. */
  imageMaxSide: 1568,
  /** Pasted plain text longer than this becomes a .txt attachment instead. */
  pasteAsFileChars: 5000
} as const

const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'yaml', 'yml']

/** What the hidden file input accepts. */
export const ATTACHMENT_ACCEPT = [
  'image/png',
  'image/jpeg',
  'application/pdf',
  'application/json',
  'text/*',
  '.md',
  '.markdown',
  '.docx',
  '.xlsx',
  ...TEXT_EXTENSIONS.map((e) => `.${e}`)
].join(',')

/** Shown in the drop overlay and in rejection toasts. */
export const ATTACHMENT_TYPES_LABEL = 'PNG, JPEG, PDF, Word (.docx), Excel (.xlsx), Markdown, JSON and text files'

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export type Classified = { ok: true; kind: AttachmentKind; mime: string } | { ok: false; message: string }

/** Decide what a file is from its name and declared type (the bytes are sniffed again in main). */
export function classifyFile(name: string, type: string): Classified {
  const ext = extensionOf(name)
  const mime = type.toLowerCase()
  if (mime === 'image/png' || ext === 'png') return { ok: true, kind: 'image', mime: 'image/png' }
  if (mime === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') return { ok: true, kind: 'image', mime: 'image/jpeg' }
  if (mime === 'application/pdf' || ext === 'pdf') return { ok: true, kind: 'pdf', mime: 'application/pdf' }
  if (mime === DOCX_MIME || ext === 'docx') return { ok: true, kind: 'office', mime: DOCX_MIME }
  if (mime === XLSX_MIME || ext === 'xlsx') return { ok: true, kind: 'office', mime: XLSX_MIME }
  if (ext === 'doc' || ext === 'xls' || mime === 'application/msword' || mime === 'application/vnd.ms-excel') {
    return { ok: false, message: `${name} is an older Office format. Save it as .${ext === 'xls' || mime.includes('excel') ? 'xlsx' : 'docx'} and attach it again.` }
  }
  if (mime === 'application/json' || ext === 'json') return { ok: true, kind: 'text', mime: 'application/json' }
  if (ext === 'md' || ext === 'markdown' || mime === 'text/markdown') return { ok: true, kind: 'text', mime: 'text/markdown' }
  if (mime.startsWith('text/') || TEXT_EXTENSIONS.includes(ext)) return { ok: true, kind: 'text', mime: mime.startsWith('text/') ? mime : 'text/plain' }
  if (mime.startsWith('image/')) return { ok: false, message: `${name} is a ${mime.slice(6).toUpperCase()} image. Convert it to PNG or JPEG.` }
  return { ok: false, message: `${name} isn't a supported file type. Cereal accepts ${ATTACHMENT_TYPES_LABEL}.` }
}

/** The real format of the first bytes, when it is one that matters. */
export function sniff(bytes: Uint8Array): 'png' | 'jpeg' | 'gif' | 'webp' | 'pdf' | 'zip' | null {
  const b = (i: number): number => bytes[i] ?? -1
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'png'
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpeg'
  if (b(0) === 0x47 && b(1) === 0x49 && b(2) === 0x46) return 'gif'
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45) return 'webp'
  if (b(0) === 0x25 && b(1) === 0x50 && b(2) === 0x44 && b(3) === 0x46) return 'pdf'
  if (b(0) === 0x50 && b(1) === 0x4b && b(2) === 0x03 && b(3) === 0x04) return 'zip'
  return null
}

/** Check that the bytes really are what the name and type claim. Returns an error message, or null when they match. */
export function verifyBytes(name: string, kind: AttachmentKind, mime: string, bytes: Uint8Array): string | null {
  const real = sniff(bytes)
  if (kind === 'image') {
    const want = mime === 'image/png' ? 'png' : 'jpeg'
    if (real !== want) return `${name} is actually ${real ? real.toUpperCase() : 'not an image'} format. Convert it to JPEG or PNG.`
  } else if (kind === 'pdf') {
    if (real !== 'pdf') return `${name} isn't a valid PDF.`
  } else if (kind === 'office') {
    if (real !== 'zip') return `${name} isn't a valid ${mime === XLSX_MIME ? 'Excel' : 'Word'} file.`
  } else if (real || bytes.subarray(0, 4096).includes(0)) {
    return `${name} doesn't look like a text file.`
  }
  return null
}

/** Chip labels: the head plus the last 8 characters once a name is over 16 (Granola's middle truncation). */
export function middleTruncate(name: string, max = 16, tail = 8): string {
  if (name.length <= max) return name
  return `${name.slice(0, Math.max(1, max - tail - 1))}…${name.slice(-tail)}`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/** "Pasted text 2026-10-20 14.32.05.txt" */
export function pastedTextName(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `Pasted text ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.txt`
}
