// Prompt variables for a note. The variable set mirrors what Granola's client computes before
// asking its backend to write notes (docs/granola-findings.md §6); the prompts that use them are Cereal's own.
import type { CerealDocument, Settings, Template, TranscriptChunk } from '@shared/types'
import { formatTranscript, maxNumHeadings } from '@shared/transcript'
import { resolveSpeakers, type SpeakerView } from '@shared/speakers'
import { extractUrls } from '@shared/markdown'

export interface PromptVariables {
  transcript: string
  notes: string
  headers: string[]
  urls: string[]
  calendar_event_title: string
  participants: string
  my_name: string
  their_name: string
  my_company: string
  my_colleagues: string
  external_attendees: string
  date: string
  time: string
  todays_date: string
  user_dictionary: string
  transcript_length: number
  is_short_transcript: boolean
  has_long_user_notes: boolean
  max_num_headings: number
  template_title: string
  meeting_description: string
  summary_headings: string
  /** Lecture mode: the mic recorded the speaker in the room, not the note-taker. */
  is_lecture: boolean
  /** The transcript tells speakers apart or names them, beyond "Me"/"Them" (docs/notion-speakers.md). */
  has_speaker_attribution: boolean
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Speakers for transcripts sent to the model: the user is "<name> (me)" (or "Me"), others are named where known,
 * "Speaker N" when told apart but unnamed, and "Them" when the call audio wasn't separated.
 */
export function promptSpeakers(doc: CerealDocument, chunks: TranscriptChunk[], settings: Settings): SpeakerView {
  return resolveSpeakers(chunks, {
    mode: doc.mode,
    people: doc.people,
    assignments: doc.speakers,
    profile: settings.profile,
    selfLabel: settings.profile.name ? `${settings.profile.name} (me)` : 'Me'
  })
}

/** How transcripts sent to the agent label speakers, for its tool results and system prompt. */
export const PROMPT_SPEAKERS_NOTE =
  '"Me" or "(me)" is the user; other speakers are named where known, "Speaker 1", "Speaker 2"… are voices told apart but not identified, and "Them" is call audio that wasn\'t separated.'

export function buildPromptVariables(
  doc: CerealDocument,
  chunks: TranscriptChunk[],
  settings: Settings,
  template: Template | null,
  now = new Date()
): PromptVariables {
  const profile = settings.profile
  const myName = profile.name || 'Me'
  const isLecture = doc.mode === 'lecture'
  const speakers = promptSpeakers(doc, chunks, settings)
  const transcript = formatTranscript(chunks, { speakers })
  const notes = doc.notes_markdown || doc.notes_plain || ''
  const myDomain = profile.email.split('@')[1]?.toLowerCase()
  const others = doc.people.filter((p) => !p.self && p.email.toLowerCase() !== profile.email.toLowerCase())
  const nameOf = (p: { name: string; email: string }): string => p.name || p.email
  const colleagues = myDomain ? others.filter((p) => p.email.toLowerCase().endsWith('@' + myDomain)) : []
  const external = others.filter((p) => !colleagues.includes(p))
  const when = new Date(doc.calendar_event?.start ?? doc.created_at)
  const sections = template?.sections ?? []
  return {
    transcript,
    notes,
    headers: notes
      .split('\n')
      .filter((l) => l.trim().startsWith('#'))
      .map((l) => l.replace(/#/g, '').trim())
      .filter(Boolean),
    urls: extractUrls(doc.notes_plain),
    calendar_event_title: doc.calendar_event?.title || doc.title || '',
    participants: [profile.name ? `${profile.name}${profile.email ? ` <${profile.email}>` : ''}` : '', ...others.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email))]
      .filter(Boolean)
      .join(', '),
    my_name: myName,
    their_name: joinNames(others.map(nameOf)),
    my_company: profile.company,
    my_colleagues: colleagues.map(nameOf).join(', '),
    external_attendees: external.map(nameOf).join(', '),
    date: when.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    time: when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    todays_date: now.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
    user_dictionary: settings.dictionary.join(', '),
    transcript_length: transcript.length,
    is_short_transcript: transcript.length < 200,
    has_long_user_notes: notes.split('\n').filter((l) => l.trim()).length >= 20,
    max_num_headings: maxNumHeadings(transcript.length),
    template_title: template?.title ?? '',
    meeting_description: template?.description ?? '',
    summary_headings: sections.map((s) => `### ${s.heading}: ${s.section_description}`).join('\n'),
    is_lecture: isLecture,
    has_speaker_attribution: speakers.attributed
  }
}
