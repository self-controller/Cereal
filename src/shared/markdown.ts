// Minimal Markdown ⇄ ProseMirror/TipTap JSON conversion for the notepad and the enhanced notes.

export interface PMMark {
  type: string
  attrs?: Record<string, unknown>
}

export interface PMNode {
  type: string
  attrs?: Record<string, unknown>
  content?: PMNode[]
  text?: string
  marks?: PMMark[]
}

function inline(nodes: PMNode[] | undefined): string {
  if (!nodes) return ''
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n'
      if (n.type !== 'text') return inline(n.content)
      let t = n.text ?? ''
      const marks = new Set((n.marks ?? []).map((m) => m.type))
      if (marks.has('code')) return '`' + t + '`'
      if (marks.has('bold')) t = `**${t}**`
      if (marks.has('italic')) t = `*${t}*`
      if (marks.has('strike')) t = `~~${t}~~`
      const link = n.marks?.find((m) => m.type === 'link')
      if (link?.attrs?.href) t = `[${t}](${String(link.attrs.href)})`
      return t
    })
    .join('')
}

function block(node: PMNode, indent: string): string[] {
  switch (node.type) {
    case 'paragraph':
      return [indent + inline(node.content)]
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))
      return [indent + '#'.repeat(level) + ' ' + inline(node.content)]
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList': {
      const start = Number(node.attrs?.start ?? 1)
      const lines: string[] = []
      ;(node.content ?? []).forEach((item, i) => {
        let marker = node.type === 'orderedList' ? `${start + i}. ` : '- '
        if (node.type === 'taskList') marker = `- [${item.attrs?.checked ? 'x' : ' '}] `
        const children = item.content ?? []
        children.forEach((child, ci) => {
          const childLines = block(child, ci === 0 ? '' : indent + '  ')
          if (ci === 0 && child.type === 'paragraph') {
            lines.push(indent + marker + childLines[0].trimStart(), ...childLines.slice(1))
          } else if (ci === 0) {
            lines.push(indent + marker.trimEnd(), ...block(child, indent + '  '))
          } else {
            lines.push(...block(child, indent + '  '))
          }
        })
      })
      return lines
    }
    case 'blockquote':
      return (node.content ?? []).flatMap((c) => block(c, indent)).map((l) => '> ' + l)
    case 'codeBlock':
      return [indent + '```', ...(inline(node.content) || '').split('\n').map((l) => indent + l), indent + '```']
    case 'horizontalRule':
      return [indent + '---']
    default:
      return node.content ? node.content.flatMap((c) => block(c, indent)) : []
  }
}

