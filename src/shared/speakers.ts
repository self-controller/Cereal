import { compareChunks } from './transcript'
import { echoChunkIds } from './micBleed'
import type { Attendee, NoteMode, SpeakerAssignment, TranscriptChunk, TranscriptSource } from './types'

// Who said what (docs/notion-speakers.md §2). The engine diarizes each audio stream separately, so a raw label only
// means something within its stream's session. Labels become people by where they were heard: the dominant voice on
// the mic is the note-taker, and in a 1:1 call the dominant voice on the call audio is the other attendee. Every other
// voice is "Speaker N" until the user names it.

/** Share of a mic session's characters its dominant voice needs to count as the note-taker. */
export const MIC_SELF_SHARE = 0.9
/** The same, in a 1:1 call, where the only other voice is expected on the call audio. */
export const MIC_SELF_SHARE_1ON1 = 0.75
/** Share of a call-audio session's characters its dominant voice needs to be named after the other attendee. */
export const SYSTEM_ATTENDEE_SHARE = 0.75

/**
 * Where a speaker's label came from. `user`: named by the user. `self`: the note-taker's mic. `calendar`: the other
 * attendee of a 1:1. `detected`: a diarized voice nobody has named yet. `stream`: no diarization, labelled by stream.
 */
export type SpeakerOrigin = 'user' | 'self' | 'calendar' | 'detected' | 'stream'

export interface Speaker {
  key: string
  source: TranscriptSource
  label: string
  origin: SpeakerOrigin
  /** What the label would be without the user's name for it. */
  autoLabel: string
  autoOrigin: Exclude<SpeakerOrigin, 'user'>
  email?: string
  /** The engine told this voice apart (it has a raw label). */
  diarized: boolean
  /** Their longest final chunk, for "who is this?" previews. */
  sampleChunkId: string | null
  chunkIds: string[]
}

export interface SpeakerContext {
  mode: NoteMode
  people: Attendee[]
  /** The note's user-assigned names (`CerealDocument.speakers`). */
  assignments: Record<string, SpeakerAssignment>
  profile: { name?: string; email?: string }
  /** Label for the note-taker (default "You"). */
  selfLabel?: string
}

export interface SpeakerView {
  /** Visible speakers in order of first appearance. */
  speakers: Speaker[]
  /** Chunk ids hidden as echoes of the call audio (src/shared/micBleed.ts). */
  echo: Set<string>
  /** Speakers are told apart or named, beyond plain "You"/"Them". */
  attributed: boolean
  labelOf(chunk: TranscriptChunk): string
  speakerOf(chunk: TranscriptChunk): Speaker | undefined
}

/** The speaker a chunk belongs to: one diarized voice in one session, or the whole stream when not diarized. */
export function speakerKey(c: Pick<TranscriptChunk, 'source' | 'speaker' | 'speaker_session'>): string {
  return c.speaker == null ? c.source : `${c.source}:${c.speaker_session ?? ''}:${c.speaker}`
}

/** The attendee is the note-taker (the calendar says so, or the email matches their profile). */
export function isSelf(a: Attendee, profile: SpeakerContext['profile']): boolean {
  return !!a.self || (!!profile.email && a.email.toLowerCase() === profile.email.toLowerCase())
}

/** The other attendee, when the calendar event is a 1:1 that includes the note-taker. */
export function oneOnOnePartner(people: Attendee[], profile: SpeakerContext['profile']): Attendee | null {
  if (people.length !== 2) return null
  const others = people.filter((p) => !isSelf(p, profile))
  return others.length === 1 ? others[0] : null
}

interface Dominant {
  label: string | null
  share: number
}

