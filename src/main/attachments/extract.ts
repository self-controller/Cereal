// Text extraction for chat attachments: what a model that can't read the file natively gets instead, and what
// budgets the thread's context. PDFs through unpdf, Word through mammoth, Excel by reading the sheet XML directly.
import JSZip from 'jszip'
import type { AttachmentKind } from '@shared/attachments'
import { XLSX_MIME } from '@shared/attachments'

export interface Extracted {
  text: string
  pages: number | null
}

export async function extractText(kind: AttachmentKind, mime: string, bytes: Uint8Array): Promise<Extracted> {
  if (kind === 'text') return { text: new TextDecoder('utf-8', { fatal: false }).decode(bytes), pages: null }
  if (kind === 'pdf') return extractPdf(bytes)
  if (kind === 'office') return { text: mime === XLSX_MIME ? await extractXlsx(bytes) : await extractDocx(bytes), pages: null }
  return { text: '', pages: null }
}

async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  const { extractText: pdfText } = await import('unpdf')
  // pdf.js takes ownership of (and detaches) the buffer it is given, so it gets a copy.
  const { totalPages, text } = await pdfText(new Uint8Array(bytes), { mergePages: false })
  return { text: text.map((t, i) => `[Page ${i + 1}]\n${t.trim()}`).join('\n\n'), pages: totalPages }
}

async function extractDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return result.value.replace(/\n{3,}/g, '\n\n').trim()
}

/** Every sheet as CSV under a "## Sheet" heading. */
export async function extractXlsx(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const read = async (path: string): Promise<string | null> => (await zip.file(path)?.async('string')) ?? null
  const shared = parseSharedStrings((await read('xl/sharedStrings.xml')) ?? '')
  const workbook = (await read('xl/workbook.xml')) ?? ''
  const rels = (await read('xl/_rels/workbook.xml.rels')) ?? ''
  const targets = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id')
    const target = attr(m[0], 'Target')
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'))
  }
  const out: string[] = []
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(attr(m[0], 'name') ?? 'Sheet')
    const rid = attr(m[0], 'r:id')
    const path = (rid && targets.get(rid)) || null
    const xml = path ? await read(path) : null
    if (!xml) continue
    out.push(`## ${name}\n${sheetToCsv(xml, shared)}`)
  }
  return out.join('\n\n').trim()
}

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`))
  return m ? m[1] : null
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

/** All `<t>` runs of an element, joined (rich text splits a cell into several runs). */
function runs(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('')
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => runs(m[1]))
}

function columnIndex(ref: string): number {
  let n = 0
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function sheetToCsv(xml: string, shared: string[]): string {
  const lines: string[] = []
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = []
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = `<c${c[1]}>`
      const ref = attr(tag, 'r')
      const type = attr(tag, 't')
      const body = c[2] ?? ''
      const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1]
      let value = ''
      if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = runs(body)
      else if (type === 'b' && raw !== undefined) value = raw === '1' ? 'TRUE' : 'FALSE'
      else if (raw !== undefined) value = decodeXml(raw)
      const at = ref ? columnIndex(ref) : cells.length
      while (cells.length < at) cells.push('')
      cells[at] = csvField(value)
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop()
    lines.push(cells.join(','))
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** Width and height from a PNG or JPEG header, without decoding the image. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24) return { width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null
      const marker = bytes[i + 1]
      const length = view.getUint16(i + 2)
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) }
      }
      i += 2 + length
    }
  }
  return null
}
