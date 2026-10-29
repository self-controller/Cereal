import { randomUUID } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import type { Store } from './db/store'
import type { CaptureOptions } from './audio/pipewire'
import type { EngineSegment, TranscriptionEngine, TranscriptionStream } from './transcription/types'
import type { RecordingState, Settings, TranscriptChunk, TranscriptSource } from '@shared/types'
import type { NewUsageEvent } from '@shared/usage'
import { recordSafely, type RecordUsage } from './usage'

export interface CaptureLike extends EventEmitter {
  start(): void
  stop(): void
}

export interface RecorderDeps {
  store: Store
  settings: () => Settings
  createEngine: () => Promise<TranscriptionEngine>
  createCapture: (opts: CaptureOptions) => CaptureLike
  emitChunks: (documentId: string, chunks: TranscriptChunk[]) => void
  emitState: (state: RecordingState) => void
  emitLevels: (levels: { microphone: number; system: number }) => void
  sampleRate: number
  recordUsage?: RecordUsage
}

interface SourcePipe {
  source: TranscriptSource
  capture: CaptureLike
  stream: TranscriptionStream
  startedAt: number
  /** Engine utterance key → chunk id. */
  ids: Map<string, string>
  /** PCM16 bytes sent to the engine: what a streaming engine bills for. */
  bytes: number
}

const IDLE: RecordingState = { status: 'idle', document_id: null, started_at: null, engine: null, sources: [], error: null, warnings: [] }

/**
 * Runs one recording: PipeWire capture per source → transcription stream per source → transcript chunks.
 * Interim results keep a chunk id until finalized (Granola's mergeTranscriptChunks semantics);
 * final chunks are persisted immediately, and anything still interim is finalized on stop.
 */
export class Recorder {
  private state: RecordingState = IDLE
  private pipes: SourcePipe[] = []
  private engine: TranscriptionEngine | null = null
  private interims = new Map<string, TranscriptChunk>()
  private levels = { microphone: 0, system: 0 }
  private levelTimer: NodeJS.Timeout | null = null
  /** Scopes this recording's speaker sessions, so diarized labels never collide across stop/start. */
  private recordingId = ''
  /** How this recording's audio is billed; each pipe's audio is recorded against it when the recording ends. */
  private usage: Omit<NewUsageEvent, 'audio_seconds'> | null = null

  constructor(private readonly deps: RecorderDeps) {}

  getState(): RecordingState {
    return this.state
  }

  private setState(patch: Partial<RecordingState>): RecordingState {
    this.state = { ...this.state, ...patch }
    this.deps.emitState(this.state)
    return this.state
  }

  async start(documentId: string): Promise<RecordingState> {
    if (this.state.status !== 'idle') {
      if (this.state.document_id === documentId) return this.state
      await this.stop()
    }
    const doc = this.deps.store.getDocument(documentId)
    if (!doc) throw new Error('Note not found')
    const settings = this.deps.settings()
    this.setState({ ...IDLE, status: 'starting', document_id: documentId, warnings: [] })
    this.recordingId = randomUUID().slice(0, 8)

    try {
      this.engine = await this.deps.createEngine()
      const keyterms = [...settings.dictionary, settings.profile.name, ...doc.people.map((p) => p.name)].filter((t): t is string => !!t && t.length < 50)
      const t = settings.transcription
      this.usage = {
        kind: 'audio',
        provider: this.engine.id,
        model: this.engine.id === 'deepgram' ? t.deepgramModel : t.whisperModel,
        purpose: 'transcription',
        audio_mode: 'streaming',
        multilingual: t.language === 'multi',
        diarized: t.diarize,
        keyterms: keyterms.length > 0,
        document_id: documentId
      }
      // Lecture mode is mic-only: the mic hears the room, and there is no call audio to capture.
      const sources: TranscriptSource[] = settings.audio.captureSystem && doc.mode !== 'lecture' ? ['microphone', 'system'] : ['microphone']
      for (const source of sources) {
        // Both streams are diarized, as Notion does (docs/notion-speakers.md §1): the mic can hear a room, and the
        // call audio carries every remote voice.
        const stream = await this.engine.open({
          source,
          sampleRate: this.deps.sampleRate,
          language: settings.transcription.language,
          keyterms,
          diarize: settings.transcription.diarize
        })
        const capture = this.deps.createCapture({
          source,
          target: source === 'microphone' ? settings.audio.micTarget : settings.audio.systemTarget
        })
        const pipe: SourcePipe = { source, capture, stream, startedAt: Date.now(), ids: new Map(), bytes: 0 }
        stream.on('segment', (seg: EngineSegment) => this.onSegment(documentId, pipe, seg))
        stream.on('warning', (w: string) => this.warn(w))
        stream.on('error', (e: Error) => this.fail(e))
        capture.on('data', (pcm: Buffer) => {
          pipe.bytes += pcm.length
          stream.write(pcm)
        })
        capture.on('level', (rms: number) => (this.levels[source] = rms))
        capture.on('error', (e: Error) => (source === 'system' ? this.warn(`System audio unavailable: ${e.message}`) : this.fail(e)))
        capture.start()
        pipe.startedAt = Date.now()
        this.pipes.push(pipe)
      }
      this.levelTimer = setInterval(() => this.deps.emitLevels({ ...this.levels }), 100)
      return this.setState({ status: 'recording', started_at: new Date().toISOString(), engine: this.engine.id, sources, error: null })
    } catch (e) {
      this.teardown()
      this.setState({ ...IDLE, error: (e as Error).message })
      throw e
    }
  }

