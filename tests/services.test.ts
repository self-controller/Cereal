import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Store } from '../src/main/db/store'
import { Recorder, type CaptureLike } from '../src/main/recorder'
import { AiService, extractCitations, splitByLines } from '../src/main/ai/service'
import { buildPromptVariables } from '../src/main/ai/variables'
import { enhanceSystemPrompt } from '../src/main/ai/prompts'
import { MeetingDetector } from '../src/main/detector'
import { toCalendarEvent } from '../src/main/calendar'
import { deepMerge, openToken, readEnvFile, sealToken, type TokenCipher } from '../src/main/settings.pure'
import type { GenerateOptions, LlmProvider } from '../src/main/llm/provider'
import type { TranscriptionEngine, TranscriptionStream } from '../src/main/transcription/types'
import type { Panel, RecordingState, Settings, TranscriptChunk } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/defaults'

class FakeCapture extends EventEmitter implements CaptureLike {
  started = false
  start(): void {
    this.started = true
  }
  stop(): void {
    this.started = false
  }
}

class FakeStream extends EventEmitter implements TranscriptionStream {
  written = 0
  write(pcm: Buffer): void {
    this.written += pcm.length
  }
  async finish(): Promise<void> {}
  close(): void {}
}

describe('Recorder', () => {
  let store: Store
  beforeEach(() => (store = new Store(openDatabase(':memory:'))))

  it('maps engine utterances to chunk ids, persists finals and finalizes leftovers on stop', async () => {
    const doc = store.createDocument({ title: 'Call' })
    const captures: FakeCapture[] = []
    const streams: FakeStream[] = []
    const engine: TranscriptionEngine = {
      id: 'deepgram',
      open: async () => {
        const s = new FakeStream()
        streams.push(s)
        return s
      }
    }
    const emitted: TranscriptChunk[] = []
    const states: RecordingState[] = []
    const recorder = new Recorder({
      store,
      settings: () => DEFAULT_SETTINGS,
      createEngine: async () => engine,
      createCapture: () => {
        const c = new FakeCapture()
        captures.push(c)
        return c
      },
      emitChunks: (_id, chunks) => emitted.push(...chunks),
      emitState: (s) => states.push(s),
      emitLevels: () => undefined,
      sampleRate: 16000
    })

    const state = await recorder.start(doc.id)
    expect(state.status).toBe('recording')
    expect(state.sources).toEqual(['microphone', 'system'])
    expect(captures.every((c) => c.started)).toBe(true)

    captures[0].emit('data', Buffer.alloc(320))
    expect(streams[0].written).toBe(320)

    streams[0].emit('segment', { key: 'w0', text: 'hello', startMs: 0, endMs: 500, isFinal: false })
    streams[0].emit('segment', { key: 'w0', text: 'Hello there.', startMs: 0, endMs: 900, isFinal: true })
    streams[1].emit('segment', { key: 'w0', text: 'Hi!', startMs: 100, endMs: 600, isFinal: true })
    streams[1].emit('segment', { key: 'w1', text: 'unfinished thought', startMs: 700, endMs: 1500, isFinal: false })

    expect(emitted[0].id).toBe(emitted[1].id)
    expect(store.getTranscript(doc.id).map((c) => c.text).sort()).toEqual(['Hello there.', 'Hi!'])

    await recorder.stop()
    const finalTranscript = store.getTranscript(doc.id)
    expect(finalTranscript).toHaveLength(3)
    expect(finalTranscript.every((c) => c.is_final)).toBe(true)
    expect(finalTranscript.find((c) => c.text === 'unfinished thought')!.source).toBe('system')
    expect(recorder.getState().status).toBe('idle')
    expect(states.map((s) => s.status)).toEqual(['starting', 'recording', 'stopping', 'idle'])
  })

  it('asks the engine to diarize both streams and scopes speaker labels to the recording and stream', async () => {
    const doc = store.createDocument({})
    const opened: { source: string; diarize?: boolean }[] = []
    const streams: FakeStream[] = []
    const recorder = new Recorder({
      store,
      settings: () => DEFAULT_SETTINGS,
      createEngine: async () => ({
        id: 'deepgram',
        open: async (opts) => {
          opened.push({ source: opts.source, diarize: opts.diarize })
          const s = new FakeStream()
          streams.push(s)
          return s
        }
      }),
      createCapture: () => new FakeCapture(),
      emitChunks: () => undefined,
      emitState: () => undefined,
      emitLevels: () => undefined,
      sampleRate: 16000
    })
    await recorder.start(doc.id)
    expect(opened).toEqual([
      { source: 'microphone', diarize: true },
      { source: 'system', diarize: true }
    ])
    streams[1].emit('segment', { key: 'w0', text: 'Hello.', startMs: 0, endMs: 500, isFinal: true, speaker: '2', session: '1' })
    streams[0].emit('segment', { key: 'w0', text: 'Hi.', startMs: 0, endMs: 500, isFinal: true })
    const [system, mic] = ['system', 'microphone'].map((source) => store.getTranscript(doc.id).find((c) => c.source === source)!)
    expect(system.speaker).toBe('2')
    expect(system.speaker_session).toMatch(/^[0-9a-f]{8}-system-1$/)
    expect([mic.speaker, mic.speaker_session]).toEqual([null, null])
    await recorder.stop()
  })

  it('records only the microphone for a lecture', async () => {
    const doc = store.createDocument({ mode: 'lecture' })
    const sources: string[] = []
    const recorder = new Recorder({
      store,
      settings: () => DEFAULT_SETTINGS,
      createEngine: async () => ({
        id: 'deepgram',
        open: async (opts) => {
          sources.push(opts.source)
          return new FakeStream()
        }
      }),
      createCapture: (opts) => {
        sources.push(`capture:${opts.source}`)
        return new FakeCapture()
      },
      emitChunks: () => undefined,
      emitState: () => undefined,
      emitLevels: () => undefined,
      sampleRate: 16000
    })
    const state = await recorder.start(doc.id)
    expect(state.sources).toEqual(['microphone'])
    expect(sources).toEqual(['microphone', 'capture:microphone'])
    await recorder.stop()
  })

  it('reports engine configuration errors without leaving a half-started session', async () => {
    const doc = store.createDocument({})
    const recorder = new Recorder({
      store,
      settings: () => DEFAULT_SETTINGS,
      createEngine: async () => {
        throw new Error('Add a Deepgram API key')
      },
      createCapture: () => new FakeCapture(),
      emitChunks: () => undefined,
      emitState: () => undefined,
      emitLevels: () => undefined,
      sampleRate: 16000
    })
    await expect(recorder.start(doc.id)).rejects.toThrow('Deepgram')
    expect(recorder.getState()).toMatchObject({ status: 'idle', error: 'Add a Deepgram API key' })
  })
})

