import { useEffect, useState, type ReactNode } from 'react'
import { Folder, MoreHorizontal, NotebookText, Pencil, SquarePen, Trash2 } from 'lucide-react'
import { call, errorMessage } from '../lib/api'
import { navigate } from '../lib/router'
import { useApp } from '../store'
import { NoteList } from '../components/NoteList'
import { FloatingChat } from '../components/FloatingChat'
import { Button, ConfirmDialog, IconButton, Menu, MenuItem, Tooltip } from '../components/oats'
import { ToolbarContent } from '../components/shell/Toolbar'
import type { DocumentSummary } from '@shared/types'

/** A folder's notes, or (id "all") every note: Granola's list page. */
export function FolderView({ id }: { id: string }): ReactNode {
  const all = id === 'all'
  const folder = useApp((s) => s.folders.find((f) => f.id === id))
  const allDocs = useApp((s) => s.documents)
  const showToast = useApp((s) => s.showToast)
  const [docs, setDocs] = useState<DocumentSummary[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    if (all) setDocs(allDocs)
    else void call('documents:list', { folderId: id }).then(setDocs)
  }, [id, all, allDocs])

  if (!all && !folder) return <div className="p-10 pt-20 text-sm text-ink-secondary">Folder not found.</div>
  const title = all ? 'My notes' : folder!.title

  const newNote = async (): Promise<void> => {
    try {
      const doc = await call('documents:create', all ? {} : { folder_id: id })
      navigate(`/note/${doc.id}`)
    } catch (e) {
      showToast('error', errorMessage(e))
    }
  }

  return (
    <div className="@container/view relative flex h-full min-h-0">
      <ToolbarContent>
        <div className="flex-1" />
        <Tooltip content="New note" kbd="Ctrl N">
          <Button variant="outline" className="pr-3 pl-1.5" onClick={() => void newNote()}>
            <SquarePen size={16} className="text-ink-secondary" />
            New note
          </Button>
        </Tooltip>
      </ToolbarContent>
      <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-scroll pt-11 pb-28">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6">
          <div className="mt-3 flex items-center gap-3 px-2">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-highlight text-ink-secondary">{all ? <NotebookText size={20} /> : <Folder size={20} />}</span>
            {editing !== null ? (
              <input
                autoFocus
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                onBlur={async () => {
                  if (editing.trim() && editing !== folder?.title) await call('folders:rename', id, editing.trim())
                  setEditing(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditing(null)
                }}
                className="min-w-0 flex-1 bg-transparent text-h3 text-ink-primary outline-none"
              />
            ) : (
              <h1 className="min-w-0 flex-1 truncate text-h3 text-ink-primary" onDoubleClick={() => !all && setEditing(title)}>
                {title}
              </h1>
            )}
            {!all && (
              <Menu
                align="end"
                trigger={
                  <IconButton label="Folder options">
                    <MoreHorizontal size={16} />
                  </IconButton>
                }
              >
                <MenuItem onClick={() => setEditing(title)}>
                  <Pencil size={16} /> Rename
                </MenuItem>
                <MenuItem danger onClick={() => setConfirmDelete(true)}>
                  <Trash2 size={16} /> Delete folder
                </MenuItem>
              </Menu>
            )}
          </div>
          <NoteList
            documents={docs}
            empty={<p className="mt-6 rounded-2xl px-4 py-6 text-center text-sm text-ink-secondary ring ring-hairline dark:ring-inset">{all ? 'No notes yet.' : 'No notes here yet. Use a note’s folder chip, or its menu on Home, to add it.'}</p>}
          />
        </div>
      </div>
      <FloatingChat surface="global" title="any of your meetings" />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${title}”?`}
        description="The folder is removed. Notes inside it are kept."
        confirmLabel="Delete folder"
        danger
        onConfirm={async () => {
          await call('folders:delete', id)
          navigate('/')
        }}
      />
    </div>
  )
}
