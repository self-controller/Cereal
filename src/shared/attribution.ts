// Decide which lines of an enhanced-notes panel came from the user's own notes.
// Granola stores this per panel as `generated_lines`: the set of (trimmed) line texts the AI wrote.
// Keying on text rather than position means an edited line simply stops matching and turns black.
import { markdownLineText, parseLines } from './markdown'

export function normalize(line: string): string {
  return line
    .toLowerCase()
    .replace(/^\s*(?:[-*+]|\d+[.)]|#{1,6}|>|\[[ x]\])\s*/g, '')
    .replace(/[*_`~[\]()#>]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokens(s: string): string[] {
  return s.split(' ').filter((t) => t.length > 1)
}

/** Fraction of the user line's tokens that appear in the output line, in order-insensitive fashion. */
function coverage(userTokens: string[], outTokens: Set<string>): number {
  if (userTokens.length === 0) return 0
  let hit = 0
  for (const t of userTokens) if (outTokens.has(t)) hit++
  return hit / userTokens.length
}

/**
 * Returns the 0-based indices of output lines that are AI-generated.
 * A line counts as user-authored when it substantially contains one of the user's note lines.
 * Blank lines and pure markdown scaffolding are never marked generated.
 */
export function computeGeneratedLines(outputMarkdown: string, userNotes: string, threshold = 0.75): number[] {
  const userLines = userNotes
    .split('\n')
    .map(normalize)
    .filter((l) => tokens(l).length >= 1)
    .map((l) => tokens(l))
  const generated: number[] = []
  outputMarkdown.split('\n').forEach((raw, i) => {
    const norm = normalize(raw)
    if (!norm) return
    if (/^#{1,6}\s/.test(raw.trim())) {
      // Headings count as the user's only when they reuse a user heading.
      const isUserHeading = userLines.some((u) => u.join(' ') === norm)
      if (!isUserHeading) generated.push(i)
      return
    }
    const outTokens = new Set(tokens(norm))
    const fromUser = userLines.some((u) => {
      const cov = coverage(u, outTokens)
      // Short user lines must match nearly exactly; long ones can be lightly edited.
      return u.length <= 2 ? cov === 1 && outTokens.size <= u.length + 3 : cov >= threshold
    })
    if (!fromUser) generated.push(i)
  })
  return generated
}

/** The editor texts of the AI-written lines, given their indices from `computeGeneratedLines`. */
export function generatedLineTexts(markdown: string, indices: number[]): string[] {
  const wanted = new Set(indices)
  const texts = new Set<string>()
  for (const line of parseLines(markdown)) {
    if (!wanted.has(line.index)) continue
    const text = markdownLineText(line)
    if (text) texts.add(text)
  }
  return [...texts]
}