class FakeProvider implements LlmProvider {
  readonly id = 'anthropic' as const
  calls: GenerateOptions[] = []
  constructor(
    private readonly reply: (opts: GenerateOptions) => string,
    readonly maxInputChars = 1_000_000
  ) {}
  async generate(opts: GenerateOptions): Promise<string> {
    this.calls.push(opts)
    const text = this.reply(opts)
    for (const part of text.match(/.{1,7}/gs) ?? []) opts.onText?.(part)
    return text
  }
  async step(): Promise<never> {
    throw new Error('Enhance does not use tools')
  }
  async listModels(): Promise<string[]> {
    return []
  }
}

function settingsStub(overrides: Partial<Settings> = {}): { get: () => Settings } {
  const s = { ...DEFAULT_SETTINGS, ...overrides }
  return { get: () => s }
}

describe('AiService', () => {
  let store: Store
  let panels: Panel[]
  beforeEach(() => {
    store = new Store(openDatabase(':memory:'))
    panels = []
  })

  function service(provider: LlmProvider, settings = settingsStub()): AiService {
    return new AiService({
      store,
      settings: settings as never,
      provider: () => provider,
      emitPanel: (p) => panels.push(p),
      emitDocumentChanged: () => undefined
    })
  }

  function seedMeeting(): string {
    const doc = store.createDocument({ title: '' })
    store.updateDocument(doc.id, { notes_markdown: '- budget 50k\n- ship in Q3', notes_plain: 'budget 50k\nship in Q3' })
    store.upsertChunks([
      { id: 'a', document_id: doc.id, source: 'microphone', text: 'Our budget is fifty thousand.', start_timestamp: '2026-10-19T15:00:00Z', end_timestamp: '2026-10-19T15:00:03Z', is_final: true },
      { id: 'b', document_id: doc.id, source: 'system', text: 'We can ship in Q3 if legal signs off.', start_timestamp: '2026-10-19T15:00:04Z', end_timestamp: '2026-10-19T15:00:08Z', is_final: true }
    ])
    return doc.id
  }

  it('streams enhanced notes into a panel, attributes lines and auto-titles the note', async () => {
    const id = seedMeeting()
    const provider = new FakeProvider((o) =>
      o.tier === 'fast' ? 'Acme Budget Review' : '### Budget\n- Budget 50k\n- Legal must sign off first\n\n### Timeline\n- Ship in Q3'
    )
    const panel = service(provider).enhance(id, 'one-on-one')
    expect(panel.title).toBe('1:1')
    await vi.waitFor(() => expect(store.getPanel(panel.id)!.generation_finished_at).not.toBeNull())
    const done = store.getPanel(panel.id)!
    expect(done.content).toContain('### Timeline')
    expect(done.generated_lines).toEqual(['Budget', 'Legal must sign off first', 'Timeline'])
    expect(panels.length).toBeGreaterThan(2)
    const quality = provider.calls.find((c) => c.tier === 'quality')!
    expect(quality.system).toContain('### Check-in:')
    expect(quality.messages[0].content).toContain('Them: We can ship in Q3')
    expect(quality.messages[0].content).toContain('- budget 50k')
    await vi.waitFor(() => expect(store.getDocument(id)!.title).toBe('Acme Budget Review'))
    expect(store.getDocument(id)!.selected_template).toBe('one-on-one')
  })

  it('enhances lecture notes with the Lecture template and never credits the speaker to the user', async () => {
    const doc = store.createDocument({ mode: 'lecture' })
    store.updateDocument(doc.id, { notes_markdown: '- entropy', notes_plain: 'entropy' })
    store.upsertChunks([
      { id: 'a', document_id: doc.id, source: 'microphone', text: 'Entropy measures disorder.', start_timestamp: '2026-10-19T15:00:00Z', end_timestamp: '2026-10-19T15:00:03Z', is_final: true }
    ])
    const provider = new FakeProvider(() => '### Key concepts\n- Entropy measures disorder')
    const ai = service(provider, settingsStub({ profile: { name: 'Dee', email: '', company: '', jobTitle: '' } }))
    const panel = ai.enhance(doc.id)
    expect(panel.title).toBe('Lecture')
    await vi.waitFor(() => expect(store.getPanel(panel.id)!.generation_finished_at).not.toBeNull())
    const quality = provider.calls.find((c) => c.tier === 'quality')!
    expect(quality.system).toContain("recorded from Dee's microphone in the room")
    expect(quality.system).toContain('study notes')
    expect(quality.messages[0].content).toContain('Speaker: Entropy measures disorder.')
    expect(quality.messages[0].content).toContain('<lecture>')
    expect(quality.messages[0].content).not.toContain('(me)')
  })

  it('records generation failures on the panel', async () => {
    const id = seedMeeting()
    const provider = new FakeProvider(() => {
      throw new Error('boom')
    })
    const panel = service(provider).enhance(id)
    await vi.waitFor(() => expect(store.getPanel(panel.id)!.generation_failed_at).not.toBeNull())
    expect(store.getPanel(panel.id)!.error).toBe('boom')
  })

  it('condenses transcripts that exceed the provider budget', async () => {
    const id = seedMeeting()
    const provider = new FakeProvider((o) => (o.tier === 'fast' ? '- condensed point' : '### Notes\n- ok'), 100)
    const panel = service(provider).enhance(id)
    await vi.waitFor(() => expect(store.getPanel(panel.id)!.generation_finished_at).not.toBeNull())
    expect(provider.calls[0].tier).toBe('fast')
    expect(provider.calls.find((c) => c.tier === 'quality')!.messages[0].content).toContain('Condensed notes for transcript part 1')
  })

  it('helpers split text and extract citations', () => {
    expect(splitByLines('aaa\nbbb\nccc', 7)).toEqual(['aaa\nbbb', 'ccc'])
    expect(extractCitations('x [2] y [9]', [{ n: 1, document_id: 'a', title: 'A' }, { n: 2, document_id: 'b', title: 'B' }])).toEqual([{ n: 2, document_id: 'b', title: 'B' }])
  })

  it('builds prompt variables like Granola (colleagues vs external, flags, headings)', () => {
    const doc = store.createDocument({
      calendar_event: {
        id: 'e',
        title: 'Acme x Cereal',
        start: '2026-10-19T15:00:00Z',
        end: '2026-10-19T15:30:00Z',
        attendees: [
          { name: 'Me', email: 'me@cereal.dev', self: true },
          { name: 'Kim', email: 'kim@cereal.dev' },
          { name: 'Bo', email: 'bo@acme.com' }
        ]
      }
    })
    const settings = { ...DEFAULT_SETTINGS, profile: { name: 'Dee', email: 'me@cereal.dev', company: 'Cereal', jobTitle: '' } }
    const v = buildPromptVariables({ ...doc, notes_markdown: '## Goals\n- grow' }, [], settings, store.getTemplate('stand-up'))
    expect(v.my_colleagues).toBe('Kim')
    expect(v.external_attendees).toBe('Bo')
    expect(v.their_name).toBe('Kim and Bo')
    expect(v.headers).toEqual(['Goals'])
    expect(v.is_short_transcript).toBe(true)
    expect(v.summary_headings.split('\n')[0]).toBe('### Updates: Per person: what they finished and what they are working on next.')
    expect(enhanceSystemPrompt(v)).toContain('Dee')
  })

  it('ends auto-structured lecture notes with what to review instead of next steps', () => {
    const doc = store.createDocument({ mode: 'lecture' })
    const v = buildPromptVariables(doc, [], DEFAULT_SETTINGS, null)
    expect(v.is_lecture).toBe(true)
    const system = enhanceSystemPrompt(v)
    expect(system).toContain('### To review')
    expect(system).not.toContain('### Next steps')
    expect(system).not.toContain('"Them" is everyone else on the call')
  })

  it('labels transcripts by resolved speaker and tells the model when voices were told apart', () => {
    const doc = store.updateDocument(store.createDocument({}).id, { speakers: { 'system:r-system-0:1': { name: 'Kim' } } })
    const settings = { ...DEFAULT_SETTINGS, profile: { ...DEFAULT_SETTINGS.profile, name: 'Dee' } }
    const at = (s: number): string => new Date(Date.parse('2026-10-19T15:00:00.000Z') + s * 1000).toISOString()
    const c = (id: string, s: number, source: 'microphone' | 'system', text: string, speaker?: string): TranscriptChunk => ({
      id,
      document_id: doc.id,
      source,
      text,
      start_timestamp: at(s),
      end_timestamp: at(s + 2),
      is_final: true,
      ...(speaker ? { speaker, speaker_session: 'r-system-0' } : {})
    })
    const plain = buildPromptVariables(doc, [c('a', 0, 'microphone', 'Hi.'), c('b', 3, 'system', 'Hello.')], settings, null)
    expect(plain.transcript).toBe('[00:00] Dee (me): Hi.\n[00:03] Them: Hello.')
    expect(plain.has_speaker_attribution).toBe(false)
    expect(enhanceSystemPrompt(plain)).toContain('individual speakers on that side are not separated')
    const told = buildPromptVariables(doc, [c('a', 0, 'microphone', 'Hi.'), c('b', 3, 'system', 'Hello.', '0'), c('d', 6, 'system', 'Morning.', '1')], settings, null)
    expect(told.transcript).toBe('[00:00] Dee (me): Hi.\n[00:03] Speaker 1: Hello.\n[00:06] Kim: Morning.')
    expect(told.has_speaker_attribution).toBe(true)
    expect(enhanceSystemPrompt(told)).toContain('"Speaker 1", "Speaker 2"')
  })
})

