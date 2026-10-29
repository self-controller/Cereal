import { z } from 'zod'
import { formatTranscript } from '@shared/transcript'
import { PROMPT_SPEAKERS_NOTE, promptSpeakers } from '../../ai/variables'
import type { CerealDocument, DocumentSummary } from '@shared/types'
import { defineTool, type ToolEnv } from '../tool'

// Read-only tools over the user's own notes, transcripts and calendar (Granola's searchMeetings*, queryMeetingContext,
// readMeetings, readTranscript, getUpcomingCalendarEvents and searchCalendar). Every meeting a tool shows gets a
// stable [n] number within the thread, which the model uses to cite it.

const ALL = ['note-chat', 'global-chat', 'conversation', 'task'] as const
const DATE = /^\d{4}-\d{2}-\d{2}$/
const day = z.string().regex(DATE, 'use YYYY-MM-DD')

export function meetingDate(doc: Pick<CerealDocument, 'calendar_event' | 'created_at'>): string {
  return doc.calendar_event?.start ?? doc.created_at
}

function dateLabel(iso: string): string {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
}

function people(doc: Pick<CerealDocument, 'people'>): string {
  return doc.people.map((p) => p.name || p.email).filter(Boolean).join(', ')
}

/** Number a meeting for citation and describe it on one line. */
function cite(env: ToolEnv, doc: { id: string; title: string; created_at: string; calendar_event: CerealDocument['calendar_event'] }, extra = ''): { n: number; line: string } {
  const title = doc.title || 'Untitled'
  const n = env.agentStore.sourceNumber(env.run.thread_id, doc.id, title)
  return { n, line: `[${n}] ${title} — ${dateLabel(meetingDate(doc))}${extra} (meeting_id: ${doc.id})` }
}

/** The local calendar day (YYYY-MM-DD) of an instant. */
function localDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function inRange(day: string, from?: string, to?: string): boolean {
  return (!from || day >= from) && (!to || day <= to)
}

function matchesPeople(doc: CerealDocument, wanted: string[]): boolean {
  if (!wanted.length) return true
  const hay = [doc.title, ...doc.people.flatMap((p) => [p.name, p.email])].join(' ').toLowerCase()
  return wanted.some((w) => hay.includes(w.toLowerCase()))
}

export const searchMeetings = defineTool({
  name: 'searchMeetings',
  description:
    "Full-text search over the user's meeting notes, enhanced notes and transcripts. Returns matching meetings, best first, each with a citation number [n] and a meeting_id. Optionally filter by people (names or emails) and a date range.",
  input: z.object({
    query: z.string().describe('Keywords to look for. Use the distinctive words, not a full question.'),
    people: z.array(z.string()).optional().describe('Only meetings with any of these people (name or email).'),
    from_date: day.optional().describe('First day to include, YYYY-MM-DD.'),
    to_date: day.optional().describe('Last day to include, YYYY-MM-DD.'),
    limit: z.number().int().min(1).max(20).default(8)
  }),
  label: { active: 'Searching meetings', done: 'Searched meetings' },
  contexts: [...ALL],
  execute(args, env) {
    const hits = args.query.trim() ? env.store.search(args.query, 60) : env.store.listDocuments({ limit: 200 }).map((d) => ({ document_id: d.id, snippet: d.preview }))
    const lines: string[] = []
    const meetings: { n: number; id: string; title: string }[] = []
    for (const h of hits) {
      const doc = env.store.getDocument(h.document_id)
      if (!doc || !inRange(localDay(meetingDate(doc)), args.from_date, args.to_date) || !matchesPeople(doc, args.people ?? [])) continue
      const who = people(doc)
      const { n, line } = cite(env, doc, who ? `, with ${who}` : '')
      const snippet = h.snippet.replace(/[«»]/g, '').replace(/\s+/g, ' ').trim()
      lines.push(snippet ? `${line}\n    …${snippet}…` : line)
      meetings.push({ n, id: doc.id, title: doc.title || 'Untitled' })
      if (meetings.length >= args.limit) break
    }
    if (!meetings.length) return { content: `No meetings matched "${args.query}". Try fewer or different keywords, or listMeetings for a date range.`, data: { count: 0, meetings } }
    return { content: `${meetings.length} meeting${meetings.length === 1 ? '' : 's'}:\n${lines.join('\n')}\n\nUse readMeetings with meeting_ids for details.`, data: { count: meetings.length, meetings } }
  }
})

const RANGES = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'last_90_days', 'all'] as const

