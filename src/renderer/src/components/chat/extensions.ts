// The chat bar's editor extensions (docs/granola-chat-bar.md §2, §4, §5): recipe and note-mention atoms, the
// keyboard handling, and paste as plain text.
import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/react'
import { titleCaseSlug } from '@shared/chatbar'

/** `/slug`: a recipe chosen from the "/" menu. Backspace turns it back into editable text. */
export const RecipeNode = Node.create({
  name: 'recipe',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { id: { default: null }, slug: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'span[data-recipe]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-recipe': node.attrs.slug, class: 'chat-recipe-node', contenteditable: 'false' }), ['span', { class: 'chat-recipe-icon' }], titleCaseSlug(node.attrs.slug)]
  },
  renderText({ node }) {
    return `/${node.attrs.slug}`
  },
  addKeyboardShortcuts() {
    return {
      Backspace: ({ editor }) => {
        const { $from, empty } = editor.state.selection
        if (!empty) return false
        const before = $from.nodeBefore
        if (before?.type.name !== this.name) return false
        const label = `/${titleCaseSlug(String(before.attrs.slug))}`
        const from = $from.pos - before.nodeSize
        editor.chain().deleteRange({ from, to: $from.pos }).insertContentAt(from, label.slice(0, -1)).run()
        return true
      }
    }
  }
})

/** `@Title`: a note mentioned from the "@" menu (or dropped onto the bar). */
export const MentionNode = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { id: { default: '' }, title: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'span[data-mention]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-mention': node.attrs.id, class: 'chat-mention-node', contenteditable: 'false' }),
      ['span', { class: 'chat-mention-at' }, '@'],
      String(node.attrs.title || 'New note')
    ]
  },
  renderText({ node }) {
    return `@${node.attrs.title || 'New note'}`
  }
})

/** Keys the chat bar handles itself; each returns true when it used the key. */
export interface ChatKeyHandlers {
  enter(mod: { shift: boolean; mod: boolean }): boolean
  arrow(dir: 'up' | 'down'): boolean
  tab(): boolean
  escape(): boolean
}

// `handlers` is a getter, not a ref: configure() deep-merges plain objects (a ref would be copied with its first
// value), while functions are kept as they are.
export const ChatKeymap = Extension.create<{ handlers: () => ChatKeyHandlers | null }>({
  name: 'chatKeymap',
  priority: 1000,
  addOptions() {
    return { handlers: () => null }
  },
  addKeyboardShortcuts() {
    const h = (): ChatKeyHandlers | null => this.options.handlers()
    return {
      Enter: () => h()?.enter({ shift: false, mod: false }) ?? false,
      'Shift-Enter': () => h()?.enter({ shift: true, mod: false }) ?? false,
      'Mod-Enter': () => h()?.enter({ shift: false, mod: true }) ?? false,
      ArrowUp: () => h()?.arrow('up') ?? false,
      ArrowDown: () => h()?.arrow('down') ?? false,
      'Ctrl-p': () => h()?.arrow('up') ?? false,
      'Ctrl-n': () => h()?.arrow('down') ?? false,
      Tab: () => h()?.tab() ?? false,
      Escape: () => h()?.escape() ?? false
    }
  }
})

/** Insert plain text as paragraphs (pasted rich text arrives without its formatting). */
export function insertPlainText(editor: Editor, text: string): void {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length === 1) {
    editor.chain().focus().insertContent(lines[0]).run()
    return
  }
  editor
    .chain()
    .focus()
    .insertContent(lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })))
    .run()
}

/** The text of the paragraph up to the cursor, with atoms as placeholders so they never trigger a menu. */
export function textBeforeCursor(editor: Editor): string {
  const { $from } = editor.state.selection
  return $from.parent.textBetween(0, $from.parentOffset, '\n', '￼')
}

/** What the editor sends: its text (recipes as /slug, mentions as @Title) and the notes it mentions. */
export function serialize(editor: Editor): { text: string; mentions: { id: string; title: string }[] } {
  const mentions: { id: string; title: string }[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'mention' && node.attrs.id && !mentions.some((m) => m.id === node.attrs.id)) mentions.push({ id: String(node.attrs.id), title: String(node.attrs.title) })
  })
  return { text: editor.getText({ blockSeparator: '\n' }).trim(), mentions }
}