describe('MeetingDetector', () => {
  it('fires start once per meeting and end after the grace period', async () => {
    let apps: string[] = []
    const onStart = vi.fn()
    const onEnd = vi.fn()
    const d = new MeetingDetector(onStart, onEnd, async () => apps)
    await d.tick(0)
    apps = ['Zoom', 'Browser call']
    await d.tick(1_000)
    await d.tick(4_000)
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onStart).toHaveBeenCalledWith('Zoom')
    apps = []
    await d.tick(10_000)
    expect(d.meetingActive).toBe(true)
    await d.tick(31_000)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(d.meetingActive).toBe(false)
  })
})

describe('calendar + settings helpers', () => {
  it('converts Google events and skips all-day/declined ones', () => {
    expect(
      toCalendarEvent({
        id: '1',
        summary: 'Sync',
        start: { dateTime: '2026-10-20T09:00:00-04:00' },
        end: { dateTime: '2026-10-20T09:30:00-04:00' },
        hangoutLink: 'https://meet.google.com/abc',
        attendees: [{ email: 'a@x.com', displayName: 'A', self: true, responseStatus: 'accepted' }, { email: 'room@x.com', resource: true }]
      })
    ).toMatchObject({ id: '1', title: 'Sync', start: '2026-10-20T13:00:00.000Z', meetingUrl: 'https://meet.google.com/abc', attendees: [{ name: 'A', email: 'a@x.com', self: true }] })
    expect(toCalendarEvent({ id: '2', start: { date: '2026-10-20' }, end: { date: '2026-10-21' } })).toBeNull()
    expect(
      toCalendarEvent({ id: '3', start: { dateTime: '2026-10-20T09:00:00Z' }, end: { dateTime: '2026-10-20T10:00:00Z' }, attendees: [{ email: 'a@x', self: true, responseStatus: 'declined' }] })
    ).toBeNull()
  })

  it('deep-merges settings patches', () => {
    const merged = deepMerge(DEFAULT_SETTINGS, { llm: { provider: 'ollama' }, dictionary: ['Acme'] })
    expect(merged.llm.provider).toBe('ollama')
    expect(merged.llm.anthropicModel).toBe(DEFAULT_SETTINGS.llm.anthropicModel)
    expect(merged.dictionary).toEqual(['Acme'])
  })

  it('reads API keys from a .env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cereal-env-'))
    const file = join(dir, '.env')
    expect(readEnvFile(file)).toEqual({})
    writeFileSync(file, '# keys\nDEEPGRAM_API_KEY=dg-123\nANTHROPIC_API_KEY="sk-ant-x"\nOPENAI_API_KEY=\n')
    expect(readEnvFile(file)).toEqual({ DEEPGRAM_API_KEY: 'dg-123', ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: '' })
  })

  it('makes a .env that others can read private again', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cereal-env-')), '.env')
    writeFileSync(file, 'DEEPGRAM_API_KEY=dg-123\n')
    chmodSync(file, 0o644)
    expect(readEnvFile(file)).toEqual({ DEEPGRAM_API_KEY: 'dg-123' })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('refuses a .env that is not a regular file, without blocking on a FIFO', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cereal-env-'))
    execFileSync('mkfifo', [join(dir, '.env')])
    expect(() => readEnvFile(join(dir, '.env'))).toThrow(/not a regular file/)
    mkdirSync(join(dir, 'sub', '.env'), { recursive: true })
    expect(() => readEnvFile(join(dir, 'sub', '.env'))).toThrow(/not a regular file/)
  })
})

