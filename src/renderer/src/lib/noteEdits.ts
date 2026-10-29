import type { Editor } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'

// Applying the agent's editMeetingNotes calls to the open notepad (Granola applies them in its editor too, so the
// user sees the change and can undo it). Text is matched the way the notes' plain text is built: text blocks joined
// by new lines, empty ones skipped, so a passage main accepted can be found here.

/** Find `needle` in the document's text; returns the document range it covers. */
export function findText(doc: PMNode, needle: string): { from: number; to: number } | null {
  if (!needle) return null
  let text = ''
  const positions: number[] = [] // document position of each character; -1 for the line break between blocks
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    if (!node.textContent.trim()) return false
    if (text) {
      text += '\n'
      positions.push(-1)
    }
    node.forEach((child, offset) => {
      if (!child.isText || !child.text) return
      for (let i = 0; i < child.text.length; i++) {
        text += child.text[i]
        positions.push(pos + 1 + offset + i)
      }
    })
    return false
  })
  const start = text.indexOf(needle)
  if (start < 0) return null
  let a = start
  let b = start + needle.length - 1
  while (a <= b && positions[a] === -1) a++
  while (b >= a && positions[b] === -1) b--
  if (a > b) return null
  return { from: positions[a], to: positions[b] + 1 }
}

/** Replace a passage (or append when `textToReplace` is empty) and select the new text. */
export function applyNoteEdit(editor: Editor, textToReplace: string, newText: string): boolean {
  const lines = newText.split('\n')
  const content =
    lines.length === 1 ? (newText ? [{ type: 'text', text: newText }] : []) : lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] }))
  if (!textToReplace) {
    const end = editor.state.doc.content.size
    const blocks = lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] }))
    return editor.chain().insertContentAt(end, blocks).setTextSelection({ from: end, to: editor.state.doc.content.size }).scrollIntoView().run()
  }
  const range = findText(editor.state.doc, textToReplace)
  if (!range) return false
  const chain = editor.chain()
  if (content.length) chain.insertContentAt(range, content)
  else chain.deleteRange(range)
  const ok = chain.run()
  if (ok && newText) {
    const inserted = findText(editor.state.doc, newText)
    if (inserted) editor.chain().setTextSelection(inserted).scrollIntoView().run()
  }
  return ok
}
