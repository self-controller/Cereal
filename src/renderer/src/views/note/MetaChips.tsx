import type { ReactNode } from 'react'
import { CalendarDays, Folder, GraduationCap, LayoutTemplate, Users, Video } from 'lucide-react'
import { call, errorMessage } from '../../lib/api'
import { longDate, timeLabel } from '../../lib/format'
import { useApp } from '../../store'
import { AnimatePresence, Avatar, Button, Menu, MenuCheckItem, MenuItem, MenuLabel, MenuSeparator, Popover, buttonClass, cn, motion } from '../../components/oats'
import { useUi } from '../../components/shell/layout'
import { identifiableSpeakers } from '@shared/speakers'
import type { CerealDocument, DocumentPatch, NoteMode } from '@shared/types'
import { SpeakersChip, useNoteSpeakers } from './SpeakersChip'

// The note's options, in the row under the title (docs/granola-ui.md §Note page): date and attendees, speakers (once
// the transcript tells voices apart), recording mode, folder and template. Hairline-bordered pills that pop in and out.
const CHIP = 'group flex h-7 max-w-56 min-w-0 cursor-default items-center gap-1 truncate rounded-full border pr-2 pl-2.5 font-book text-sm text-ink-secondary outline-none ring-focus-ring select-none hover:bg-fill-highlight data-popup-open:bg-highlight [&>svg]:shrink-0 [&>svg]:text-ink-secondary'

const MODES: { mode: NoteMode; label: string; hint: string }[] = [
  { mode: 'meeting', label: 'Meeting', hint: 'Your mic and the call audio' },
  { mode: 'lecture', label: 'Lecture', hint: 'Your mic only, for lectures and talks in the room' }
]

function Pop({ children, k }: { children: ReactNode; k: string }): ReactNode {
  return (
    <motion.div key={k} layout="position" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.2, ease: 'easeInOut' }} className="flex shrink-0">
      {children}
    </motion.div>
  )
}