export function docToMarkdown(doc: PMNode | null | undefined): string {
  if (!doc?.content) return ''
  const out: string[] = []
  for (const node of doc.content) {
    if (out.length) out.push('')
    out.push(...block(node, ''))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function docToPlainText(doc: PMNode | null | undefined): string {
  if (!doc?.content) return ''
  const lines: string[] = []
  const walk = (n: PMNode): void => {
    if (n.type === 'text') return
    const isTextBlock = n.type === 'paragraph' || n.type === 'heading' || n.type === 'codeBlock'
    if (isTextBlock) {
      lines.push(textOf(n))
      return
    }
    n.content?.forEach(walk)
  }
  const textOf = (n: PMNode): string => (n.type === 'text' ? (n.text ?? '') : (n.content ?? []).map(textOf).join(''))
  doc.content.forEach(walk)
  return lines.filter((l) => l.trim().length > 0).join('\n')
}

// ------------------------------------------------------------------ Markdown → ProseMirror JSON

export type Line =
  | { kind: 'heading'; level: number; text: string; index: number }
  | { kind: 'bullet'; indent: number; col: number; text: string; index: number; checked?: boolean }
  | { kind: 'ordered'; indent: number; col: number; n: string; text: string; index: number }
  | { kind: 'quote'; text: string; index: number }
  | { kind: 'code'; text: string; index: number; fence: number }
  | { kind: 'rule'; index: number }
  | { kind: 'blank'; index: number }
  | { kind: 'para'; text: string; index: number }

/** Classify each Markdown line. `index` is the line's position in `md.split('\n')`; fence lines are dropped. */
export function parseLines(md: string): Line[] {
  const out: Line[] = []
  let fence = 0
  let inCode = false
  md.split('\n').forEach((raw, index) => {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode
      if (inCode) fence++
      return
    }
    if (inCode) return void out.push({ kind: 'code', text: raw, index, fence })
    if (!raw.trim()) return void out.push({ kind: 'blank', index })
    let m: RegExpMatchArray | null
    if ((m = raw.match(/^\s*(#{1,6})\s+(.*)$/))) return void out.push({ kind: 'heading', level: m[1].length, text: m[2], index })
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(raw)) return void out.push({ kind: 'rule', index })
    if ((m = raw.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/)))
      return void out.push({ kind: 'bullet', indent: Math.floor(m[1].length / 2), col: m[1].length, text: m[3], checked: m[2].toLowerCase() === 'x', index })
    if ((m = raw.match(/^(\s*)[-*+•]\s+(.*)$/))) return void out.push({ kind: 'bullet', indent: Math.floor(m[1].length / 2), col: m[1].length, text: m[2], index })
    if ((m = raw.match(/^(\s*)(\d+)[.)]\s+(.*)$/)))
      return void out.push({ kind: 'ordered', indent: Math.floor(m[1].length / 2), col: m[1].length, n: m[2], text: m[3], index })
    if ((m = raw.match(/^\s*>\s?(.*)$/))) return void out.push({ kind: 'quote', text: m[1], index })
    out.push({ kind: 'para', text: raw.trim(), index })
  })
  return out
}

const INLINE_MD = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|~~[^~]+~~|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g

/** Inline Markdown → text nodes with marks. Never returns empty text nodes (ProseMirror rejects them). */
export function inlineToNodes(text: string): PMNode[] {
  const out: PMNode[] = []
  const push = (t: string, marks?: PMMark[]): void => {
    if (t) out.push(marks?.length ? { type: 'text', text: t, marks } : { type: 'text', text: t })
  }
  for (const p of text.split(INLINE_MD)) {
    if (!p) continue
    let m: RegExpMatchArray | null
    if (/^(\*\*|__).+\1$/.test(p)) push(p.slice(2, -2), [{ type: 'bold' }])
    else if (/^`.+`$/.test(p)) push(p.slice(1, -1), [{ type: 'code' }])
    else if (/^~~.+~~$/.test(p)) push(p.slice(2, -2), [{ type: 'strike' }])
    else if ((m = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/))) push(m[1], [{ type: 'link', attrs: { href: m[2] } }])
    else if (/^(\*|_).+\1$/.test(p)) push(p.slice(1, -1), [{ type: 'italic' }])
    else push(p)
  }
  return out
}

/** The text a line becomes in the editor, trimmed — the key `generated_lines` stores. */
export function markdownLineText(line: Line): string {
  switch (line.kind) {
    case 'code':
      return line.text.trim()
    case 'rule':
    case 'blank':
      return ''
    default:
      return inlineToNodes(line.text)
        .map((n) => n.text ?? '')
        .join('')
        .trim()
  }
}

function textBlock(type: string, text: string, attrs?: Record<string, unknown>): PMNode {
  const content = inlineToNodes(text)
  return { type, ...(attrs && { attrs }), ...(content.length > 0 && { content }) }
}

type ListType = 'bulletList' | 'orderedList' | 'taskList'

/**
 * Line-oriented Markdown → TipTap JSON (StarterKit + TaskList/TaskItem node names).
 * Every text line becomes exactly one paragraph or heading, so `markdownLineText` matches its text content.
 */
export function markdownToDoc(md: string): PMNode {
  const content: PMNode[] = []
  // Open lists, outermost first, keyed by the raw indent column of their items.
  let stack: { col: number; type: ListType; node: PMNode }[] = []
  let quote: PMNode | null = null
  let code: { fence: number; node: PMNode; text: string[] } | null = null

  const closeCode = (): void => {
    if (!code) return
    const text = code.text.join('\n')
    if (text) code.node.content = [{ type: 'text', text }]
    code = null
  }
  const closeAll = (): void => {
    stack = []
    quote = null
    closeCode()
  }

  for (const line of parseLines(md)) {
    if (line.kind !== 'code') closeCode()
    if (line.kind !== 'quote') quote = null
    switch (line.kind) {
      case 'blank':
        // A blank line between items keeps the list open (a "loose" list); anything else closes it.
        break
      case 'heading':
        closeAll()
        content.push(textBlock('heading', line.text, { level: Math.min(3, line.level) }))
        break
      case 'rule':
        closeAll()
        content.push({ type: 'horizontalRule' })
        break
      case 'para':
        stack = []
        content.push(textBlock('paragraph', line.text))
        break
      case 'quote':
        stack = []
        if (!quote) content.push((quote = { type: 'blockquote', content: [] }))
        quote.content!.push(textBlock('paragraph', line.text))
        break
      case 'code':
        stack = []
        if (!code || code.fence !== line.fence) {
          closeCode()
          const node: PMNode = { type: 'codeBlock' }
          content.push(node)
          code = { fence: line.fence, node, text: [] }
        }
        code.text.push(line.text)
        break
      case 'bullet':
      case 'ordered': {
        const checked = line.kind === 'bullet' ? line.checked : undefined
        const type: ListType = line.kind === 'ordered' ? 'orderedList' : checked !== undefined ? 'taskList' : 'bulletList'
        while (stack.length && stack[stack.length - 1].col > line.col) stack.pop()
        let top = stack[stack.length - 1]
        if (top && top.col === line.col && top.type !== type) {
          stack.pop()
          top = stack[stack.length - 1]
        }
        if (!top || top.col !== line.col) {
          const list: PMNode = { type, content: [], ...(line.kind === 'ordered' && { attrs: { start: Number(line.n) || 1 } }) }
          const parentItems = top?.node.content
          const parentItem = parentItems?.[parentItems.length - 1]
          if (parentItem) parentItem.content!.push(list)
          else content.push(list)
          stack.push((top = { col: line.col, type, node: list }))
        }
        const paragraph = textBlock('paragraph', line.text)
        top.node.content!.push(type === 'taskList' ? { type: 'taskItem', attrs: { checked: !!checked }, content: [paragraph] } : { type: 'listItem', content: [paragraph] })
        break
      }
    }
  }
  closeCode()
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

/** Links in notes (Granola passes these to the summary prompt as `urls`). */
export function extractUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s)\]>]+/g) ?? [])]
}
