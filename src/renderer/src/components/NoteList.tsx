import { useState, type ReactNode } from 'react'
import { FileText, FolderPlus, GraduationCap, MoreHorizontal, Trash2 } from 'lucide-react'
import { call, errorMessage } from '../lib/api'
import { navigate } from '../lib/router'
import { groupByDay, timeLabel } from '../lib/format'
import { useApp } from '../store'
import { ConfirmDialog, DancingBars, Menu, MenuItem, MenuLabel, MenuSeparator, MenuCheckItem, cn } from './oats'
import { NOTE_DRAG_TYPE } from './chat/drag'
import type { DocumentSummary } from '@shared/types'

/** Notes grouped by day, as on Granola's home: a small date header, then rows. */
export function NoteList({ documents, empty }: { documents: DocumentSummary[]; empty: ReactNode }): ReactNode {
  if (documents.length === 0) return <>{empty}</>
  return (
    <div role="list" aria-label="Notes">
      {groupByDay(documents, (d) => d.calendar_event?.start ?? d.created_at).map((g) => (
        <section key={g.label}>
          <h3 className="px-2 pt-6 pb-1 text-xs font-medium text-ink-secondary select-none">{g.label}</h3>
          {g.items.map((d) => (
            <div key={d.id} role="listitem" className="pb-1">
              <NoteRow doc={d} />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

function NoteTile({ doc, live }: { doc: DocumentSummary; live: boolean }): ReactNode {
  return (
    <span className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-highlight text-ink-tertiary ring-[0.75px] ring-black/5 ring-inset dark:ring-white/5">
      {live ? <DancingBars active level={useApp.getState().levels.microphone} className="scale-75" /> : doc.mode === 'lecture' ? <GraduationCap size={16} /> : <FileText size={16} />}
    </span>
  )
}

function subtitle(doc: DocumentSummary): string {
  const time = timeLabel(doc.calendar_event?.start ?? doc.created_at)
  const people = doc.calendar_event?.attendees.map((a) => a.name || a.email.replace(/@.*/, '')) ?? []
  const rest = people.length ? (people.length > 2 ? `${people.slice(0, 2).join(', ')} +${people.length - 2}` : people.join(', ')) : doc.preview || (doc.has_transcript ? 'Transcript' : '')
  return rest ? `${time} ∙ ${rest}` : time
}

export function NoteRow({ doc }: { doc: DocumentSummary }): ReactNode {
  const recording = useApp((s) => s.recording)
  const levels = useApp((s) => s.levels)
  const folders = useApp((s) => s.folders)
  const showToast = useApp((s) => s.showToast)
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const live = recording.document_id === doc.id && recording.status === 'recording'
  const open = (): void => navigate(`/note/${doc.id}`)

  return (
    <div
      data-testid="note-list-item"
      data-popup-open={menuOpen ? '' : undefined}
      draggable
      onDragStart={(e) => {
        // The row's menu and dialog are portals: their events bubble here through React but aren't the row's.
        if (!e.currentTarget.contains(e.target as Node)) return
        // Dropped on a chat bar, the note becomes an @-mention there.
        e.dataTransfer.setData(NOTE_DRAG_TYPE, JSON.stringify({ id: doc.id, title: doc.title || doc.calendar_event?.title || 'New note' }))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return
        if ((e.target as Element).closest('button, a, [role="menuitem"]')) return
        open()
      }}
      className={cn(
        'group/note-item relative flex scroll-mt-[100px] flex-col rounded-xl py-[5px] pr-2 pl-2 select-none ring-focus-ring-inset-within',
        menuOpen ? 'bg-highlight-faint' : 'hover:bg-highlight-faint has-focus-visible:bg-highlight-faint'
      )}
    >
      <div className="flex w-full flex-row items-center">
        <div className="relative mr-4">
          {live ? (
            <span className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-tint-accent">
              <DancingBars active level={Math.max(levels.microphone, levels.system)} className="scale-[0.8]" />
            </span>
          ) : (
            <NoteTile doc={doc} live={false} />
          )}
        </div>
        <div className="mr-2 flex-1 overflow-hidden">
          <button type="button" data-testid="note-item-title" data-focus-ring-target="" onClick={open} className="block w-full cursor-default truncate text-start text-base text-ink-primary outline-none">
            {doc.title || doc.calendar_event?.title || 'New note'}
          </button>
          <div className="truncate text-xs text-ink-secondary">{subtitle(doc)}</div>
        </div>
        <div className="relative flex items-center">
          {doc.has_panels && !live && <span className="mr-1 size-1.5 rounded-full bg-ink-accent/60 transition-opacity group-hover/note-item:opacity-0" title="Enhanced" />}
          <div className={cn('absolute inset-y-0 right-0 flex items-center justify-end opacity-0 group-hover/note-item:opacity-100 group-has-focus-visible/note-item:opacity-100', menuOpen && 'opacity-100')}>
            <Menu
              align="end"
              open={menuOpen}
              onOpenChange={setMenuOpen}
              trigger={
                <button
                  type="button"
                  data-testid="note-menu-button"
                  aria-label="Note options"
                  className={cn(
                    'mr-0.5 flex size-7 cursor-default items-center justify-center rounded-full ring-focus-ring outline-none',
                    menuOpen ? 'bg-highlight-faint text-ink-secondary' : 'text-ink-tertiary hover:bg-highlight-faint hover:text-ink-secondary'
                  )}
                >
                  <MoreHorizontal size={16} />
                </button>
              }
            >
              <MenuLabel>Add to folder</MenuLabel>
              {folders.length === 0 && (
                <MenuItem onClick={() => navigate('/folder/all')}>
                  <FolderPlus size={16} /> Create a folder in the sidebar
                </MenuItem>
              )}
              {folders.map((f) => {
                const inFolder = doc.folder_ids?.includes(f.id) ?? false
                return (
                  <MenuCheckItem
                    key={f.id}
                    checked={inFolder}
                    onClick={() => void call(inFolder ? 'folders:remove-document' : 'folders:add-document', f.id, doc.id).catch((e) => showToast('error', errorMessage(e)))}
                  >
                    {f.title}
                  </MenuCheckItem>
                )
              })}
              <MenuSeparator />
              <MenuItem danger onClick={() => setConfirmDelete(true)}>
                <Trash2 size={16} /> Delete note
              </MenuItem>
            </Menu>
          </div>
        </div>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this note?"
        description="Its transcript and enhanced notes are deleted too."
        confirmLabel="Delete"
        danger
        onConfirm={() => void call('documents:delete', doc.id).catch((e) => showToast('error', errorMessage(e)))}
      />
    </div>
  )
}