export function MetaChips({ doc, onChange, recording, selectedSlug }: { doc: CerealDocument; onChange: (d: CerealDocument) => void; recording: boolean; selectedSlug: string }): ReactNode {
  const folders = useApp((s) => s.folders)
  const templates = useApp((s) => s.templates)
  const showToast = useApp((s) => s.showToast)
  const event = doc.calendar_event
  const current = folders.filter((f) => doc.folder_ids.includes(f.id))
  const mode = MODES.find((m) => m.mode === doc.mode) ?? MODES[0]
  const template = templates.find((t) => t.slug === selectedSlug)
  const people = doc.people.map((p) => p.name || p.email)
  const speakers = useNoteSpeakers()
  const showSpeakers = !!speakers && identifiableSpeakers(speakers.view).length > 0

  const update = async (patch: DocumentPatch): Promise<void> => {
    try {
      onChange(await call('documents:update', doc.id, patch))
    } catch (e) {
      showToast('error', errorMessage(e))
    }
  }

  return (
    <div className="contents">
      <AnimatePresence mode="popLayout" initial={false}>
        <Pop k="date">
          <Popover
            align="start"
            className="w-[280px] p-0"
            trigger={
              <button type="button" className={CHIP} data-testid="date-attendees-chip">
                <CalendarDays size={16} />
                <span className="truncate">{new Date(event?.start ?? doc.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                {people.length > 0 && (
                  <>
                    <Users size={16} className="ml-1 shrink-0 text-ink-secondary" />
                    <span>{people.length}</span>
                  </>
                )}
              </button>
            }
          >
            <div className="border-b border-hairline px-3 py-2.5">
              <div className="text-sm text-ink-primary">{event?.title || doc.title || 'New note'}</div>
              <div className="mt-0.5 text-xs text-ink-secondary">
                {longDate(event?.start ?? doc.created_at)}
                {event && ` · ${timeLabel(event.start)}–${timeLabel(event.end)}`}
              </div>
            </div>
            <div className="max-h-[280px] overflow-y-auto p-1">
              {people.length === 0 && <div className="p-2 text-sm text-ink-secondary">No attendees</div>}
              {doc.people.map((p) => (
                <div key={p.email} className="flex items-center gap-2 rounded-md p-1">
                  <Avatar name={p.name || p.email} size={20} />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm leading-4 text-ink-primary">{p.name || p.email}</span>
                    {p.name && <span className="truncate text-xs leading-4 text-ink-secondary">{p.email}</span>}
                  </div>
                </div>
              ))}
            </div>
            {event?.meetingUrl && (
              <div className="border-t border-hairline p-2">
                <Button variant="soft" className="w-full" onClick={() => void call('app:open-external', event.meetingUrl!)}>
                  <Video size={16} /> Join call
                </Button>
              </div>
            )}
          </Popover>
        </Pop>
        {showSpeakers && (
          <Pop k="speakers">
            <SpeakersChip className={CHIP} />
          </Pop>
        )}
        <Pop k="mode">
          <Menu
            align="start"
            trigger={
              <button type="button" className={cn(CHIP, recording && 'pointer-events-none opacity-60')} disabled={recording} title={recording ? 'Stop transcribing to change the mode' : undefined}>
                {doc.mode === 'lecture' ? <GraduationCap size={16} /> : <Users size={16} />}
                <span className="truncate">{mode.label}</span>
              </button>
            }
          >
            {MODES.map((m) => (
              <MenuCheckItem key={m.mode} checked={m.mode === doc.mode} onClick={() => m.mode !== doc.mode && void update({ mode: m.mode })}>
                <span className="min-w-0 flex-1">
                  <span className="block">{m.label}</span>
                  <span className="block text-xs text-ink-secondary">{m.hint}</span>
                </span>
              </MenuCheckItem>
            ))}
          </Menu>
        </Pop>
        <Pop k="folder">
          <Menu
            align="start"
            trigger={
              <button type="button" className={CHIP} data-testid="folder-chip">
                <Folder size={16} />
                <span className="truncate">{current.length ? current.map((f) => f.title).join(', ') : 'Add to folder'}</span>
              </button>
            }
          >
            <MenuLabel>Folders</MenuLabel>
            {folders.length === 0 && <div className="px-2 py-1.5 text-sm text-ink-secondary">No folders yet. Create one in the sidebar.</div>}
            {folders.map((f) => {
              const inFolder = doc.folder_ids.includes(f.id)
              return (
                <MenuCheckItem
                  key={f.id}
                  checked={inFolder}
                  onClick={async () => {
                    await call(inFolder ? 'folders:remove-document' : 'folders:add-document', f.id, doc.id)
                    onChange({ ...doc, folder_ids: inFolder ? doc.folder_ids.filter((x) => x !== f.id) : [...doc.folder_ids, f.id] })
                  }}
                >
                  {f.title}
                </MenuCheckItem>
              )
            })}
          </Menu>
        </Pop>
        <Pop k="template">
          <Menu
            align="start"
            trigger={
              <button type="button" className={cn(buttonClass('ghost', 'md'), 'max-w-48 gap-1 pr-2.5 pl-2')} data-testid="template-chip">
                <LayoutTemplate size={16} />
                <span className="truncate">{template?.title ?? 'Template'}</span>
              </button>
            }
          >
            <MenuLabel>Template for enhanced notes</MenuLabel>
            {templates.map((t) => (
              <MenuCheckItem key={t.slug} checked={t.slug === selectedSlug} onClick={() => void update({ selected_template: t.slug })}>
                {t.title}
              </MenuCheckItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={() => useUi.getState().openTemplates({ slug: selectedSlug, onApply: (slug) => void update({ selected_template: slug }) })}>
              <LayoutTemplate size={16} /> Browse templates…
            </MenuItem>
          </Menu>
        </Pop>
      </AnimatePresence>
    </div>
  )
}
