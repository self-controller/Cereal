import type { SpeakerView } from './speakers'
import type { NoteMode, TranscriptChunk, TranscriptSource } from './types'

/** Order chunks by start time, then end time, then id (same ordering Granola's reducer uses). */
export function compareChunks(a: TranscriptChunk, b: TranscriptChunk): number {
  if (a.start_timestamp !== b.start_timestamp) return a.start_timestamp < b.start_timestamp ? -1 : 1
  if (a.end_timestamp !== b.end_timestamp) return a.end_timestamp < b.end_timestamp ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Upsert `incoming` chunks into `existing` by id and keep the list sorted.
 * An interim chunk keeps its id until it is finalized, so later interims and the
 * final result replace it in place. Returns a new array.
 */
export function mergeTranscriptChunks(existing: TranscriptChunk[], incoming: TranscriptChunk[]): TranscriptChunk[] {
  if (incoming.length === 0) return existing
  const byId = new Map(existing.map((c) => [c.id, c]))
  for (const chunk of incoming) byId.set(chunk.id, { ...byId.get(chunk.id), ...chunk })
  return [...byId.values()].filter((c) => c.text.trim().length > 0).sort(compareChunks)
}

/** Drop non-final chunks for one source (e.g. when its stream restarts). */
export function deletePartialChunks(chunks: TranscriptChunk[], source: TranscriptSource): TranscriptChunk[] {
  return chunks.filter((c) => c.is_final || c.source !== source)
}

/** Mark every chunk final (recording stopped). */
export function finalizeChunks(chunks: TranscriptChunk[]): TranscriptChunk[] {
  return chunks.map((c) => (c.is_final ? c : { ...c, is_final: true }))
}

export const SPEAKER_LABEL: Record<TranscriptSource, string> = {
  microphone: 'You',
  system: 'Them'
}

/** In lecture mode the microphone hears whoever is talking in the room, not the note-taker. */
export const LECTURE_SPEAKER_LABEL: Record<TranscriptSource, string> = {
  microphone: 'Speaker',
  system: 'Them'
}

export function transcriptLabels(mode: NoteMode): Record<TranscriptSource, string> {
  return mode === 'lecture' ? LECTURE_SPEAKER_LABEL : SPEAKER_LABEL
}

export interface TranscriptTurn {
  source: TranscriptSource
  start: string
  end: string
  text: string
  chunkIds: string[]
  /** The speaker's label, when grouped by speaker. */
  speaker?: string
}

/**
 * Group consecutive chunks from the same source (and the same speaker, given `speakerOf`) into speaker turns.
 * A turn longer than `maxTurnMs` starts a new one, so a monologue (a lecture) reads as timestamped paragraphs.
 */
export function groupTurns(chunks: TranscriptChunk[], maxGapMs = 15_000, maxTurnMs = 60_000, speakerOf?: (c: TranscriptChunk) => string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const c of [...chunks].sort(compareChunks)) {
    const text = c.text.trim()
    if (!text) continue
    const last = turns[turns.length - 1]
    const gap = last ? Date.parse(c.start_timestamp) - Date.parse(last.end) : Infinity
    const span = last ? Date.parse(c.end_timestamp) - Date.parse(last.start) : 0
    const speaker = speakerOf?.(c)
    if (last && last.source === c.source && last.speaker === speaker && gap <= maxGapMs && span <= maxTurnMs) {
      last.text += ' ' + text
      last.end = c.end_timestamp > last.end ? c.end_timestamp : last.end
      last.chunkIds.push(c.id)
    } else {
      turns.push({ source: c.source, start: c.start_timestamp, end: c.end_timestamp, text, chunkIds: [c.id], ...(speaker === undefined ? {} : { speaker }) })
    }
  }
  return turns
}

/**
 * Group chunks into transcript bubbles the way Granola's transcript does: consecutive chunks from one source share
 * a bubble until a chunk ends a sentence with a full stop, so live speech grows one bubble instead of stacking new ones.
 * Given `speakerOf`, a change of speaker also starts a new bubble.
 */
export function groupChunks(chunks: TranscriptChunk[], speakerOf?: (c: TranscriptChunk) => string): TranscriptChunk[][] {
  const groups: TranscriptChunk[][] = []
  for (const c of [...chunks].sort(compareChunks)) {
    if (!c.text.trim()) continue
    const group = groups[groups.length - 1]
    const last = group?.[group.length - 1]
    const sameSpeaker = !speakerOf || (last && speakerOf(last) === speakerOf(c))
    if (group && last && last.source === c.source && sameSpeaker && !last.text.trim().endsWith('.')) group.push(c)
    else groups.push([c])
  }
  return groups
}

/** "mm:ss" (or "h:mm:ss") from `originMs` to `iso`. */
export function clock(iso: string, originMs: number): string {
  const s = Math.max(0, Math.round((Date.parse(iso) - originMs) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

/** Plain-text transcript for prompts: "[mm:ss] You: …" per speaker turn. */
export function formatTranscript(
  chunks: TranscriptChunk[],
  opts: {
    timestamps?: boolean
    labels?: Partial<Record<TranscriptSource, string>>
    /** Label turns by resolved speaker (src/shared/speakers.ts) instead of `labels`, and leave out mic echoes. */
    speakers?: SpeakerView
    /** Time zero for the [mm:ss] stamps (default: the first turn). */
    origin?: string
  } = {}
): string {
  const view = opts.speakers
  const turns = groupTurns(
    chunks.filter((c) => c.is_final && !view?.echo.has(c.id)),
    undefined,
    undefined,
    view?.labelOf
  )
  if (turns.length === 0) return ''
  const origin = Date.parse(opts.origin ?? turns[0].start)
  const labels = { ...SPEAKER_LABEL, ...opts.labels }
  return turns
    .map((t) => `${opts.timestamps === false ? '' : `[${clock(t.start, origin)}] `}${t.speaker ?? labels[t.source]}: ${t.text}`)
    .join('\n')
}

/** Heading budget for summaries, by transcript length (docs/granola-findings.md §6). */
export function maxNumHeadings(transcriptLength: number): number {
  if (transcriptLength < 8_000) return 4
  if (transcriptLength < 20_000) return 5
  if (transcriptLength < 80_000) return Math.floor(transcriptLength / 10_000) + 1
  return 8
}

export interface TranscriptMatch {
  chunkId: string
  /** Offsets into the chunk's text. */
  start: number
  end: number
}

/** "Find in transcript": every case-insensitive occurrence of `query`, in transcript order. */
export function findInChunks(chunks: TranscriptChunk[], query: string): TranscriptMatch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: TranscriptMatch[] = []
  for (const c of [...chunks].sort(compareChunks)) {
    const text = c.text.toLowerCase()
    for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + q.length)) out.push({ chunkId: c.id, start: i, end: i + q.length })
  }
  return out
}