  private onSegment(documentId: string, pipe: SourcePipe, seg: EngineSegment): void {
    let id = pipe.ids.get(seg.key)
    if (!id) {
      id = randomUUID()
      pipe.ids.set(seg.key, id)
    }
    const chunk: TranscriptChunk = {
      id,
      document_id: documentId,
      source: pipe.source,
      text: seg.text,
      start_timestamp: new Date(pipe.startedAt + seg.startMs).toISOString(),
      end_timestamp: new Date(pipe.startedAt + Math.max(seg.endMs, seg.startMs)).toISOString(),
      is_final: seg.isFinal,
      speaker: seg.speaker ?? null,
      speaker_session: seg.speaker === undefined ? null : `${this.recordingId}-${pipe.source}-${seg.session ?? '0'}`
    }
    if (seg.isFinal) {
      pipe.ids.delete(seg.key)
      this.interims.delete(id)
      this.deps.store.upsertChunks([chunk])
    } else {
      this.interims.set(id, chunk)
    }
    this.deps.emitChunks(documentId, [chunk])
  }

  private warn(message: string): void {
    if (!this.state.warnings.includes(message)) this.setState({ warnings: [...this.state.warnings, message] })
  }

  private fail(e: Error): void {
    this.setState({ error: e.message })
    void this.stop()
  }

  async stop(): Promise<RecordingState> {
    if (this.state.status === 'idle' || this.state.status === 'stopping') return this.state
    const documentId = this.state.document_id
    this.setState({ status: 'stopping' })
    for (const p of this.pipes) p.capture.stop()
    await Promise.all(this.pipes.map((p) => p.stream.finish().catch(() => undefined)))
    // Anything never finalized by the engine becomes final now.
    const leftovers = [...this.interims.values()].map((c) => ({ ...c, is_final: true }))
    if (documentId) {
      if (leftovers.length) {
        this.deps.store.upsertChunks(leftovers)
        this.deps.emitChunks(documentId, leftovers)
      }
      this.deps.store.finalizeTranscript(documentId)
    }
    this.teardown()
    return this.setState({ ...IDLE, error: this.state.error, document_id: documentId })
  }

  private teardown(): void {
    for (const p of this.pipes) {
      p.capture.stop()
      p.stream.close()
      // One usage event per stream: with system audio on, a meeting is billed as two streams.
      if (this.usage && p.bytes) recordSafely(this.deps.recordUsage, { ...this.usage, audio_seconds: p.bytes / 2 / this.deps.sampleRate })
    }
    this.usage = null
    this.pipes = []
    this.interims.clear()
    if (this.levelTimer) clearInterval(this.levelTimer)
    this.levelTimer = null
    this.levels = { microphone: 0, system: 0 }
    this.deps.emitLevels(this.levels)
    this.engine?.dispose?.()
    this.engine = null
  }
}
