import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import type { EngineSegment, StreamOptions, TranscriptionEngine, TranscriptionStream } from './types'

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen'
const KEEPALIVE_MS = 5_000
const MAX_RECONNECTS = 5

/** Build the live-transcription URL. Options mirror what Granola sends (docs/granola-findings.md §3). */
export function buildDeepgramUrl(opts: StreamOptions, model: string, baseUrl = DEEPGRAM_URL): string {
  const url = new URL(baseUrl)
  const p = url.searchParams
  p.set('model', model)
  p.set('encoding', 'linear16')
  p.set('sample_rate', String(opts.sampleRate))
  p.set('channels', '1')
  p.set('interim_results', 'true')
  p.set('smart_format', 'true')
  p.set('punctuate', 'true')
  p.set('profanity_filter', 'false')
  p.set('mip_opt_out', 'true')
  if (opts.diarize) p.set('diarize', 'true')
  if (opts.language === 'multi') {
    p.set('language', 'multi')
    p.set('endpointing', '100')
  } else {
    p.set('language', opts.language || 'en')
  }
  const terms = [...new Set(opts.keyterms.map((t) => t.trim()).filter(Boolean))].slice(0, 100)
  for (const t of terms) p.append(model.startsWith('nova-3') ? 'keyterm' : 'keywords', t)
  return url.toString()
}

interface DeepgramWord {
  word?: string
  punctuated_word?: string
  start?: number
  end?: number
  speaker?: number
}

interface DeepgramResult {
  type?: string
  is_final?: boolean
  start?: number
  duration?: number
  channel?: { alternatives?: { transcript?: string; words?: DeepgramWord[] }[] }
}

/** Consecutive words from one diarized speaker. Times are ms from the start of the socket's audio. */
export interface SpeakerRun {
  speaker: string
  text: string
  startMs: number
  endMs: number
}

export interface ParsedResult {
  text: string
  startMs: number
  endMs: number
  isFinal: boolean
  /** Present when the result is diarized. */
  runs?: SpeakerRun[]
}

const toMs = (s: number | undefined): number => Math.round((s ?? 0) * 1000)

/** Parse one Deepgram message into a segment (null for non-result messages). */
export function parseDeepgramMessage(raw: string): ParsedResult | null {
  let msg: DeepgramResult
  try {
    msg = JSON.parse(raw) as DeepgramResult
  } catch {
    return null
  }
  if (msg.type !== 'Results') return null
  const alt = msg.channel?.alternatives?.[0]
  const text = alt?.transcript ?? ''
  const startMs = toMs(msg.start)
  const result: ParsedResult = { text, startMs, endMs: startMs + toMs(msg.duration), isFinal: !!msg.is_final }
  const runs: SpeakerRun[] = []
  for (const w of alt?.words ?? []) {
    const word = (w.punctuated_word ?? w.word ?? '').trim()
    if (typeof w.speaker !== 'number' || !word) continue
    const last = runs[runs.length - 1]
    if (last && last.speaker === String(w.speaker)) {
      last.text += ' ' + word
      last.endMs = toMs(w.end)
    } else {
      runs.push({ speaker: String(w.speaker), text: word, startMs: toMs(w.start), endMs: toMs(w.end) })
    }
  }
  if (runs.length) result.runs = runs
  return result
}

/** The speaker with the most characters in `runs` (the first one on a tie). */
export function dominantSpeaker(runs: SpeakerRun[]): string {
  const chars = new Map<string, number>()
  for (const r of runs) chars.set(r.speaker, (chars.get(r.speaker) ?? 0) + r.text.length)
  let best = runs[0].speaker
  for (const [speaker, n] of chars) if (n > chars.get(best)!) best = speaker
  return best
}

class DeepgramStream extends EventEmitter implements TranscriptionStream {
  private ws: WebSocket | null = null
  private queue: Buffer[] = []
  private window = 0
  private reconnects = 0
  private closed = false
  private finishing = false
  private bytesSent = 0
  /** Audio time already sent on previous connections; Deepgram restarts its clock per socket. */
  private offsetMs = 0
  /** Counts sockets: diarized speaker labels restart with each one, so each is its own speaker session. */
  private connection = 0
  private keepAlive: NodeJS.Timeout | null = null
  private lastSend = Date.now()
  private finishResolve: (() => void) | null = null

