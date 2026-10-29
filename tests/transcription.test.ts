import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { CLOSE_SILENCE_HOPS, HOP, PrefixStabilizer, Segmenter, encodeWav, pcm16ToFloat32 } from '../src/main/transcription/segmenter'
import { DeepgramEngine, buildDeepgramUrl, dominantSpeaker, parseDeepgramMessage } from '../src/main/transcription/deepgram'
import { cleanWhisperText } from '../src/main/transcription/whisper'
import type { EngineSegment } from '../src/main/transcription/types'

const SR = 16_000

function tone(seconds: number, amp = 0.2): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR)
  return out
}
const silence = (seconds: number): Float32Array => new Float32Array(Math.round(seconds * SR))

describe('Segmenter (energy VAD with Granola timing constants)', () => {
  it('emits one final segment for a burst of speech, padded with pre-roll', () => {
    const seg = new Segmenter()
    const events = [...seg.push(silence(1)), ...seg.push(tone(2)), ...seg.push(silence(1.5))]
    const finals = events.filter((e) => e.type === 'final')
    expect(finals).toHaveLength(1)
    const startMs = (finals[0].startSample / SR) * 1000
    const endMs = (finals[0].endSample / SR) * 1000
    expect(startMs).toBeGreaterThan(700)
    expect(startMs).toBeLessThan(1000)
    expect(endMs).toBeGreaterThan(3000)
    expect(endMs).toBeLessThan(3000 + CLOSE_SILENCE_HOPS * ((HOP / SR) * 1000) + 400)
    expect(finals[0].audio.length).toBe(finals[0].endSample - finals[0].startSample)
  })

  it('emits partials roughly every second during long speech and splits at 25 s', () => {
    const seg = new Segmenter()
    const events = []
    for (let i = 0; i < 30; i++) events.push(...seg.push(tone(1)))
    events.push(...seg.flush())
    expect(events.filter((e) => e.type === 'partial').length).toBeGreaterThan(20)
    const finals = events.filter((e) => e.type === 'final')
    expect(finals.length).toBe(2)
    expect((finals[0].endSample - finals[0].startSample) / SR).toBeLessThanOrEqual(25.1)
  })

  it('ignores very short blips', () => {
    const seg = new Segmenter()
    const events = [...seg.push(silence(1)), ...seg.push(tone(0.05)), ...seg.push(silence(1.5))]
    expect(events).toEqual([])
  })

  it('stabilises partial hypotheses by common prefix', () => {
    const s = new PrefixStabilizer()
    expect(s.advance(['the', 'quick'])).toEqual([])
    expect(s.advance(['the', 'quick', 'brown'])).toEqual(['the', 'quick'])
    expect(s.advance(['The', 'quick,', 'brown', 'fox'])).toEqual(['The', 'quick,', 'brown'])
  })

  it('encodes WAV and decodes PCM16', () => {
    const wav = encodeWav(new Float32Array([0, 0.5, -0.5]), SR)
    expect(wav.subarray(0, 4).toString()).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(SR)
    expect(wav.length).toBe(44 + 6)
    const back = pcm16ToFloat32(wav.subarray(44))
    expect(back[1]).toBeCloseTo(0.5, 3)
  })

  it('removes whisper non-speech markers', () => {
    expect(cleanWhisperText(' [BLANK_AUDIO] Hello (laughs) there *music* ')).toBe('Hello there')
  })
})

