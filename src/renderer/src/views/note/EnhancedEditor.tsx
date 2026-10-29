import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { TextQuote } from 'lucide-react'
import { canExplainLine } from '@shared/transcriptSummary'
import { docToMarkdown, type PMNode } from '@shared/markdown'
import { call, errorMessage } from '../../lib/api'
import { throttle } from '../../lib/throttle'
import { useApp } from '../../store'
import { noteExtensions, useCtrlClickLinks } from '../../components/Notepad'
import { GeneratedLines } from '../../components/editor/generatedLines'
import { motion } from '../../components/oats'
import { TranscriptSummaryPopover } from './TranscriptSummaryPopover'
import type { NoteMode, Panel, TranscriptChunk } from '@shared/types'

// Finished enhanced notes, editable like My notes (Granola's enhanced panel is a TipTap editor too). Edits save as
// TipTap JSON at most once a second. Lines the AI wrote are grey until edited. Hovering a paragraph shows a button
// in its right gutter that opens the Transcript Summary for that line.

/** Saves at most this often while typing (Granola's enhanced-notes throttle). */
const SAVE_MS = 1000

export interface EnhancedEditorHandle {
  /** Save pending edits now (before a rewrite or regenerate replaces the notes). */
  flush: () => void
  /** The notes as Markdown, as they are in the editor. */
  markdown: () => string
}

interface Hovered {
  top: number
  text: string
}

export const EnhancedEditor = forwardRef<
  EnhancedEditorHandle,
  {
    panel: Panel
    chunks: TranscriptChunk[]
    mode: NoteMode
    recording: boolean
    onOpenQuote: (chunkId: string) => void
  }
>(function EnhancedEditor({ panel, chunks, mode, recording, onOpenQuote }, ref): ReactNode {
  const { upsertPanel, showToast } = useApp.getState()
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [hovered, setHovered] = useState<Hovered | null>(null)
  const [explaining, setExplaining] = useState<{ anchor: HTMLElement; text: string } | null>(null)
  const hasTranscript = chunks.some((c) => c.is_final)

  // The panel's generated lines are fixed for this editor: a regenerated panel remounts it (see EnhancedView).
  const generated = useMemo(() => new Set(panel.generated_lines), [panel.id])
  const save = useMemo(
    () =>
      throttle((json: PMNode) => {
        call('panels:update', panel.id, { content_json: json })
          .then(upsertPanel)
          .catch((e) => {
            // A deleted panel can't be saved; anything else is worth saying.
            if (useApp.getState().panels[panel.document_id]?.some((p) => p.id === panel.id)) showToast('error', `Could not save: ${errorMessage(e)}`)
          })
      }, SAVE_MS),
    [panel.id, panel.document_id, upsertPanel, showToast]
  )
  useEffect(() => () => save.flush(), [save])

  const editor = useEditor(
    {
      extensions: [...noteExtensions(), GeneratedLines.configure({ isGenerated: (text) => generated.has(text) })],
      content: (panel.content_json as object | null) ?? '',
      autofocus: false,
      onUpdate: ({ editor }) => save(editor.getJSON() as PMNode)
    },
    [panel.id]
  )
  useCtrlClickLinks(editor)
  useImperativeHandle(ref, () => ({ flush: save.flush, markdown: () => (editor ? docToMarkdown(editor.getJSON() as PMNode) : panel.content) }), [save, editor, panel.content])

  const onMouseMove = (e: React.MouseEvent): void => {
    if (explaining || !hasTranscript || !wrap.current) return
    const target = e.target as HTMLElement
    if (button.current?.contains(target)) return
    const p = target.closest<HTMLElement>('.ProseMirror p')
    if (!p) {
      // Over a heading or another block: that row has no button. Between rows: keep the last one.
      if (target.closest('.ProseMirror :is(h1, h2, h3, pre, hr, li, blockquote)')) setHovered(null)
      return
    }
    const text = p.textContent ?? ''
    if (!canExplainLine(text)) return setHovered(null)
    const top = p.getBoundingClientRect().top - wrap.current.getBoundingClientRect().top
    if (hovered?.top !== top || hovered.text !== text) setHovered({ top, text })
  }

  return (
    <div ref={wrap} className="relative" onMouseMove={onMouseMove} onMouseLeave={() => !explaining && setHovered(null)}>
      <EditorContent editor={editor} className="notepad enhanced-notes selectable" />
      {hovered && (
        <motion.button
          ref={button}
          key={hovered.top}
          type="button"
          data-testid="transcript-summary-button"
          aria-label="Transcript summary"
          title="Where this came from"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.12 }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => setExplaining({ anchor: e.currentTarget, text: hovered.text })}
          className="absolute right-0 grid size-6 cursor-default place-items-center rounded-md text-ink-tertiary hover:bg-highlight hover:text-ink-primary data-[open]:bg-highlight data-[open]:text-ink-primary"
          data-open={explaining ? '' : undefined}
          style={{ top: hovered.top }}
        >
          <TextQuote size={14} />
        </motion.button>
      )}
      {explaining && (
        <TranscriptSummaryPopover
          anchor={explaining.anchor}
          documentId={panel.document_id}
          line={explaining.text}
          chunks={chunks}
          mode={mode}
          recording={recording}
          onClose={() => {
            setExplaining(null)
            setHovered(null)
          }}
          onOpenQuote={(chunkId) => {
            setExplaining(null)
            setHovered(null)
            onOpenQuote(chunkId)
          }}
        />
      )}
    </div>
  )
})
