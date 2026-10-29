// The chat bar's behaviour that doesn't need a DOM (docs/granola-chat-bar.md §2, §4, §5): which placeholder shows,
// when "/" and "@" open their menus, and how recipes are ranked. Pure, so it is unit-tested.
import type { Recipe } from './types'

/** Where a chat bar is: one meeting, all meetings, or the notes of a folder. */
export type ChatSurface = 'meeting' | 'global' | 'folder'

export interface PlaceholderState {
  surface: ChatSurface
  disabled?: boolean
  disabledMessage?: string
  /** The caller's own text (the Chat page's sample questions, a lecture's wording). */
  override?: string
  transcribing?: boolean
  /** The floating bar is collapsed (its panel closed) while an answer streams. */
  collapsed?: boolean
  streamingText?: boolean
  /** An answer is being worked on but nothing has streamed yet; the time it started. */
  thinkingSince?: number | null
  now?: number
  noteDragOver?: boolean
  /** Text is selected in the note and the bar isn't focused. */
  selectionPending?: boolean
  hasMessages?: boolean
}

/** Words the collapsed bar cycles through while the model thinks (Cereal's own list). */
export const THINKING_WORDS = ['Thinking...', 'Pondering...', 'Reading...', 'Connecting dots...', 'Working on it...', 'Mulling it over...']
export const THINKING_ROTATE_MS = 3000

/** The chat bar's placeholder: the first state that applies wins. */
export function chatPlaceholder(s: PlaceholderState): string {
  if (s.disabled) return s.disabledMessage || 'Record a meeting to start asking questions'
  if (s.transcribing) return 'Transcribing...'
  if (s.collapsed && s.streamingText) return 'Replying...'
  if (s.collapsed && s.thinkingSince != null) {
    const elapsed = Math.max(0, (s.now ?? Date.now()) - s.thinkingSince)
    const step = Math.floor(elapsed / THINKING_ROTATE_MS)
    if (step === 0) return THINKING_WORDS[0]
    // The first word is always "Thinking..."; after that a word picked from the start time, never the same twice.
    const offset = Math.floor(s.thinkingSince / 1000) % (THINKING_WORDS.length - 1)
    return THINKING_WORDS[1 + ((offset + step - 1) % (THINKING_WORDS.length - 1))]
  }
  if (s.noteDragOver) return 'Drop the note to ask about it'
  if (s.selectionPending) return 'Chat with selected text'
  if (s.collapsed && s.hasMessages) return 'Continue chat'
  if (s.override) return s.override
  return s.surface === 'folder' ? 'Ask about folder' : 'Ask anything'
}

/** Sample questions the empty Chat page rotates through as its placeholder (Cereal's own). */
export const SAMPLE_QUESTIONS = [
  'What did I promise to do this week?',
  'Summarise yesterday’s meetings',
  'Which customers mentioned pricing?',
  'What decisions are still open?',
  'Who have I met with most this month?',
  'What came up in my last 1:1?'
]

// ---------------------------------------------------------------- triggers

export type Trigger = { kind: 'recipe'; query: string } | { kind: 'mention'; query: string }

/**
 * What menu the text before the cursor opens, if any. "/" works only at the start of a line and the query can't
 * start with a space or hold two in a row; "@" works anywhere after a space (or at the start), spaces allowed.
 */
export function detectTrigger(beforeCursor: string): Trigger | null {
  const line = beforeCursor.slice(beforeCursor.lastIndexOf('\n') + 1)
  const slash = line.match(/^\/([^\n]*)$/)
  if (slash) {
    const q = slash[1]
    if (q.startsWith(' ') || q.includes('  ')) return null
    return { kind: 'recipe', query: q }
  }
  const at = line.match(/(?:^|\s)@([^@\n]*)$/)
  if (at && !at[1].startsWith(' ') && !at[1].includes('  ') && at[1].length <= 60) return { kind: 'mention', query: at[1] }
  return null
}

/** "follow-up-email" → "Follow up email": how a recipe reads in the bar and the menu. */
export function titleCaseSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : words
}

/** The recipe a typed slash query names exactly, if any (spaces stand for "-" or "_", any case). */
export function exactRecipe(query: string, recipes: Recipe[]): Recipe | null {
  const want = normalise(query).replace(/\s+/g, '-')
  if (!want) return null
  return recipes.find((r) => normalise(r.slug).replace(/_/g, '-') === want) ?? null
}

function normalise(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

/** How well `query` matches `text`: 1 for a prefix, less for a word start or a scattered subsequence, 0 for none. */
export function fuzzyScore(query: string, text: string): number {
  const q = normalise(query).replace(/[-_\s]+/g, ' ')
  const t = normalise(text).replace(/[-_\s]+/g, ' ')
  if (!q) return 1
  if (t.startsWith(q)) return 1
  const word = t.indexOf(` ${q}`)
  if (word >= 0) return 0.85
  const inside = t.indexOf(q)
  if (inside >= 0) return 0.7
  // Every query character in order, with a penalty for gaps.
  let ti = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return 0
    gaps += found - ti
    ti = found + 1
  }
  return Math.max(0.05, 0.5 - gaps / (t.length * 2))
}

export interface RecipeSections {
  recent: Recipe[]
  mine: Recipe[]
  all: Recipe[]
}

/**
 * The recipe menu (docs/granola-chat-bar.md §4): "Recent" (the last three used, only before a query is typed),
 * "My recipes" (the user's own) and "All recipes" (built-in). Matches are ranked by fit, then use.
 */
export function rankRecipes(recipes: Recipe[], query: string): RecipeSections {
  const scored = recipes
    // Descriptions only count for a literal match: a loose subsequence across a long sentence matches almost anything.
    .map((r) => ({ r, score: Math.max(fuzzyScore(query, r.slug) * 0.5 + fuzzyScore(query, r.name) * 0.3, query.trim() && normalise(r.description).includes(normalise(query)) ? 0.2 : 0) }))
    .filter((x) => !query.trim() || x.score > 0.05)
    .sort((a, b) => b.score - a.score || b.r.usage_count - a.r.usage_count || a.r.name.localeCompare(b.r.name))
    .map((x) => x.r)
    .slice(0, 50)
  const recent = query.trim()
    ? []
    : [...recipes]
        .filter((r) => r.last_used_at)
        .sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? ''))
        .slice(0, 3)
  const inRecent = new Set(recent.map((r) => r.id))
  return {
    recent,
    mine: scored.filter((r) => !r.builtin && !inRecent.has(r.id)),
    all: scored.filter((r) => r.builtin && !inRecent.has(r.id))
  }
}

/** A stable gradient for a recipe's icon tile, picked by hashing its id. */
export function recipeTone(id: string, tones: number): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % tones
}
