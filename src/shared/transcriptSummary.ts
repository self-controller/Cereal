// "Transcript Summary": explain where one line of the enhanced notes came from. Like Granola, it is generated on demand
// for one line at a time and never stored: the model writes a short summary with verbatim quotes, and each quote is
// matched back to the transcript chunks it came from so the user can jump to it.
import type { TranscriptChunk } from './types'
import { groupTurns } from './transcript'
import { normalize, tokens } from './attribution'

/** What the model replies when nothing in the transcript relates to the line. */
export const NO_CONTEXT = 'NO_CONTEXT'

/** Whether a line has enough content to explain (not empty, a single character, or only punctuation). */
export function canExplainLine(text: string): boolean {
  const t = text.trim()
  return t.length > 1 && /[\p{L}\p{N}]/u.test(t)
}

function overlap(want: Set<string>, text: string): number {
  let n = 0
  for (const t of new Set(tokens(normalize(text)))) if (want.has(t)) n++
  return n
}

/**
 * The final chunks to show the model for one line. Enhanced lines carry no timestamp, so when the transcript is over
 * the budget, keep the turns that share the most words with the line (with two turns of context either side).
 */
export function selectTranscriptChunks(chunks: TranscriptChunk[], line: string, budgetChars: number): TranscriptChunk[] {
  const final = chunks.filter((c) => c.is_final && c.text.trim())
  const turns = groupTurns(final)
  // Each formatted turn is "[mm:ss] Label: text\n".
  const cost = (i: number): number => turns[i].text.length + 24
  if (turns.reduce((n, _, i) => n + cost(i), 0) <= budgetChars) return final

  const want = new Set(tokens(normalize(line)))
  const ranked = turns.map((t, i) => ({ i, score: overlap(want, t.text) })).sort((a, b) => b.score - a.score || a.i - b.i)
  const keep = new Set<number>()
  let size = 0
  outer: for (const { i } of ranked) {
    for (let j = Math.max(0, i - 2); j <= Math.min(turns.length - 1, i + 2); j++) {
      if (keep.has(j)) continue
      if (size + cost(j) > budgetChars) break outer
      keep.add(j)
      size += cost(j)
    }
  }
  const ids = new Set([...keep].flatMap((j) => turns[j].chunkIds))
  return final.filter((c) => ids.has(c.id))
}

export interface SummaryPart {
  kind: 'text' | 'quote'
  text: string
}

export interface ParsedSummary {
  parts: SummaryPart[]
  /** The model found nothing relevant. */
  noContext: boolean
}

const QUOTED = /^(?:[-*•]\s+)?["“](.+)["”]$/

function cleanQuote(text: string): string {
  let q = text.trim().replace(/^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*/, '')
  // A copied speaker label ("Them: …", "Alex (me): …").
  const labelled = q.match(/^[^:"“]{1,40}:\s+(.{10,})$/)
  if (labelled) q = labelled[1]
  const inner = q.match(/^["“](.+)["”]$/)
  return (inner ? inner[1] : q).trim()
}

/**
 * Split the model's reply into summary text and quotes. A quote is a "> " line, or a whole line in double quotes that is
 * long enough not to be a phrase. While streaming, the last line may be incomplete, so it is held back.
 */
export function parseSummary(text: string, streaming: boolean): ParsedSummary {
  const trimmed = text.trim()
  if (trimmed.startsWith(NO_CONTEXT) || (streaming && trimmed && NO_CONTEXT.startsWith(trimmed))) {
    return { parts: [], noContext: trimmed.startsWith(NO_CONTEXT) }
  }
  const lines = text.split('\n')
  if (streaming) lines.pop()
  const parts: SummaryPart[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      // A blank line ends a paragraph.
      if (parts[parts.length - 1]?.kind === 'text') parts.push({ kind: 'text', text: '' })
      continue
    }
    const quoted = line.match(QUOTED)
    if (line.startsWith('>') || (quoted && quoted[1].length > 35)) {
      const q = cleanQuote(line.startsWith('>') ? line.replace(/^>\s*/, '') : line.replace(/^[-*•]\s+/, ''))
      if (q) parts.push({ kind: 'quote', text: q })
      continue
    }
    const last = parts[parts.length - 1]
    if (last?.kind === 'text') last.text = last.text ? `${last.text} ${line}` : line
    else parts.push({ kind: 'text', text: line })
  }
  return { parts: parts.filter((p) => p.text), noContext: false }
}

export interface QuoteMatch {
  /** The chunks the quote spans, in transcript order. */
  chunkIds: string[]
  /** Share of the quote's words found in that stretch of transcript (1 = every word). */
  score: number
}

/**
 * Find where a quote came from: the stretch of transcript, as long as the quote, that shares the most words with it.
 * Linear in the transcript length; tolerant of the small rewordings, casing and punctuation changes models make.
 */
export function matchQuote(quote: string, chunks: TranscriptChunk[], minScore = 0.6): QuoteMatch | null {
  const need = new Map<string, number>()
  const quoteTokens = tokens(normalize(quote))
  if (quoteTokens.length === 0) return null
  for (const t of quoteTokens) need.set(t, (need.get(t) ?? 0) + 1)

  const words: string[] = []
  const owner: string[] = []
  for (const c of chunks) {
    if (!c.is_final) continue
    for (const t of tokens(normalize(c.text))) {
      words.push(t)
      owner.push(c.id)
    }
  }
  if (words.length === 0) return null

  const size = Math.min(quoteTokens.length, words.length)
  const have = new Map<string, number>()
  let matched = 0
  const add = (t: string): void => {
    const n = have.get(t) ?? 0
    if (n < (need.get(t) ?? 0)) matched++
    have.set(t, n + 1)
  }
  const remove = (t: string): void => {
    const n = (have.get(t) ?? 0) - 1
    have.set(t, n)
    if (n < (need.get(t) ?? 0)) matched--
  }
  let best = -1
  let bestStart = 0
  for (let i = 0; i < words.length; i++) {
    add(words[i])
    if (i >= size) remove(words[i - size])
    if (i >= size - 1 && matched > best) {
      best = matched
      bestStart = i - size + 1
    }
  }
  const score = best / quoteTokens.length
  if (score < minScore) return null
  return { chunkIds: [...new Set(owner.slice(bestStart, bestStart + size))], score }
}
