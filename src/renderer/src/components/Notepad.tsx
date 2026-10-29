import { useEffect, useRef, type ReactNode } from 'react'
import { EditorContent, useEditor, type Editor, type Extensions } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { docToMarkdown, docToPlainText, type PMNode } from '@shared/markdown'

export interface NotepadChange {
  notes: PMNode
  notes_plain: string
  notes_markdown: string
}

/** The note editor's schema: shared by My notes and the enhanced notes, which are edited the same way. */
export function noteExtensions(): Extensions {
  return [StarterKit.configure({ heading: { levels: [1, 2, 3] }, link: { openOnClick: false, autolink: true } }), TaskList, TaskItem.configure({ nested: true })]
}

/** Ctrl+click opens links in the browser. */
export function useCtrlClickLinks(editor: Editor | null): void {
  useEffect(() => {
    const el = editor?.view.dom
    if (!el) return
    const onClick = (e: MouseEvent): void => {
      const a = (e.target as HTMLElement).closest('a')
      if (a && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        window.open(a.href)
      }
    }
    el.addEventListener('click', onClick)
    return () => el.removeEventListener('click', onClick)
  }, [editor])
}

/** The user's own notepad (TipTap/ProseMirror), saved as JSON plus Markdown and plain text. */
export function Notepad({
  documentId,
  initial,
  onChange,
  onReady,
  placeholder
}: {
  documentId: string
  initial: unknown
  onChange: (c: NotepadChange) => void
  /** Gets the editor once it exists (and null when it goes away), so agent edits can be applied to it. */
  onReady?: (editor: Editor | null) => void
  placeholder: string
}): ReactNode {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const editor = useEditor(
    {
      extensions: [...noteExtensions(), Placeholder.configure({ placeholder })],
      content: (initial as object | null) ?? '',
      autofocus: initial ? false : 'end',
      onUpdate: ({ editor }) => {
        const json = editor.getJSON() as PMNode
        onChangeRef.current({ notes: json, notes_plain: docToPlainText(json), notes_markdown: docToMarkdown(json) })
      }
    },
    [documentId]
  )

  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  useEffect(() => {
    onReadyRef.current?.(editor)
    return () => onReadyRef.current?.(null)
  }, [editor])

  useCtrlClickLinks(editor)

  return <EditorContent editor={editor} className="notepad selectable" />
}
