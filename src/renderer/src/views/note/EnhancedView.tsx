import { useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Copy, LayoutTemplate, PenLine, RefreshCw, Trash2 } from 'lucide-react'
import { call, errorMessage } from '../../lib/api'
import { useApp } from '../../store'
import { Markdown } from '../../components/Markdown'
import { Button, Dialog, FoldAway, GrowHeight, LoopMark, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator, SubMenu, Textarea, motion } from '../../components/oats'
import { useUi } from '../../components/shell/layout'
import { EnhancedEditor, type EnhancedEditorHandle } from './EnhancedEditor'
import type { NoteMode, Panel, Template, TranscriptChunk } from '@shared/types'

// While notes are written (docs/granola-motion.md §Enhanced notes): each finished block blurs in and the column grows
// smoothly; a status pill marks where the writing is; the user's own notes wait underneath with a grey band sweeping
// down them, and when the new notes are done they fold up into them.

/**
 * The floating status while notes are written. It sits where the writing happens and, once that scrolls below the chat
 * bar, sticks just above the bar; clicking it scrolls back to the writing.
 */
function EnhanceStatus({ message }: { message: string }): ReactNode {
  const writing = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={writing} />
      <div className="sticky bottom-[calc(var(--floating-chat-h,72px)+14px)] z-30 mb-2 flex h-10 justify-center">
        <motion.button
          type="button"
          data-slot="enhance-status"
          aria-live="polite"
          onClick={() => void writing.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })}
          initial={{ opacity: 0, scale: 0.96, filter: 'blur(2px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="flex h-10 w-full max-w-[41.5rem] items-center gap-2.5 rounded-full bg-surface-elevated pr-4 pl-3 text-sm font-medium text-ink-primary shadow-bottom-bar ring-[0.5px] ring-hairline dark:ring-inset"
        >
          <LoopMark className="text-ink-secondary" />
          <span className="min-w-0 truncate">{message}</span>
        </motion.button>
      </div>
    </>
  )
}

/** The user's notes beneath the notes being written from them, with a grey band sweeping down through the lines. */
function NotesEcho({ markdown }: { markdown: string }): ReactNode {
  return (
    <div inert aria-hidden data-testid="notes-echo" className="pt-2 pb-4">
      <Markdown text={markdown} reveal="pulse" />
    </div>
  )
}

