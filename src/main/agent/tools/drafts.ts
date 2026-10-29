import { z } from 'zod'
import { defineTool } from '../tool'

// Drafts the user acts on themselves (Granola's writeFollowUpEmail and draftCalendarEvent cards). Cereal never sends
// anything: the card offers Copy, "Open in mail app" (mailto:) and "Open in Google Calendar" (a prefilled event page).

const ALL = ['note-chat', 'global-chat', 'conversation', 'task'] as const

export interface EmailDraft {
  kind: 'email'
  to: string[]
  cc: string[]
  subject: string
  body: string
}

export interface CalendarDraft {
  kind: 'calendar_event'
  title: string
  start: string
  end: string
  attendees: string[]
  location: string
  description: string
  url: string
}

export const draftEmail = defineTool({
  name: 'draftEmail',
  description: 'Show the user an email draft (for example a meeting follow-up) as a card they can copy or open in their mail app. Nothing is sent.',
  input: z.object({
    to: z.array(z.string()).default([]).describe('Recipient email addresses. Leave empty if unknown.'),
    cc: z.array(z.string()).default([]),
    subject: z.string(),
    body: z.string().describe('Plain-text body.')
  }),
  label: { active: 'Drafting email', done: 'Drafted email' },
  contexts: [...ALL],
  execute(args) {
    const draft: EmailDraft = { kind: 'email', to: args.to, cc: args.cc, subject: args.subject, body: args.body }
    return { content: "The draft is shown to the user as a card with Copy and Open in mail app buttons. Don't repeat it in full; mention anything they should check.", data: draft }
  }
})

/** YYYYMMDDTHHMMSSZ, as Google Calendar's template URL wants it. */
function gcalTime(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

const localDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'use an ISO date-time like 2026-10-21T14:00')

export const draftCalendarEvent = defineTool({
  name: 'draftCalendarEvent',
  description:
    "Show the user a calendar event draft as a card that opens Google Calendar's new-event page prefilled. Times are in the user's local timezone unless they include an offset. Nothing is created until the user saves it.",
  input: z.object({
    title: z.string(),
    start: localDateTime.describe('Start, e.g. 2026-10-21T14:00'),
    end: localDateTime.describe('End, e.g. 2026-10-21T14:30'),
    attendees: z.array(z.string()).default([]).describe('Attendee email addresses.'),
    location: z.string().default(''),
    description: z.string().default('')
  }),
  label: { active: 'Drafting event', done: 'Drafted event' },
  contexts: [...ALL],
  execute(args) {
    // Without an offset, Date parses an ISO date-time as local time, which is what the user means.
    const start = new Date(args.start)
    const end = new Date(args.end)
    if (end <= start) return { content: 'The event must end after it starts.', isError: true }
    const url = new URL('https://calendar.google.com/calendar/render')
    url.searchParams.set('action', 'TEMPLATE')
    url.searchParams.set('text', args.title)
    url.searchParams.set('dates', `${gcalTime(start)}/${gcalTime(end)}`)
    if (args.description) url.searchParams.set('details', args.description)
    if (args.location) url.searchParams.set('location', args.location)
    if (args.attendees.length) url.searchParams.set('add', args.attendees.join(','))
    const draft: CalendarDraft = { kind: 'calendar_event', title: args.title, start: start.toISOString(), end: end.toISOString(), attendees: args.attendees, location: args.location, description: args.description, url: url.toString() }
    return { content: 'The event draft is shown to the user as a card that opens Google Calendar prefilled. It is not on their calendar until they save it.', data: draft }
  }
})