/** A time range as [first day, last day] in local dates (either may be open). */
function rangeDays(range: (typeof RANGES)[number]): [string | undefined, string | undefined] {
  const dayOffset = (n: number): string => {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  switch (range) {
    case 'today':
      return [dayOffset(0), dayOffset(0)]
    case 'yesterday':
      return [dayOffset(1), dayOffset(1)]
    case 'last_7_days':
      return [dayOffset(7), undefined]
    case 'last_30_days':
      return [dayOffset(30), undefined]
    case 'last_90_days':
      return [dayOffset(90), undefined]
    case 'all':
      return [undefined, undefined]
  }
}

export const listMeetings = defineTool({
  name: 'listMeetings',
  description: "List the user's meetings in a time range (newest first), optionally only those in one folder. Use this for questions about a period, like 'this week' or 'last month'.",
  input: z.object({
    time_range: z.enum(RANGES).default('last_30_days'),
    from_date: day.optional().describe('Overrides time_range: first day to include.'),
    to_date: day.optional().describe('Last day to include.'),
    folder_id: z.string().optional().describe('Only meetings in this folder (see listFolders).'),
    limit: z.number().int().min(1).max(50).default(20)
  }),
  label: { active: 'Listing meetings', done: 'Listed meetings' },
  contexts: [...ALL],
  execute(args, env) {
    const [rangeFrom, rangeTo] = rangeDays(args.time_range)
    const from = args.from_date ?? rangeFrom
    const to = args.to_date ?? (args.from_date ? undefined : rangeTo)
    const matched = env.store.listDocuments({ folderId: args.folder_id ?? null, limit: 1000 }).filter((d) => inRange(localDay(meetingDate(d)), from, to))
    const shown = matched.slice(0, args.limit)
    const lines = shown.map((d: DocumentSummary) => {
      const flags = [d.has_transcript && 'transcript', d.has_panels && 'enhanced notes'].filter(Boolean).join(', ')
      return cite(env, d, flags ? ` [${flags}]` : '').line
    })
    const span = from ? (to === from ? `on ${from}` : `from ${from}${to ? ` to ${to}` : ''}`) : 'in total'
    if (!shown.length) return { content: `No meetings ${span}.`, data: { count: 0, total: 0 } }
    return {
      content: `${matched.length} meeting${matched.length === 1 ? '' : 's'} ${span}${matched.length > shown.length ? ` (showing ${shown.length})` : ''}:\n${lines.join('\n')}`,
      data: { count: shown.length, total: matched.length }
    }
  }
})

export const readMeetings = defineTool({
  name: 'readMeetings',
  description: "Read meetings in full: the user's own notes and the latest enhanced notes, plus attendees and date. Call readTranscript for what was actually said.",
  input: z.object({ meeting_ids: z.array(z.string()).min(1).max(10) }),
  label: { active: 'Reading meetings', done: 'Read meetings' },
  contexts: [...ALL],
  execute(args, env) {
    const parts: string[] = []
    let read = 0
    for (const id of args.meeting_ids) {
      const doc = env.store.getDocument(id)
      if (!doc) {
        parts.push(`(No meeting with id ${id}.)`)
        continue
      }
      read++
      const panel = env.store
        .listPanels(id)
        .filter((p) => p.content)
        .pop()
      const transcriptLines = env.store.getTranscript(id).length
      const who = people(doc)
      parts.push(
        [
          `<meeting n="${cite(env, doc).n}" meeting_id="${doc.id}">`,
          `Title: ${doc.title || 'Untitled'}`,
          `Date: ${dateLabel(meetingDate(doc))}`,
          who && `Attendees: ${who}`,
          doc.mode === 'lecture' && 'Kind: lecture recorded in the room',
          `My notes:\n${doc.notes_markdown.trim().slice(0, 8_000) || '(none)'}`,
          panel && `Enhanced notes (${panel.title}):\n${panel.content.slice(0, 12_000)}`,
          transcriptLines ? `Transcript: ${transcriptLines} lines (readTranscript to read it).` : 'No transcript.',
          `</meeting>`
        ]
          .filter(Boolean)
          .join('\n')
      )
    }
    return { content: parts.join('\n\n'), data: { count: read } }
  }
})

export const readTranscript = defineTool({
  name: 'readTranscript',
  description: 'Read the transcript of one meeting, with [mm:ss] timestamps. Long transcripts come in pages: pass offset to continue.',
  input: z.object({
    meeting_id: z.string(),
    offset: z.number().int().min(0).default(0).describe('First line to return.'),
    limit: z.number().int().min(50).max(2000).default(600)
  }),
  label: { active: 'Reading transcript', done: 'Read transcript' },
  contexts: [...ALL],
  execute(args, env) {
    const doc = env.store.getDocument(args.meeting_id)
    if (!doc) return { content: `No meeting with id ${args.meeting_id}.`, isError: true }
    const chunks = env.store.getTranscript(doc.id)
    const lines = formatTranscript(chunks, { speakers: promptSpeakers(doc, chunks, env.settings) }).split('\n').filter(Boolean)
    const { n } = cite(env, doc)
    if (!lines.length) return { content: `[${n}] ${doc.title || 'Untitled'} has no transcript.`, data: { lines: 0 } }
    const page = lines.slice(args.offset, args.offset + args.limit)
    const end = args.offset + page.length
    const who = doc.mode === 'lecture' ? 'Recorded from the user’s mic in the room; "Speaker" (or the most frequent numbered speaker) is mostly the lecturer.' : PROMPT_SPEAKERS_NOTE
    return {
      content: `[${n}] ${doc.title || 'Untitled'} — transcript lines ${args.offset + 1}–${end} of ${lines.length}. ${who}\n${page.join('\n')}${end < lines.length ? `\n(More: call again with offset ${end}.)` : ''}`,
      data: { lines: page.length, total: lines.length }
    }
  }
})

function eventLine(env: ToolEnv, e: { id: string; title: string; start: string; end: string; attendees: { name: string; email: string }[]; meetingUrl?: string; location?: string }): string {
  const who = e.attendees.map((a) => a.name || a.email).join(', ')
  const note = env.store.findDocumentForEvent(e.id)
  return `- ${e.title} — ${dateLabel(e.start)} to ${new Date(e.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}${who ? `; attendees: ${who}` : ''}${e.location ? `; location: ${e.location}` : ''}${note ? `; notes: meeting_id ${note.id}` : ''}`
}

export const getUpcomingCalendarEvents = defineTool({
  name: 'getUpcomingCalendarEvents',
  description: "The user's upcoming calendar events (synced from Google Calendar), soonest first.",
  input: z.object({ days: z.number().int().min(1).max(14).default(2) }),
  label: { active: 'Checking calendar', done: 'Checked calendar' },
  contexts: [...ALL],
  execute(args, env) {
    const from = new Date()
    const events = env.calendarBetween(from.toISOString(), new Date(from.getTime() + args.days * 86_400_000).toISOString())
    if (!events.length) return { content: env.settings.calendar.connected ? `No events in the next ${args.days} day(s).` : 'Google Calendar is not connected (Settings → Calendar).', data: { count: 0 } }
    return { content: events.map((e) => eventLine(env, e)).join('\n'), data: { count: events.length } }
  }
})

export const searchCalendar = defineTool({
  name: 'searchCalendar',
  description: "Search the user's synced calendar events by keyword and/or attendee within a date range (default: 30 days back to 30 days ahead).",
  input: z.object({
    query: z.string().optional(),
    attendee: z.string().optional().describe('Name or email of someone on the event.'),
    from_date: day.optional(),
    to_date: day.optional()
  }),
  label: { active: 'Searching calendar', done: 'Searched calendar' },
  contexts: [...ALL],
  execute(args, env) {
    const from = args.from_date ? new Date(`${args.from_date}T00:00:00`) : new Date(Date.now() - 30 * 86_400_000)
    const to = args.to_date ? new Date(`${args.to_date}T23:59:59`) : new Date(Date.now() + 30 * 86_400_000)
    const q = args.query?.toLowerCase().trim()
    const who = args.attendee?.toLowerCase().trim()
    const events = env
      .calendarBetween(from.toISOString(), to.toISOString())
      .filter((e) => !q || `${e.title} ${e.description ?? ''}`.toLowerCase().includes(q))
      .filter((e) => !who || e.attendees.some((a) => `${a.name} ${a.email}`.toLowerCase().includes(who)))
    if (!events.length) return { content: 'No matching calendar events.', data: { count: 0 } }
    return { content: events.slice(0, 40).map((e) => eventLine(env, e)).join('\n'), data: { count: events.length } }
  }
})

export const listFolders = defineTool({
  name: 'listFolders',
  description: "The user's folders of notes, with their ids and sizes. Pass a folder_id to listMeetings to see its notes.",
  input: z.object({}),
  label: { active: 'Listing folders', done: 'Listed folders' },
  contexts: [...ALL],
  execute(_args, env) {
    const folders = env.store.listFolders()
    if (!folders.length) return { content: 'The user has no folders.', data: { count: 0 } }
    return { content: folders.map((f) => `- ${f.title} (folder_id: ${f.id}, ${f.document_count} notes)`).join('\n'), data: { count: folders.length } }
  }
})
