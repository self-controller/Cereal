import type { Settings } from '@shared/types'
import { recordSafely, type RecordUsage } from '../usage'
import { encodeWav } from './segmenter'
import { WhisperServer, findWhisperServer } from './whisper'

const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen'
/** Keep a dictation whisper-server around briefly, so a follow-up question doesn't wait for it to load again. */
const WHISPER_IDLE_MS = 2 * 60 * 1000
/** Granola auto-sends a dictation at 10 minutes; anything longer than this is cut off. */
export const MAX_DICTATION_SECONDS = 10 * 60 + 5

export interface DictationDeps {
  settings: () => Settings
  deepgramKey: () => string | null
  whisperModelPath: (id: string) => string
  envFile: string
  deepgramUrl?: string
  recordUsage?: RecordUsage
}

/**
 * Voice questions for the chat bar (Granola's dictation; it uploads the audio to its own transcription endpoint).
 * Cereal uses the transcription engine chosen in Settings: Deepgram's prerecorded API, or a local whisper-server.
 */
export class Dictation {
  private whisper: { server: WhisperServer; key: string } | null = null
  private idle: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: DictationDeps) {}

  async transcribe(samples: Float32Array, sampleRate: number): Promise<string> {
    if (!samples.length) return ''
    const audio = samples.length > MAX_DICTATION_SECONDS * sampleRate ? samples.subarray(0, MAX_DICTATION_SECONDS * sampleRate) : samples
    const settings = this.deps.settings()
    const t = settings.transcription
    const text = t.engine === 'deepgram' ? await this.deepgram(audio, sampleRate, t) : await this.local(audio, sampleRate, t)
    recordSafely(this.deps.recordUsage, {
      kind: 'audio',
      provider: t.engine,
      model: t.engine === 'deepgram' ? t.deepgramModel : t.whisperModel,
      purpose: 'dictation',
      audio_seconds: audio.length / sampleRate,
      audio_mode: 'prerecorded',
      multilingual: t.language === 'multi',
      keyterms: settings.dictionary.length > 0
    })
    return text
  }

  private async deepgram(audio: Float32Array, sampleRate: number, t: Settings['transcription']): Promise<string> {
    const key = this.deps.deepgramKey()
    if (!key) throw new Error(`Set DEEPGRAM_API_KEY in ${this.deps.envFile} to dictate, or switch to local Whisper in Settings → Transcription.`)
    const url = new URL(this.deps.deepgramUrl ?? DEEPGRAM_LISTEN_URL)
    url.searchParams.set('model', t.deepgramModel)
    url.searchParams.set('smart_format', 'true')
    url.searchParams.set('punctuate', 'true')
    url.searchParams.set('mip_opt_out', 'true')
    url.searchParams.set('language', t.language === 'multi' ? 'multi' : t.language || 'en')
    for (const term of this.deps.settings().dictionary.slice(0, 100)) url.searchParams.append(t.deepgramModel.startsWith('nova-3') ? 'keyterm' : 'keywords', term)
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Token ${key}`, 'content-type': 'audio/wav' },
      body: new Uint8Array(encodeWav(audio, sampleRate)),
      signal: AbortSignal.timeout(120_000)
    })
    if (res.status === 401 || res.status === 403) throw new Error("Deepgram rejected the API key. Check DEEPGRAM_API_KEY in Cereal's .env file.")
    if (!res.ok) throw new Error(`Deepgram couldn’t transcribe the dictation (HTTP ${res.status}).`)
    const json = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } }
    return (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim()
  }

  private async local(audio: Float32Array, sampleRate: number, t: Settings['transcription']): Promise<string> {
    const binary = findWhisperServer(t.whisperServerPath)
    if (!binary) throw new Error('whisper-server was not found. Install whisper.cpp (sudo dnf install whisper-cpp) or set its path in Settings → Transcription.')
    const key = `${binary}|${t.whisperModel}|${t.whisperThreads}`
    if (this.whisper?.key !== key) {
      this.whisper?.server.stop()
      this.whisper = { server: new WhisperServer(binary, this.deps.whisperModelPath(t.whisperModel), t.whisperThreads), key }
    }
    if (this.idle) clearTimeout(this.idle)
    try {
      const dictionary = this.deps.settings().dictionary
      return await this.whisper.server.transcribe(audio, sampleRate, dictionary.length ? dictionary.join(', ') : undefined)
    } finally {
      this.idle = setTimeout(() => this.stop(), WHISPER_IDLE_MS)
    }
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    this.whisper?.server.stop()
    this.whisper = null
  }
}