  constructor(
    private readonly opts: StreamOptions,
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl: string
  ) {
    super()
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(buildDeepgramUrl(this.opts, this.model, this.baseUrl), { headers: { Authorization: `Token ${this.apiKey}` } })
      this.ws = ws
      let opened = false
      ws.on('open', () => {
        opened = true
        this.reconnects = 0
        for (const buf of this.queue.splice(0)) this.send(buf)
        this.keepAlive = setInterval(() => {
          if (Date.now() - this.lastSend > KEEPALIVE_MS && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }))
        }, KEEPALIVE_MS)
        resolve()
      })
      ws.on('message', (data) => this.onMessage(data.toString()))
      ws.on('unexpected-response', (_req, res) => {
        const err = new Error(
          res.statusCode === 401 || res.statusCode === 403
            ? "Deepgram rejected the API key. Check DEEPGRAM_API_KEY in Cereal's .env file."
            : `Deepgram connection failed (HTTP ${res.statusCode}).`
        )
        this.closed = true
        if (!opened) reject(err)
        else this.emit('error', err)
      })
      ws.on('error', (err) => {
        if (!opened) reject(err)
      })
      ws.on('close', () => {
        if (this.keepAlive) clearInterval(this.keepAlive)
        this.keepAlive = null
        if (this.ws !== ws) return
        this.ws = null
        if (this.finishing || this.closed) {
          this.finishResolve?.()
          return
        }
        if (!opened) return
        // Unexpected drop: reconnect and continue the audio clock.
        this.offsetMs += Math.round((this.bytesSent / 2 / this.opts.sampleRate) * 1000)
        this.bytesSent = 0
        this.window++
        this.connection++
        if (this.reconnects++ < MAX_RECONNECTS) {
          this.emit('warning', 'Transcription connection dropped; reconnecting…')
          setTimeout(() => this.connect().catch((e: Error) => this.emit('error', e)), 300 * this.reconnects)
        } else {
          this.emit('error', new Error('Lost connection to Deepgram.'))
        }
      })
    })
  }

  private send(buf: Buffer): void {
    this.ws!.send(buf)
    this.bytesSent += buf.length
    this.lastSend = Date.now()
  }

  private onMessage(raw: string): void {
    const r = parseDeepgramMessage(raw)
    if (!r) return
    const key = `w${this.window}`
    const session = String(this.connection)
    if (r.isFinal) this.window++
    // A final result that changes speaker mid-way becomes one segment per run; the first run takes over the
    // interim's key so it replaces that chunk in place. Interims stay whole, labelled with the dominant speaker.
    if (r.isFinal && r.runs && r.runs.length > 1) {
      r.runs.forEach((run, i) =>
        this.emit('segment', {
          key: i ? `${key}.${i}` : key,
          text: run.text,
          startMs: run.startMs + this.offsetMs,
          endMs: run.endMs + this.offsetMs,
          isFinal: true,
          speaker: run.speaker,
          session
        } satisfies EngineSegment)
      )
      return
    }
    const seg: EngineSegment = {
      key,
      text: r.text.trim(),
      startMs: r.startMs + this.offsetMs,
      endMs: r.endMs + this.offsetMs,
      isFinal: r.isFinal,
      ...(r.runs ? { speaker: dominantSpeaker(r.runs), session } : {})
    }
    if (seg.text || seg.isFinal) this.emit('segment', seg)
  }

  write(pcm: Buffer): void {
    if (this.closed || this.finishing) return
    if (this.ws?.readyState === WebSocket.OPEN) this.send(pcm)
    else this.queue.push(pcm)
  }

  finish(): Promise<void> {
    if (this.closed || !this.ws) return Promise.resolve()
    this.finishing = true
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ws?.terminate()
        resolve()
      }, 6_000)
      this.finishResolve = () => {
        clearTimeout(timer)
        resolve()
      }
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      else this.ws?.terminate()
    })
  }

  close(): void {
    this.closed = true
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.ws?.terminate()
    this.ws = null
  }
}

export class DeepgramEngine implements TranscriptionEngine {
  readonly id = 'deepgram' as const

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = DEEPGRAM_URL
  ) {}

  async open(opts: StreamOptions): Promise<TranscriptionStream> {
    const stream = new DeepgramStream(opts, this.apiKey, this.model, this.baseUrl)
    await stream.connect()
    return stream
  }

  /** Quick credential check: open a socket, send a little silence, close. */
  static async test(apiKey: string, model: string, baseUrl = DEEPGRAM_URL): Promise<{ ok: boolean; message: string }> {
    try {
      const stream = new DeepgramStream({ source: 'microphone', sampleRate: 16_000, language: 'en', keyterms: [] }, apiKey, model, baseUrl)
      await stream.connect()
      stream.write(Buffer.alloc(16_000))
      await stream.finish()
      return { ok: true, message: 'Connected to Deepgram.' }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  }
}