export function EnhancedView({
  panel,
  chunks,
  mode,
  recording,
  editor,
  notesMarkdown,
  notesPlain,
  onRetry,
  onOpenQuote
}: {
  panel: Panel
  chunks: TranscriptChunk[]
  mode: NoteMode
  recording: boolean
  editor: React.Ref<EnhancedEditorHandle>
  /** The user's own notes, shown beneath the new notes while they are written. */
  notesMarkdown: string
  notesPlain: string
  onRetry: () => void
  onOpenQuote: (chunkId: string) => void
}): ReactNode {
  const generating = !panel.generation_finished_at && !panel.generation_failed_at
  // While streaming, show the finished lines only: the last one is still being written.
  const preview = generating ? panel.content.slice(0, Math.max(0, panel.content.lastIndexOf('\n'))) : ''
  const status = !preview ? (chunks.length ? 'Analyzing transcript' : 'Reading your notes') : notesPlain.length > 20 ? 'Enhancing notes' : 'Writing notes'

  return (
    <div className="pt-2">
      {panel.error && (
        <div className="mb-4 flex items-start gap-3 rounded-xl bg-surface-sunken px-4 py-3 text-sm text-ink-secondary ring ring-hairline">
          <span className="flex-1 text-ink-danger">{panel.error}</span>
          <Button size="sm" variant="soft" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
      {generating ? (
        <>
          <GrowHeight>
            <Markdown text={preview} reveal="blur-in" />
          </GrowHeight>
          <EnhanceStatus message={status} />
        </>
      ) : (
        panel.content_json && (
          <EnhancedEditor
            ref={editor}
            key={`${panel.id}:${panel.generation_finished_at ?? panel.generation_failed_at}`}
            panel={panel}
            chunks={chunks}
            mode={mode}
            recording={recording}
            onOpenQuote={onOpenQuote}
          />
        )
      )}
      <FoldAway key={panel.id} active={generating} fold={!!panel.generation_finished_at}>
        {notesMarkdown.trim() && <NotesEcho markdown={notesMarkdown} />}
      </FoldAway>
      {!generating && panel.content_json && (
        <p className="mt-8 text-xs text-ink-tertiary">
          <span className="text-ink-primary">Your notes</span> are shown in full colour; grey lines were added by AI.
        </p>
      )}
    </div>
  )
}

/** The Enhanced tab's chevron menu: switch between versions, regenerate with a template, rewrite, copy, delete. */
export function EnhancedMenu({
  trigger,
  panels,
  panel,
  templates,
  onSelect,
  onRegenerate,
  onFlush,
  content,
  onDeleted
}: {
  trigger: ReactElement
  panels: Panel[]
  panel: Panel
  templates: Template[]
  onSelect: (id: string) => void
  onRegenerate: (slug: string) => void
  /** Save edits still waiting in the editor, before the notes are copied or rewritten. */
  onFlush: () => void
  /** The notes as Markdown, including edits not saved yet. */
  content: () => string
  onDeleted: () => void
}): ReactNode {
  const showToast = useApp((s) => s.showToast)
  const upsertPanel = useApp((s) => s.upsertPanel)
  const [rewrite, setRewrite] = useState<string | null>(null)
  const generating = !panel.generation_finished_at && !panel.generation_failed_at

  return (
    <>
      <Menu trigger={trigger} align="start">
        {panels.length > 1 && (
          <>
            <MenuLabel>Versions</MenuLabel>
            {[...panels].reverse().map((p) => (
              <MenuCheckItem key={p.id} checked={p.id === panel.id} onClick={() => onSelect(p.id)}>
                <span className="min-w-0 flex-1 truncate">{p.title}</span>
              </MenuCheckItem>
            ))}
            <MenuSeparator />
          </>
        )}
        <SubMenu
          label={
            <>
              <RefreshCw size={16} className="text-ink-secondary" /> Regenerate with…
            </>
          }
        >
          {templates.map((t) => (
            <MenuCheckItem key={t.slug} checked={t.slug === panel.template_slug} onClick={() => onRegenerate(t.slug)} disabled={generating}>
              {t.title}
            </MenuCheckItem>
          ))}
          <MenuSeparator />
          <MenuItem onClick={() => useUi.getState().openTemplates({ onApply: onRegenerate })}>
            <LayoutTemplate size={16} /> Browse templates…
          </MenuItem>
        </SubMenu>
        <MenuItem disabled={generating} onClick={() => setRewrite('')}>
          <PenLine size={16} /> Rewrite with instructions…
        </MenuItem>
        <MenuItem
          onClick={() => {
            void navigator.clipboard.writeText(content())
            showToast('info', 'Copied as Markdown')
          }}
        >
          <Copy size={16} /> Copy
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          onClick={async () => {
            await call('panels:delete', panel.id)
            onDeleted()
          }}
        >
          <Trash2 size={16} /> Delete these notes
        </MenuItem>
      </Menu>
      <Dialog
        open={rewrite !== null}
        onOpenChange={(o) => !o && setRewrite(null)}
        title="Rewrite these notes"
        description="Say how to change them. The rewrite is added as a new version."
        className="sm:max-w-md"
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              onFlush()
              upsertPanel(await call('panels:rewrite', panel.id, rewrite ?? ''))
              setRewrite(null)
            } catch (err) {
              showToast('error', errorMessage(err))
            }
          }}
        >
          <Textarea autoFocus rows={3} size="sm" value={rewrite ?? ''} onChange={(e) => setRewrite(e.target.value)} placeholder="e.g. Make it shorter and focus on decisions. Write it in Spanish." />
          <div className="flex justify-end gap-2">
            <Button variant="soft" onClick={() => setRewrite(null)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!rewrite?.trim()}>
              Rewrite
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  )
}