describe('token storage', () => {
  // Reverses the bytes so sealed values differ from the plaintext.
  const fakeCipher = (available: boolean, opts: { rotated?: boolean } = {}): TokenCipher => ({
    available: async () => available,
    encrypt: async (plain) => Buffer.from(plain, 'utf8').reverse(),
    decrypt: async (data) => ({ result: Buffer.from(data).reverse().toString('utf8'), shouldReEncrypt: !!opts.rotated }),
    decryptLegacy: (data) => `legacy:${data.toString('utf8')}`
  })

  it('encrypts when the keyring is available and round-trips', async () => {
    const sealed = await sealToken(fakeCipher(true), 'refresh-1')
    expect(sealed.startsWith('enc2:')).toBe(true)
    expect(sealed).not.toContain('refresh-1')
    expect(await openToken(fakeCipher(true), sealed)).toEqual({ value: 'refresh-1', reseal: false })
    expect(await openToken(fakeCipher(true, { rotated: true }), sealed)).toEqual({ value: 'refresh-1', reseal: true })
  })

  it('falls back to plain without a keyring, and reseals once one appears', async () => {
    const sealed = await sealToken(fakeCipher(false), 'refresh-2')
    expect(sealed.startsWith('plain:')).toBe(true)
    expect(await openToken(fakeCipher(false), sealed)).toEqual({ value: 'refresh-2', reseal: false })
    expect(await openToken(fakeCipher(true), sealed)).toEqual({ value: 'refresh-2', reseal: true })
  })

  it('migrates values from the sync API and treats unreadable ones as signed out', async () => {
    const legacy = `enc:${Buffer.from('old').toString('base64')}`
    expect(await openToken(fakeCipher(true), legacy)).toEqual({ value: 'legacy:old', reseal: true })
    const broken: TokenCipher = { ...fakeCipher(true), decrypt: () => Promise.reject(new Error('wrong key')) }
    expect(await openToken(broken, `enc2:${Buffer.from('x').toString('base64')}`)).toEqual({ value: null, reseal: false })
    expect(await openToken(fakeCipher(true), 'garbage')).toEqual({ value: null, reseal: false })
  })
})
