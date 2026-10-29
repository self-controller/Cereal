import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { Store } from './db/store'
import type { SettingsService } from './settings'
import type { Attendee, CalendarEvent } from '@shared/types'

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly'
const DAY = 86_400_000

const b64url = (buf: Buffer): string => buf.toString('base64url')

interface GoogleEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  htmlLink?: string
  hangoutLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: { email?: string; displayName?: string; organizer?: boolean; self?: boolean; responseStatus?: string; resource?: boolean }[]
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
}

/** Convert a Google Calendar API event; returns null for all-day, cancelled or declined events. */
export function toCalendarEvent(e: GoogleEvent): CalendarEvent | null {
  if (e.status === 'cancelled' || !e.start?.dateTime || !e.end?.dateTime) return null
  if (e.attendees?.some((a) => a.self && a.responseStatus === 'declined')) return null
  const attendees: Attendee[] = (e.attendees ?? [])
    .filter((a) => a.email && !a.resource)
    .map((a) => ({ name: a.displayName ?? '', email: a.email!, organizer: !!a.organizer, self: !!a.self }))
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ?? e.hangoutLink
  const urlInText = (e.location ?? e.description ?? '').match(/https:\/\/[^\s"<>]*(zoom\.us|meet\.google|teams\.microsoft|webex)[^\s"<>]*/i)?.[0]
  return {
    id: e.id,
    title: e.summary?.trim() || 'Untitled event',
    start: new Date(e.start.dateTime).toISOString(),
    end: new Date(e.end.dateTime).toISOString(),
    attendees,
    location: e.location,
    meetingUrl: video ?? urlInText,
    description: e.description,
    htmlLink: e.htmlLink
  }
}

/** Google Calendar via OAuth 2.0 for desktop apps (loopback redirect + PKCE) with the user's own client ID. */
export class CalendarService {
  private accessToken: { token: string; expires: number } | null = null

  constructor(
    private readonly store: Store,
    private readonly settings: SettingsService,
    private readonly openExternal: (url: string) => void,
    private readonly emit: (events: CalendarEvent[]) => void
  ) {}

  get connected(): boolean {
    return this.settings.get().calendar.connected && !!this.settings.getSecret('googleRefreshToken')
  }

  async connect(): Promise<{ ok: boolean; message: string }> {
    const clientId = this.settings.get().calendar.googleClientId.trim()
    if (!clientId) return { ok: false, message: 'Enter your Google OAuth client ID first (Settings → Calendar).' }
    const verifier = b64url(randomBytes(32))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(16))

    const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const code = url.searchParams.get('code')
        const error = url.searchParams.get('error')
        if (!code && !error) return void res.writeHead(404).end()
        const ok = code && url.searchParams.get('state') === state
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<html><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>${ok ? 'Cereal is connected to Google Calendar.' : 'Connection failed.'}</h2><p>You can close this tab.</p></body></html>`
        )
        clearTimeout(timer)
        server.close()
        if (ok) resolve({ code, redirectUri })
        else reject(new Error(error ?? 'OAuth state mismatch'))
      })
      const timer = setTimeout(() => {
        server.close()
        reject(new Error('Timed out waiting for Google sign-in.'))
      }, 5 * 60_000)
      let redirectUri = ''
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr === 'string') return reject(new Error('Could not open a local port'))
        redirectUri = `http://127.0.0.1:${addr.port}`
        const auth = new URL(AUTH_URL)
        auth.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: SCOPE,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
          state
        }).toString()
        this.openExternal(auth.toString())
      })
    }).catch((e: Error) => ({ code: '', redirectUri: '', error: e.message }) as { code: string; redirectUri: string; error?: string })

    if (!code) return { ok: false, message: 'Google sign-in was cancelled or failed.' }
    const body = new URLSearchParams({ code, client_id: clientId, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri })
    const secret = this.settings.getSecret('googleClientSecret')
    if (secret) body.set('client_secret', secret)
    const res = await fetch(TOKEN_URL, { method: 'POST', body })
    const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string; error?: string }
    if (!res.ok || !json.refresh_token) return { ok: false, message: `Google token exchange failed: ${json.error_description ?? json.error ?? res.status}` }
    await this.settings.setSecret('googleRefreshToken', json.refresh_token)
    this.accessToken = json.access_token ? { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000 } : null
    this.settings.update({ calendar: { connected: true } })
    await this.sync().catch(() => undefined)
    return { ok: true, message: 'Connected to Google Calendar.' }
  }

  async disconnect(): Promise<void> {
    await this.settings.setSecret('googleRefreshToken', null)
    this.settings.update({ calendar: { connected: false } })
    this.accessToken = null
    this.store.clearCalendar()
    this.emit([])
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now()) return this.accessToken.token
    const refresh = this.settings.getSecret('googleRefreshToken')
    if (!refresh) throw new Error('Google Calendar is not connected.')
    const body = new URLSearchParams({ client_id: this.settings.get().calendar.googleClientId, refresh_token: refresh, grant_type: 'refresh_token' })
    const secret = this.settings.getSecret('googleClientSecret')
    if (secret) body.set('client_secret', secret)
    const res = await fetch(TOKEN_URL, { method: 'POST', body })
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string }
    if (!res.ok || !json.access_token) {
      if (json.error === 'invalid_grant') await this.disconnect()
      throw new Error(`Google token refresh failed: ${json.error ?? res.status}`)
    }
    this.accessToken = { token: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 - 60_000 }
    return json.access_token
  }

  async sync(): Promise<CalendarEvent[]> {
    if (!this.connected) return this.upcoming()
    const from = new Date(Date.now() - DAY)
    const to = new Date(Date.now() + 14 * DAY)
    const url = new URL(EVENTS_URL)
    url.search = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250' }).toString()
    const res = await fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` } })
    if (!res.ok) throw new Error(`Google Calendar error ${res.status}`)
    const json = (await res.json()) as { items?: GoogleEvent[] }
    const events = (json.items ?? []).map(toCalendarEvent).filter((e): e is CalendarEvent => !!e)
    this.store.replaceCalendarEvents(events, from.toISOString(), to.toISOString())
    const upcoming = this.upcoming()
    this.emit(upcoming)
    return upcoming
  }

  /** Events from an hour ago through the next 7 days. */
  upcoming(): CalendarEvent[] {
    return this.store.calendarEventsBetween(new Date(Date.now() - 3_600_000).toISOString(), new Date(Date.now() + 7 * DAY).toISOString())
  }

  /** The event happening right now (if any), preferring the one that started most recently. */
  current(now = Date.now()): CalendarEvent | null {
    const live = this.upcoming().filter((e) => Date.parse(e.start) - 5 * 60_000 <= now && Date.parse(e.end) > now)
    return live.sort((a, b) => Date.parse(b.start) - Date.parse(a.start))[0] ?? null
  }
}