describe('Deepgram', () => {
  it('builds the live URL with Granola-equivalent options and keyterms', () => {
    const url = new URL(buildDeepgramUrl({ source: 'microphone', sampleRate: 16000, language: 'en', keyterms: ['Acme', 'Acme', ' Ana '] }, 'nova-3'))
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen')
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: 'nova-3',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      language: 'en'
    })
    expect(url.searchParams.getAll('keyterm')).toEqual(['Acme', 'Ana'])
    const multi = new URL(buildDeepgramUrl({ source: 'system', sampleRate: 16000, language: 'multi', keyterms: [] }, 'nova-3'))
    expect(multi.searchParams.get('endpointing')).toBe('100')
    expect(url.searchParams.has('diarize')).toBe(false)
    expect(new URL(buildDeepgramUrl({ source: 'system', sampleRate: 16000, language: 'en', keyterms: [], diarize: true }, 'nova-3')).searchParams.get('diarize')).toBe('true')
  })

  it('parses result messages', () => {
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Results', is_final: true, start: 1.5, duration: 2, channel: { alternatives: [{ transcript: 'hi' }] } }))).toEqual({
      text: 'hi',
      startMs: 1500,
      endMs: 3500,
      isFinal: true
    })
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Metadata' }))).toBeNull()
    expect(parseDeepgramMessage('not json')).toBeNull()
  })

  it('splits diarized words into consecutive speaker runs', () => {
    const words = [
      { word: 'so', punctuated_word: 'So', start: 1, end: 1.2, speaker: 0 },
      { word: 'ready', punctuated_word: 'ready?', start: 1.2, end: 1.6, speaker: 0 },
      { word: 'yes', punctuated_word: 'Yes.', start: 1.8, end: 2.1, speaker: 1 },
      { word: 'go', punctuated_word: 'Go.', start: 2.2, end: 2.5, speaker: 0 }
    ]
    const r = parseDeepgramMessage(JSON.stringify({ type: 'Results', is_final: true, start: 1, duration: 1.5, channel: { alternatives: [{ transcript: 'So ready? Yes. Go.', words }] } }))
    expect(r!.runs).toEqual([
      { speaker: '0', text: 'So ready?', startMs: 1000, endMs: 1600 },
      { speaker: '1', text: 'Yes.', startMs: 1800, endMs: 2100 },
      { speaker: '0', text: 'Go.', startMs: 2200, endMs: 2500 }
    ])
    expect(dominantSpeaker(r!.runs!)).toBe('0')
    expect(parseDeepgramMessage(JSON.stringify({ type: 'Results', channel: { alternatives: [{ transcript: 'hi', words: [{ word: 'hi', start: 0, end: 1 }] }] } }))!.runs).toBeUndefined()
  })

  let server: WebSocketServer | null = null
  afterEach(() => server?.close())

  it('streams audio to the server and keys interim/final results per utterance', async () => {
    const received: Buffer[] = []
    let auth = ''
    server = new WebSocketServer({ port: 0 })
    server.on('connection', (socket: ServerSocket, req) => {
      auth = req.headers.authorization ?? ''
      const send = (o: object): void => socket.send(JSON.stringify(o))
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          if (JSON.parse(data.toString()).type === 'CloseStream') socket.close()
          return
        }
        received.push(data as Buffer)
        if (received.length === 1) {
          send({ type: 'Results', is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: 'hello' }] } })
          send({ type: 'Results', is_final: true, start: 0, duration: 1.2, channel: { alternatives: [{ transcript: 'Hello world.' }] } })
          send({ type: 'Results', is_final: false, start: 1.2, duration: 0.5, channel: { alternatives: [{ transcript: 'next' }] } })
        }
      })
    })
    await new Promise((r) => server!.on('listening', r))
    const port = (server.address() as AddressInfo).port
    const engine = new DeepgramEngine('test-key', 'nova-3', `ws://127.0.0.1:${port}/v1/listen`)
    const stream = await engine.open({ source: 'microphone', sampleRate: SR, language: 'en', keyterms: [] })
    const segments: EngineSegment[] = []
    stream.on('segment', (s: EngineSegment) => segments.push(s))
    stream.write(Buffer.alloc(3200))
    await new Promise((r) => setTimeout(r, 200))
    await stream.finish()
    expect(auth).toBe('Token test-key')
    expect(received.length).toBeGreaterThan(0)
    expect(segments).toEqual([
      { key: 'w0', text: 'hello', startMs: 0, endMs: 1000, isFinal: false },
      { key: 'w0', text: 'Hello world.', startMs: 0, endMs: 1200, isFinal: true },
      { key: 'w1', text: 'next', startMs: 1200, endMs: 1700, isFinal: false }
    ])
  })

  it('keys diarized finals per speaker run, the first run replacing the interim', async () => {
    server = new WebSocketServer({ port: 0 })
    const w = (word: string, start: number, speaker: number): object => ({ word, punctuated_word: word, start, end: start + 0.4, speaker })
    server.on('connection', (socket: ServerSocket) => {
      const send = (o: object): void => socket.send(JSON.stringify(o))
      let sent = false
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          if (JSON.parse(data.toString()).type === 'CloseStream') socket.close()
          return
        }
        if (sent) return
        sent = true
        send({ type: 'Results', is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: 'Hi there', words: [w('Hi', 0, 1), w('there', 0.4, 1)] }] } })
        send({ type: 'Results', is_final: true, start: 0, duration: 2, channel: { alternatives: [{ transcript: 'Hi there. Hello.', words: [w('Hi', 0, 1), w('there.', 0.4, 1), w('Hello.', 1.2, 0)] }] } })
      })
    })
    await new Promise((r) => server!.on('listening', r))
    const port = (server.address() as AddressInfo).port
    const stream = await new DeepgramEngine('k', 'nova-3', `ws://127.0.0.1:${port}/v1/listen`).open({ source: 'system', sampleRate: SR, language: 'en', keyterms: [], diarize: true })
    const segments: EngineSegment[] = []
    stream.on('segment', (s: EngineSegment) => segments.push(s))
    stream.write(Buffer.alloc(3200))
    await new Promise((r) => setTimeout(r, 200))
    await stream.finish()
    expect(segments).toEqual([
      { key: 'w0', text: 'Hi there', startMs: 0, endMs: 1000, isFinal: false, speaker: '1', session: '0' },
      { key: 'w0', text: 'Hi there.', startMs: 0, endMs: 800, isFinal: true, speaker: '1', session: '0' },
      { key: 'w0.1', text: 'Hello.', startMs: 1200, endMs: 1600, isFinal: true, speaker: '0', session: '0' }
    ])
  })

  it('reports a rejected API key', async () => {
    const { createServer } = await import('node:http')
    const http = createServer((_req, res) => res.writeHead(401).end())
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
    const port = (http.address() as AddressInfo).port
    const result = await DeepgramEngine.test('bad', 'nova-3', `ws://127.0.0.1:${port}/v1/listen`)
    http.close()
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/rejected the API key/)
  })
})
