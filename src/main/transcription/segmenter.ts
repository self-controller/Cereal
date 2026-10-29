// Voice-activity segmentation for local (whisper.cpp) transcription.
// Timing constants match Granola's local ASR pipeline (docs/granola-findings.md §4);
// the detector itself is a simple adaptive energy VAD rather than Silero.

export const HOP = 512 // samples at 16 kHz = 32 ms
export const PREROLL_HOPS = 8 // ~256 ms of audio kept before speech onset
export const CLOSE_SILENCE_HOPS = 25 // ~800 ms of silence closes a segment
export const MIN_SPEECH_HOPS = 6 // ignore blips shorter than ~190 ms
export const MAX_SEGMENT_MS = 25_000
export const PARTIAL_EVERY_HOPS = 31 // re-decode the open segment about once a second

export interface SegmentEvent {
  type: 'partial' | 'final'
  id: number
  startSample: number
  endSample: number
  audio: Float32Array
}

export interface SegmenterOptions {
  sampleRate?: number
  /** Absolute RMS floor below which audio is never speech. */
  minRms?: number
  /** Speech when RMS exceeds noiseFloor × ratio. */
  ratio?: number
}

export class Segmenter {
  private readonly sampleRate: number
  private readonly minRms: number
  private readonly ratio: number
  private noiseFloor = 0.002
  private buffer: Float32Array = new Float32Array(0)
  private bufferBase = 0 // absolute sample index of buffer[0]
  private pending: Float32Array = new Float32Array(0) // samples not yet forming a full hop
  private hop = 0 // number of hops consumed
  private segStartHop: number | null = null
  private segId = 0
  private speechHops = 0
  private silenceRun = 0
  private lastPartialHop = 0

  constructor(opts: SegmenterOptions = {}) {
    this.sampleRate = opts.sampleRate ?? 16_000
    this.minRms = opts.minRms ?? 0.008
    this.ratio = opts.ratio ?? 3
  }

  push(samples: Float32Array): SegmentEvent[] {
    this.append(samples)
    const events: SegmentEvent[] = []
    const joined = concat(this.pending, samples)
    let offset = 0
    while (joined.length - offset >= HOP) {
      this.consumeHop(joined.subarray(offset, offset + HOP), events)
      offset += HOP
    }
    this.pending = joined.slice(offset)
    this.maybePartial(events)
    this.trim()
    return events
  }

  /** Close any open segment (end of recording). */
  flush(): SegmentEvent[] {
    const events: SegmentEvent[] = []
    if (this.segStartHop !== null) this.close(this.hop, events)
    return events
  }

  private consumeHop(frame: Float32Array, events: SegmentEvent[]): void {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)
    const speech = rms > Math.max(this.minRms, this.noiseFloor * this.ratio)
    // Track background level only during non-speech, slowly.
    if (!speech) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05

    const h = this.hop++
    if (speech) {
      if (this.segStartHop === null) {
        this.segStartHop = Math.max(0, h - PREROLL_HOPS, this.bufferBase / HOP)
        this.segId++
        this.speechHops = 0
        this.lastPartialHop = h
      }
      this.speechHops++
      this.silenceRun = 0
    } else if (this.segStartHop !== null && ++this.silenceRun >= CLOSE_SILENCE_HOPS) {
      this.close(h - this.silenceRun + 1 + PREROLL_HOPS, events)
      return
    }
    if (this.segStartHop !== null && ((h - this.segStartHop) * HOP * 1000) / this.sampleRate >= MAX_SEGMENT_MS) this.close(h + 1, events)
  }

  private maybePartial(events: SegmentEvent[]): void {
    if (this.segStartHop === null || this.speechHops < MIN_SPEECH_HOPS || this.hop - this.lastPartialHop < PARTIAL_EVERY_HOPS) return
    this.lastPartialHop = this.hop
    const start = this.segStartHop * HOP
    const end = Math.min(this.bufferBase + this.buffer.length, this.hop * HOP)
    if (end > start) events.push({ type: 'partial', id: this.segId, startSample: start, endSample: end, audio: this.slice(start, end) })
  }

  private close(endHop: number, events: SegmentEvent[]): void {
    const startHop = this.segStartHop
    this.segStartHop = null
    this.silenceRun = 0
    if (startHop === null || this.speechHops < MIN_SPEECH_HOPS) return
    const start = startHop * HOP
    const end = Math.min(this.bufferBase + this.buffer.length, endHop * HOP)
    if (end > start) events.push({ type: 'final', id: this.segId, startSample: start, endSample: end, audio: this.slice(start, end) })
  }

  private append(samples: Float32Array): void {
    this.buffer = concat(this.buffer, samples)
  }

  private slice(start: number, end: number): Float32Array {
    return this.buffer.slice(Math.max(0, start - this.bufferBase), end - this.bufferBase)
  }

  /** Drop audio that can no longer be part of a segment. */
  private trim(): void {
    const keepFrom = (this.segStartHop ?? Math.max(0, this.hop - PREROLL_HOPS)) * HOP
    const drop = keepFrom - this.bufferBase
    if (drop > this.sampleRate * 5) {
      this.buffer = this.buffer.slice(drop)
      this.bufferBase = keepFrom
    }
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Float32Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

export function pcm16ToFloat32(buf: Buffer): Float32Array {
  const out = new Float32Array(Math.floor(buf.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

/** Encode mono float samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Keeps partial transcripts stable: only the longest word prefix shared by two successive
 * hypotheses is shown (a "local agreement" policy, as in Granola's local ASR).
 */
export class PrefixStabilizer {
  private previous: string[] | null = null
  private committed: string[] = []

  advance(words: string[]): string[] {
    const prev = this.previous
    this.previous = words
    if (!prev) return this.committed
    let n = 0
    while (n < prev.length && n < words.length && norm(prev[n]) === norm(words[n])) n++
    if (n > this.committed.length) this.committed = words.slice(0, n)
    return this.committed
  }
}

const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')
