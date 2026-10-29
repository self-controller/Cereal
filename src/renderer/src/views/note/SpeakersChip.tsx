import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { AudioLines, Check, RotateCcw, UserRoundPlus } from 'lucide-react'
import { identifiableSpeakers, isSelf, resolveSpeakers, unnamedSpeakers, type Speaker, type SpeakerOrigin, type SpeakerView } from '@shared/speakers'
import { clock } from '@shared/transcript'
import { call, errorMessage } from '../../lib/api'
import { useApp } from '../../store'
import { Avatar, AvatarStack, Button, Popover, cn } from '../../components/oats'
import type { Attendee, CerealDocument, SpeakerAssignment, TranscriptChunk } from '@shared/types'

// Who said what (docs/notion-speakers.md). The engine tells voices apart; this lets the user say who they are: the
// "Identify speakers" chip in the note's options row lists every voice with a sample line, and each transcript bubble's
// speaker label opens the same picker. Names are saved on the note and used everywhere the transcript is shown or sent.

export interface NoteSpeakers {
  view: SpeakerView
  people: Attendee[]
  profile: { name: string; email: string }
  chunk(id: string): TranscriptChunk | undefined
  /** Start of the transcript, for "mm:ss" times. */
  origin: number
  assign(key: string, value: SpeakerAssignment | null): void
  /** Open the transcript at a chunk. */
  jump(chunkId: string): void
}

const SpeakersContext = createContext<NoteSpeakers | null>(null)

export function useNoteSpeakers(): NoteSpeakers | null {
  return useContext(SpeakersContext)
}

export function SpeakersProvider({
  doc,
  chunks,
  onChange,
  onJump,
  children
}: {
  doc: CerealDocument
  chunks: TranscriptChunk[]
  onChange: (doc: CerealDocument) => void
  onJump: (chunkId: string) => void
  children: ReactNode
}): ReactNode {
  const profile = useApp((s) => s.settings?.profile)
  const showToast = useApp((s) => s.showToast)
  const handlers = useRef({ onChange, onJump })
  handlers.current = { onChange, onJump }
  const { id, mode, people, speakers } = doc
  const value = useMemo<NoteSpeakers>(() => {
    const byId = new Map(chunks.map((c) => [c.id, c]))
    return {
      view: resolveSpeakers(chunks, { mode, people, assignments: speakers, profile: profile ?? {} }),
      people,
      profile: { name: profile?.name ?? '', email: profile?.email ?? '' },
      chunk: (chunkId) => byId.get(chunkId),
      origin: chunks.length ? Math.min(...chunks.map((c) => Date.parse(c.start_timestamp))) : 0,
      assign: (key, assignment) =>
        void call('documents:update', id, { speakers: { [key]: assignment } }).then(
          (d) => handlers.current.onChange(d),
          (e) => showToast('error', errorMessage(e))
        ),
      jump: (chunkId) => handlers.current.onJump(chunkId)
    }
  }, [chunks, id, mode, people, speakers, profile, showToast])
  return <SpeakersContext.Provider value={value}>{children}</SpeakersContext.Provider>
}

const ORIGIN: Record<SpeakerOrigin, string> = {
  user: 'Named by you',
  self: 'Your voice',
  calendar: 'From your calendar',
  detected: 'Detected voice',
  stream: 'Call audio'
}

const OPTION =
  'flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm outline-none select-none text-ink-primary hover:bg-oats-off-black-a6 focus-visible:bg-oats-off-black-a6 dark:hover:bg-oats-off-white-a6 dark:focus-visible:bg-oats-off-white-a6 [&>svg]:shrink-0 [&>svg]:text-ink-secondary'

interface Option {
  name: string
  email?: string
  self?: boolean
}

/** "Who is this?": the note-taker, the attendees, or a typed name. */
function SpeakerPickerBody({ speaker, onDone }: { speaker: Speaker; onDone?: () => void }): ReactNode {
  const ctx = useNoteSpeakers()
  const [query, setQuery] = useState('')
  if (!ctx) return null
  const q = query.trim()
  const taken = new Set(ctx.view.speakers.filter((s) => s.key !== speaker.key && s.origin === 'user').map((s) => s.label.toLowerCase()))
  const options: Option[] = [
    { name: ctx.profile.name || 'You', email: ctx.profile.email || undefined, self: true },
    ...ctx.people.filter((p) => !isSelf(p, ctx.profile)).map((p) => ({ name: p.name || p.email, email: p.email }))
  ]
  const shown = options.filter((o) => !q || o.name.toLowerCase().includes(q.toLowerCase()) || o.email?.toLowerCase().includes(q.toLowerCase()))
  const exact = options.find((o) => o.name.toLowerCase() === q.toLowerCase())
  const current = (o: Option): boolean => speaker.origin === 'user' && (o.self ? speaker.label === 'You' || speaker.label === ctx.profile.name : speaker.label === o.name)
  const save = (value: SpeakerAssignment | null): void => {
    ctx.assign(speaker.key, value)
    onDone?.()
  }
  const pick = (o: Option): void => save({ name: o.name, ...(o.email ? { email: o.email } : {}), ...(o.self ? { self: true } : {}) })

  return (
    <div className="flex flex-col gap-0.5">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && q) {
            e.preventDefault()
            if (exact) pick(exact)
            else save({ name: q })
          }
        }}
        placeholder={`Who is ${speaker.label}?`}
        aria-label="Speaker name"
        data-testid="speaker-name-input"
        className="mb-0.5 h-8 w-full rounded-lg bg-fill-soft px-2.5 text-sm text-ink-primary outline-none placeholder:text-ink-tertiary"
      />
      {shown.map((o) => (
        <button key={`${o.self ? 'self' : ''}${o.email ?? o.name}`} type="button" className={cn(OPTION, taken.has(o.name.toLowerCase()) && !current(o) && 'opacity-60')} onClick={() => pick(o)}>
          <Avatar name={o.name} size={18} />
          <span className="min-w-0 flex-1 truncate">
            {o.name}
            {o.self && <span className="text-ink-tertiary"> (me)</span>}
          </span>
          {current(o) && <Check size={14} />}
        </button>
      ))}
      {q && !exact && (
        <button type="button" className={OPTION} onClick={() => save({ name: q })}>
          <UserRoundPlus size={16} />
          <span className="min-w-0 flex-1 truncate">Name them “{q}”</span>
        </button>
      )}
      {speaker.origin === 'user' && (
        <button type="button" className={OPTION} onClick={() => save(null)}>
          <RotateCcw size={16} />
          <span className="min-w-0 flex-1 truncate">Reset to {speaker.autoLabel}</span>
        </button>
      )}
    </div>
  )
}

