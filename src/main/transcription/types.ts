import type { EventEmitter } from 'node:events'
import type { TranscriptSource } from '@shared/types'

/**
 * A piece of transcript from one audio source. `key` identifies the utterance being refined:
 * interim results for the same audio share a key until one arrives with `isFinal`.
 * Times are milliseconds from the start of this stream's audio.
 */
export interface EngineSegment {
  key: string
  text: string
  startMs: number
  endMs: number
  isFinal: boolean
  /** Diarized speaker label, when the engine diarizes. Labels are only comparable within one `session`. */
  speaker?: string
  /** Identifies the engine session (e.g. one socket) the speaker label belongs to. */
  session?: string
}

/** Events: 'segment' (EngineSegment), 'error' (Error), 'warning' (string). */
export interface TranscriptionStream extends EventEmitter {
  write(pcm: Buffer): void
  /** Flush buffered audio and wait for the last final results. */
  finish(): Promise<void>
  /** Abort immediately. */
  close(): void
}

export interface StreamOptions {
  source: TranscriptSource
  sampleRate: number
  language: string
  /** Custom vocabulary: user dictionary and attendee names. */
  keyterms: string[]
  /** Tell voices apart within this stream (engines that can't ignore it). */
  diarize?: boolean
}

export interface TranscriptionEngine {
  readonly id: 'deepgram' | 'whisper'
  open(opts: StreamOptions): Promise<TranscriptionStream>
  dispose?(): void
}
