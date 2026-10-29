import { Fragment, useEffect, useState, type ReactNode } from 'react'
import { CalendarDays, CalendarPlus, Settings2, SquarePen, Video } from 'lucide-react'
import { call, errorMessage } from '../lib/api'
import { navigate } from '../lib/router'
import { dayLabel, relativeStart, timeLabel } from '../lib/format'
import { useApp } from '../store'
import { Button, IconButton, Tooltip, cn } from '../components/oats'
import { ToolbarContent } from '../components/shell/Toolbar'
import { NoteList } from '../components/NoteList'
import { FloatingChat } from '../components/FloatingChat'
import type { CalendarEvent } from '@shared/types'

export async function createNote(): Promise<void> {
  try {
    const doc = await call('documents:create', {})
    navigate(`/note/${doc.id}`)
  } catch (e) {
    useApp.getState().showToast('error', errorMessage(e))
  }
}

/** The toolbar's "New note" button, as on Granola's home. */
export function NewNoteButton(): ReactNode {
  return (
    <ToolbarContent>
      <div className="flex-1" />
      <Tooltip content="New note" kbd="Ctrl N">
        <Button variant="outline" className="pr-3 pl-1.5" onClick={() => void createNote()} data-testid="new-note-button">
          <SquarePen size={16} className="text-ink-secondary" />
          New note
        </Button>
      </Tooltip>
    </ToolbarContent>
  )
}

export function HomeView(): ReactNode {
  const documents = useApp((s) => s.documents)
  const refreshDocuments = useApp((s) => s.refreshDocuments)
  const refreshUpcoming = useApp((s) => s.refreshUpcoming)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void Promise.all([refreshDocuments(), refreshUpcoming()]).then(() => setLoaded(true))
  }, [refreshDocuments, refreshUpcoming])

  return (
    <div className="@container/view relative flex h-full min-h-0">
      <NewNoteButton />
      <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-y-scroll pt-11 pb-28" data-testid="note-scroll-container">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-6">
          <ComingUp />
          {loaded && (
            <NoteList
              documents={documents}
              empty={
                <div className="mt-6 rounded-2xl px-6 py-10 text-center ring ring-hairline dark:ring-inset">
                  <p className="text-h3">Your notes will live here</p>
                  <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-secondary">
                    Start a note when a meeting begins. Write the few things that matter to you, then <span className="text-ink-primary">Enhance notes</span> at the end, and Cereal fills in the rest from the
                    transcript.
                  </p>
                  <Button size="lg" className="mt-6" onClick={() => void createNote()}>
                    <SquarePen size={16} /> New note
                  </Button>
                </div>
              }
            />
          )}
        </div>
      </div>
      <FloatingChat surface="global" title="any of your meetings" />
    </div>
  )
}

// --------------------------------------------------------------- coming up

function ComingUp(): ReactNode {
  const upcoming = useApp((s) => s.upcoming)
  const connected = useApp((s) => s.settings?.calendar.connected ?? false)
  const soon = upcoming.filter((e) => Date.parse(e.end) > Date.now()).slice(0, 5)

  return (
    <section className="group/coming-up mt-3">
      <div className="mb-3 flex items-center gap-1 px-2">
        <h2 className="flex-1 text-h3 text-ink-primary">Coming up</h2>
        <Tooltip content="Calendar settings">
          <IconButton
            size="sm"
            label="Calendar settings"
            data-testid="coming-up-settings"
            onClick={() => navigate('/settings/calendar')}
            className="opacity-0 transition-opacity duration-75 group-hover/coming-up:opacity-100 group-has-focus-visible/coming-up:opacity-100"
          >
            <Settings2 size={16} />
          </IconButton>
        </Tooltip>
        <Tooltip content={new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' })}>
          <Button variant="ghost" size="sm" className="text-xs font-medium">
            Today
          </Button>
        </Tooltip>
      </div>
      {soon.length > 0 ? (
        <div className="relative w-full overflow-hidden rounded-2xl bg-surface-elevated/70 p-1 ring ring-hairline dark:ring-inset">
          {soon.map((e, i) => (
            <Fragment key={e.id}>
              {i > 0 && <div className="dashed-rule mx-3 opacity-60" />}
              <UpcomingRow event={e} />
            </Fragment>
          ))}
        </div>
      ) : connected ? (
        <p className="rounded-2xl px-4 py-4 text-sm text-ink-secondary ring ring-hairline dark:ring-inset">Nothing on your calendar for the next few days.</p>
      ) : (
        <button
          type="button"
          onClick={() => navigate('/settings/calendar')}
          className="flex w-full cursor-default items-center gap-4 rounded-2xl px-3 py-2.5 text-left ring ring-hairline outline-none ring-focus-ring-inset hover:bg-highlight-faint dark:ring-inset"
        >
          <span className="flex size-9 items-center justify-center rounded-lg bg-highlight">
            <CalendarPlus size={18} className="text-ink-tertiary" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base leading-5 text-ink-primary">Connect Google Calendar</span>
            <span className="block text-sm text-ink-secondary">See upcoming meetings here and get a reminder to take notes.</span>
          </span>
        </button>
      )}
    </section>
  )
}

function UpcomingRow({ event }: { event: CalendarEvent }): ReactNode {
  const showToast = useApp((s) => s.showToast)
  const live = Date.parse(event.start) <= Date.now()
  const day = dayLabel(event.start)
  const attendees = event.attendees.map((a) => a.name || a.email.replace(/@.*/, ''))
  const who = attendees.length === 0 ? 'No attendees' : attendees.length > 2 ? `${attendees.slice(0, 2).join(', ')} +${attendees.length - 2}` : attendees.join(', ')
  const when = live ? 'Now' : day === 'Today' ? `${timeLabel(event.start)} (${relativeStart(event.start)})` : `${day.split(',')[0]} ${timeLabel(event.start)}`
  const open = async (): Promise<void> => {
    try {
      const doc = await call('documents:for-event', event)
      navigate(`/note/${doc.id}`)
    } catch (e) {
      showToast('error', errorMessage(e))
    }
  }
  return (
    <div className="group/event flex flex-row items-center rounded-xl py-1.5 pr-2 pl-2 select-none hover:bg-highlight-faint">
      <div className="relative mr-4">
        <div className={cn('flex size-9 flex-col items-center justify-center rounded-lg', live ? 'bg-surface-tint-accent text-ink-accent' : 'bg-highlight text-ink-tertiary')}>
          <CalendarDays size={20} />
        </div>
      </div>
      <div className="mr-2 flex-1 overflow-hidden">
        <div className="truncate text-base leading-5 text-ink-primary">{event.title}</div>
        <div className="truncate text-sm text-ink-secondary">
          {who} · {when}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-75 group-hover/event:opacity-100 group-focus-within/event:opacity-100">
        {event.meetingUrl && (
          <Button size="sm" variant="ghost" onClick={() => void call('app:open-external', event.meetingUrl!)}>
            <Video size={14} /> Join
          </Button>
        )}
        <Button size="sm" variant={live ? 'accent' : 'soft'} onClick={() => void open()}>
          Take notes
        </Button>
      </div>
    </div>
  )
}