/** A speaker's name over their transcript bubble; click it to say who they are. */
export function SpeakerLabel({ speaker, align }: { speaker: Speaker; align: 'start' | 'end' }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align={align}
      className="w-64 p-1.5"
      trigger={
        <button
          type="button"
          data-testid="speaker-label"
          title="Who is this?"
          className={cn(
            'cursor-default rounded px-1 text-xs leading-5 text-ink-tertiary outline-none ring-focus-ring select-none hover:bg-fill-highlight hover:text-ink-secondary focus-visible:ring-2',
            speaker.origin === 'detected' && 'underline decoration-dotted underline-offset-[3px]'
          )}
        >
          {speaker.label}
        </button>
      }
    >
      <SpeakerPickerBody speaker={speaker} onDone={() => setOpen(false)} />
    </Popover>
  )
}

function SpeakerRow({ speaker, editing, onEdit, onDone }: { speaker: Speaker; editing: boolean; onEdit: () => void; onDone: () => void }): ReactNode {
  const ctx = useNoteSpeakers()
  const sample = speaker.sampleChunkId ? ctx?.chunk(speaker.sampleChunkId) : undefined
  return (
    <div data-testid="speaker-row" className="rounded-lg p-1.5">
      <div className="flex items-center gap-2">
        <Avatar name={speaker.label} size={24} />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm leading-5 text-ink-primary">{speaker.label}</span>
          <span className="truncate text-xs leading-4 text-ink-tertiary">
            {ORIGIN[speaker.origin]} · {speaker.source === 'microphone' ? 'Mic' : 'Call audio'}
          </span>
        </div>
        <Button variant={speaker.origin === 'detected' ? 'accent-soft' : 'soft'} size="sm" onClick={onEdit} aria-expanded={editing}>
          {speaker.origin === 'detected' ? 'Identify' : 'Change'}
        </Button>
      </div>
      {sample && ctx && (
        <button
          type="button"
          title="Show in transcript"
          onClick={() => ctx.jump(sample.id)}
          className="mt-1 ml-8 flex w-[calc(100%-2rem)] cursor-default items-baseline gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs text-ink-secondary hover:bg-fill-highlight"
        >
          <span className="min-w-0 flex-1 truncate">“{sample.text}”</span>
          <span className="shrink-0 text-ink-tertiary tabular-nums">{clock(sample.start_timestamp, ctx.origin)}</span>
        </button>
      )}
      {editing && (
        <div className="mt-1.5 ml-8">
          <SpeakerPickerBody speaker={speaker} onDone={onDone} />
        </div>
      )}
    </div>
  )
}

/** The options-row chip: shown once the engine has told voices apart (or a 1:1 guess was made from the calendar). */
export function SpeakersChip({ className }: { className: string }): ReactNode {
  const ctx = useNoteSpeakers()
  const [editing, setEditing] = useState<string | null>(null)
  if (!ctx) return null
  const list = identifiableSpeakers(ctx.view)
  const unnamed = unnamedSpeakers(ctx.view).length
  return (
    <Popover
      align="start"
      className="w-[320px] p-0"
      onOpenChange={(o) => !o && setEditing(null)}
      trigger={
        <button type="button" className={className} data-testid="speakers-chip">
          {unnamed > 0 ? (
            <>
              <AudioLines size={16} />
              <span className="truncate">Identify speakers</span>
              <span className="text-ink-tertiary tabular-nums">{unnamed}</span>
              <span aria-hidden className="ml-0.5 size-1.5 shrink-0 rounded-full bg-fill-accent" />
            </>
          ) : (
            <>
              <AvatarStack names={[...new Set(list.map((s) => s.label))]} size={16} max={3} />
              <span className="ml-0.5 truncate">{list.length === 1 ? '1 speaker' : `${list.length} speakers`}</span>
            </>
          )}
        </button>
      }
    >
      <div className="border-b border-hairline px-3 py-2.5">
        <div className="text-sm text-ink-primary">Speakers</div>
        <div className="mt-0.5 text-xs text-ink-secondary">Cereal told these voices apart. Say who they are, and your notes and chat will know who said what.</div>
      </div>
      <div className="max-h-[360px] overflow-y-auto p-1">
        {list.map((s) => (
          <SpeakerRow key={s.key} speaker={s} editing={editing === s.key} onEdit={() => setEditing(editing === s.key ? null : s.key)} onDone={() => setEditing(null)} />
        ))}
      </div>
    </Popover>
  )
}