/** Per stream session: the voice with a unique maximum of characters, and its share of them. */
export function dominance(chunks: TranscriptChunk[]): Map<string, Dominant> {
  const chars = new Map<string, Map<string, number>>()
  for (const c of chunks) {
    const scope = `${c.source}|${c.speaker_session ?? ''}`
    const counts = chars.get(scope) ?? new Map<string, number>()
    chars.set(scope, counts)
    const label = c.speaker ?? ''
    counts.set(label, (counts.get(label) ?? 0) + c.text.trim().length)
  }
  const out = new Map<string, Dominant>()
  for (const [scope, counts] of chars) {
    const total = [...counts.values()].reduce((a, b) => a + b, 0)
    const max = Math.max(...counts.values())
    const top = [...counts].filter(([, n]) => n === max)
    out.set(scope, top.length === 1 && total > 0 ? { label: top[0][0], share: max / total } : { label: null, share: 0 })
  }
  return out
}

export function resolveSpeakers(chunks: TranscriptChunk[], ctx: SpeakerContext): SpeakerView {
  const echo = echoChunkIds(chunks)
  const visible = chunks.filter((c) => !echo.has(c.id) && c.text.trim()).sort(compareChunks)
  const dominant = dominance(visible)
  const partner = ctx.mode === 'meeting' ? oneOnOnePartner(ctx.people, ctx.profile) : null
  const oneOnOne = !!partner && visible.some((c) => c.source === 'microphone') && visible.some((c) => c.source === 'system')
  const selfLabel = ctx.selfLabel ?? 'You'

  const byKey = new Map<string, Speaker>()
  const longest = new Map<string, number>()
  let detected = 0
  for (const c of visible) {
    const key = speakerKey(c)
    let s = byKey.get(key)
    if (!s) {
      const auto = autoLabel(c, dominant.get(`${c.source}|${c.speaker_session ?? ''}`) ?? { label: null, share: 0 })
      const named = ctx.assignments[key]
      s = {
        key,
        source: c.source,
        label: named ? (named.self ? selfLabel : named.name) : auto.label,
        origin: named ? 'user' : auto.origin,
        autoLabel: auto.label,
        autoOrigin: auto.origin,
        email: named ? named.email : auto.email,
        diarized: c.speaker != null,
        sampleChunkId: null,
        chunkIds: []
      }
      byKey.set(key, s)
    }
    s.chunkIds.push(c.id)
    if (c.is_final && c.text.length > (longest.get(key) ?? 0)) {
      longest.set(key, c.text.length)
      s.sampleChunkId = c.id
    }
  }

  function autoLabel(c: TranscriptChunk, dom: Dominant): { label: string; origin: Speaker['autoOrigin']; email?: string } {
    const numbered = (): { label: string; origin: 'detected' } => ({ label: `Speaker ${++detected}`, origin: 'detected' })
    if (c.source === 'microphone') {
      if (ctx.mode === 'lecture') return c.speaker == null ? { label: 'Speaker', origin: 'stream' } : numbered()
      if (c.speaker == null) return { label: selfLabel, origin: 'self' }
      const needed = oneOnOne ? MIC_SELF_SHARE_1ON1 : MIC_SELF_SHARE
      return dom.label === c.speaker && dom.share >= needed ? { label: selfLabel, origin: 'self' } : numbered()
    }
    if (oneOnOne && partner && dom.share >= SYSTEM_ATTENDEE_SHARE) return { label: partner.name || partner.email, origin: 'calendar', email: partner.email }
    return c.speaker == null ? { label: 'Them', origin: 'stream' } : numbered()
  }

  const speakers = [...byKey.values()]
  return {
    speakers,
    echo,
    attributed: speakers.some((s) => s.diarized || s.origin === 'user' || s.origin === 'calendar'),
    labelOf: (c) => byKey.get(speakerKey(c))?.label ?? (c.source === 'microphone' ? selfLabel : 'Them'),
    speakerOf: (c) => byKey.get(speakerKey(c))
  }
}

/** Speakers the user can identify: voices the engine told apart, or names guessed from the calendar. */
export function identifiableSpeakers(view: SpeakerView): Speaker[] {
  return view.speakers.filter((s) => s.origin === 'user' || (s.autoOrigin !== 'self' && (s.diarized || s.autoOrigin === 'calendar')))
}

/** Detected voices still without a name. */
export function unnamedSpeakers(view: SpeakerView): Speaker[] {
  return view.speakers.filter((s) => s.origin === 'detected')
}
