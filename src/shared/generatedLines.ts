// Grey for the lines the AI wrote, like Granola's `generatedLines` plugin: a paragraph or heading whose trimmed text is
// one of the panel's `generated_lines` gets data-generated="true". It matches on text, so an edited line turns black.
// The editor extension is components/editor/generatedLines.ts; this part is pure so it can be tested in Node.
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'

export function generatedDecorations(doc: PMNode, isGenerated: (text: string) => boolean): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return true
    const text = node.textContent.trim()
    if (text && isGenerated(text)) decorations.push(Decoration.node(pos, pos + node.nodeSize, { 'data-generated': 'true' }))
    return false
  })
  return DecorationSet.create(doc, decorations)
}
