import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { ATTACHMENT_LIMITS, DOCX_MIME, XLSX_MIME, classifyFile, middleTruncate, pastedTextName, sniff, verifyBytes } from '@shared/attachments'
import { openDatabase } from '../src/main/db'
import { Store } from '../src/main/db/store'
import { AttachmentService } from '../src/main/attachments/service'
import { extractText, extractXlsx, imageSize } from '../src/main/attachments/extract'
import type { ChatAttachment } from '@shared/types'

const PNG_1x1 = Uint8Array.from(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
)

/** A one-page PDF saying "Hello PDF" (pdf.js rebuilds the cross-reference table it doesn't have). */
function tinyPdf(text = 'Hello PDF'): Uint8Array {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    'trailer << /Root 1 0 R >>',
    '%%EOF'
  ].join('\n')
  return new TextEncoder().encode(pdf)
}

async function tinyDocx(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`
  )
  return zip.generateAsync({ type: 'uint8array' })
}

async function tinyXlsx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget &amp; plan" sheetId="1" r:id="rId1"/></sheets></workbook>'
  )
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
  zip.file('xl/sharedStrings.xml', '<sst><si><t>Item</t></si><si><t>Cost</t></si><si><r><t>Design,</t></r><r><t> "v2"</t></r></si></sst>')
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>1200</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Total</t></is></c><c r="B3" t="b"><v>1</v></c></row></sheetData></worksheet>'
  )
  return zip.generateAsync({ type: 'uint8array' })
}

describe('attachment rules', () => {
  it('classifies by name and type, and rejects legacy Office and other image formats', () => {
    expect(classifyFile('a.PNG', '')).toEqual({ ok: true, kind: 'image', mime: 'image/png' })
    expect(classifyFile('scan.jpeg', 'image/jpeg')).toMatchObject({ kind: 'image', mime: 'image/jpeg' })
    expect(classifyFile('r.pdf', 'application/pdf')).toMatchObject({ kind: 'pdf' })
    expect(classifyFile('plan.docx', '')).toEqual({ ok: true, kind: 'office', mime: DOCX_MIME })
    expect(classifyFile('budget.xlsx', '')).toEqual({ ok: true, kind: 'office', mime: XLSX_MIME })
    expect(classifyFile('notes.md', '')).toMatchObject({ kind: 'text', mime: 'text/markdown' })
    expect(classifyFile('data.json', 'application/json')).toMatchObject({ kind: 'text' })
    expect(classifyFile('log.txt', 'text/plain')).toMatchObject({ kind: 'text', mime: 'text/plain' })
    expect(classifyFile('old.doc', 'application/msword')).toEqual({ ok: false, message: expect.stringContaining('.docx') })
    expect(classifyFile('old.xls', '')).toEqual({ ok: false, message: expect.stringContaining('.xlsx') })
    expect(classifyFile('cat.gif', 'image/gif')).toEqual({ ok: false, message: expect.stringContaining('PNG or JPEG') })
    expect(classifyFile('app.exe', 'application/octet-stream')).toMatchObject({ ok: false })
  })

  it('checks the real format of the bytes', () => {
    expect(sniff(PNG_1x1)).toBe('png')
    expect(verifyBytes('a.png', 'image', 'image/png', PNG_1x1)).toBeNull()
    expect(verifyBytes('a.jpg', 'image', 'image/jpeg', PNG_1x1)).toMatch(/actually PNG/)
    expect(verifyBytes('r.pdf', 'pdf', 'application/pdf', tinyPdf())).toBeNull()
    expect(verifyBytes('r.pdf', 'pdf', 'application/pdf', new TextEncoder().encode('hello'))).toMatch(/valid PDF/)
    expect(verifyBytes('n.txt', 'text', 'text/plain', new TextEncoder().encode('hello'))).toBeNull()
    expect(verifyBytes('n.txt', 'text', 'text/plain', PNG_1x1)).toMatch(/text file/)
  })

  it('truncates long names in the middle and names pasted text', () => {
    expect(middleTruncate('short.pdf')).toBe('short.pdf')
    expect(middleTruncate('quarterly-planning-review-final.pdf')).toBe('quarter…inal.pdf')
    expect(pastedTextName(new Date(2026, 9, 20, 14, 32, 5))).toBe('Pasted text 2026-10-20 14.32.05.txt')
  })
})

describe('text extraction', () => {
  it('reads PDFs page by page with a page count', async () => {
    const r = await extractText('pdf', 'application/pdf', tinyPdf())
    expect(r.pages).toBe(1)
    expect(r.text).toContain('[Page 1]')
    expect(r.text).toContain('Hello PDF')
  })

  it('reads Word documents and every sheet of a workbook as CSV', async () => {
    const docx = await extractText('office', DOCX_MIME, await tinyDocx(['Goals', 'Ship the beta']))
    expect(docx.text).toContain('Goals')
    expect(docx.text).toContain('Ship the beta')
    expect(await extractXlsx(await tinyXlsx())).toBe('## Budget & plan\nItem,Cost\n"Design, ""v2""",,1200\nTotal,TRUE')
  })

  it('reads image sizes from the header', () => {
    expect(imageSize(PNG_1x1)).toEqual({ width: 1, height: 1 })
  })
})

describe('AttachmentService', () => {
  function service() {
    const store = new Store(openDatabase(':memory:'))
    const events: ChatAttachment[] = []
    const deleted: string[] = []
    const dir = mkdtempSync(join(tmpdir(), 'cereal-att-'))
    const svc = new AttachmentService(store, dir, (a) => events.push(a), async (_p, id) => void deleted.push(id))
    return { store, svc, events, deleted, dir }
  }

  it('stores a file, extracts its text and reports when it is ready', async () => {
    const { svc, events } = service()
    const a = await svc.add({ documentId: null, name: 'notes.md', type: 'text/markdown', bytes: new TextEncoder().encode('# Plan\n- ship') })
    expect(a).toMatchObject({ status: 'processing', kind: 'text', thread_id: null, message_id: null })
    const done = await svc.settled(a.id)
    expect(done).toMatchObject({ status: 'ready', text_chars: 13 })
    expect(await svc.readText(a.id)).toBe('# Plan\n- ship')
    expect(new TextDecoder().decode(await svc.readOriginal(a.id))).toBe('# Plan\n- ship')
    expect(events.at(-1)).toMatchObject({ id: a.id, status: 'ready' })
  })

  it('rejects files over the limits, with a message for the user', async () => {
    const { svc, store } = service()
    await expect(svc.add({ documentId: null, name: 'big.txt', type: 'text/plain', bytes: new Uint8Array(ATTACHMENT_LIMITS.bytesPerFile + 1).fill(65) })).rejects.toThrow(/up to 30 MB/)
    await expect(svc.add({ documentId: null, name: 'fake.png', type: 'image/png', bytes: new TextEncoder().encode('not a png') })).rejects.toThrow(/actually/)
    // The thread budget counts the other drafts in the bar.
    const first = await svc.add({ documentId: null, name: 'a.txt', type: 'text/plain', bytes: new Uint8Array(20 * 1024 * 1024).fill(65) })
    await svc.settled(first.id)
    await expect(svc.add({ documentId: null, draftIds: [first.id], name: 'b.txt', type: 'text/plain', bytes: new Uint8Array(11 * 1024 * 1024).fill(65) })).rejects.toThrow(/Start a new chat/)
    expect(store.getAttachment(first.id)).not.toBeNull()
  })

  it('fails files with no readable text, and removes files with their provider copies', async () => {
    const { svc, store, deleted, dir } = service()
    const empty = await svc.add({ documentId: null, name: 'empty.docx', type: DOCX_MIME, bytes: await tinyDocx([]) })
    expect(await svc.settled(empty.id)).toMatchObject({ status: 'failed', error: 'empty.docx has no text Cereal can read.' })

    const pdf = await svc.add({ documentId: null, name: 'r.pdf', type: 'application/pdf', bytes: tinyPdf() })
    expect(await svc.settled(pdf.id)).toMatchObject({ status: 'ready', pages: 1 })
    store.recordUpload(pdf.id, 'openai', { remoteId: 'file-1' })
    svc.remove(pdf.id)
    expect(store.getAttachment(pdf.id)).toBeNull()
    expect(existsSync(join(dir, pdf.id))).toBe(false)
    await new Promise((r) => setImmediate(r))
    expect(deleted).toEqual(['file-1'])
  })

  it('purges drafts that were never sent', async () => {
    const { svc, store } = service()
    const a = await svc.add({ documentId: null, name: 'a.txt', type: 'text/plain', bytes: new TextEncoder().encode('x') })
    await svc.settled(a.id)
    svc.purge(-1000)
    expect(store.getAttachment(a.id)).toBeNull()
  })
})
