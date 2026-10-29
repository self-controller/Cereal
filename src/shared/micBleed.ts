import type { TranscriptChunk } from './types'

// Cereal records the mic with no echo cancellation, so call audio played on speakers is transcribed a second time
// from the mic. Notion avoids this with system-wide echo cancellation (docs/notion-speakers.md §3); we instead hide
// mic chunks that repeat what the call audio said at the same moment. Hidden, never deleted.

/** How far apart (ms) a mic chunk and a system chunk may be and still count as the same moment. */
export const ECHO_SLACK_MS = 1_000
/** Share of the mic chunk's words that must also be in the overlapping system chunk. */
export const ECHO_MIN_SHARED = 0.6
/** Shorter mic chunks ("yes", "okay") are too likely to match by chance. */
export const ECHO_MIN_WORDS = 3

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

interface Span {
  start: number
  end: number
  words: Set<string>
}

/** Ids of final mic chunks that are echoes of the call audio. */
export function echoChunkIds(chunks: TranscriptChunk[]): Set<string> {
  const system: Span[] = chunks
    .filter((c) => c.source === 'system')
    .map((c) => ({ start: Date.parse(c.start_timestamp), end: Date.parse(c.end_timestamp), words: new Set(words(c.text)) }))
    .sort((a, b) => a.start - b.start)
  const echo = new Set<string>()
  if (system.length === 0) return echo
  // Chunks are short, so a system chunk that overlaps [start, end] starts within this much of `start`.
  const longest = Math.max(...system.map((s) => s.end - s.start))
  for (const c of chunks) {
    if (c.source !== 'microphone' || !c.is_final) continue
    const mine = words(c.text)
    if (mine.length < ECHO_MIN_WORDS) continue
    const start = Date.parse(c.start_timestamp) - ECHO_SLACK_MS
    const end = Date.parse(c.end_timestamp) + ECHO_SLACK_MS
    for (let i = firstStartingAfter(system, start - longest); i < system.length && system[i].start <= end; i++) {
      const s = system[i]
      if (s.end < start) continue
      const shared = mine.filter((w) => s.words.has(w)).length
      if (shared / mine.length >= ECHO_MIN_SHARED) {
        echo.add(c.id)
        break
      }
    }
  }
  return echo
}

function firstStartingAfter(spans: Span[], t: number): number {
  let lo = 0
  let hi = spans.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (spans[mid].start < t) lo = mid + 1
    else hi = mid
  }
  return lo
}
