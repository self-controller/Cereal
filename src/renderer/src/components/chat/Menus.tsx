import { useEffect, useRef, type ReactNode } from 'react'
import { FileText, Plus, WandSparkles } from 'lucide-react'
import { recipeTone, titleCaseSlug, type RecipeSections } from '@shared/chatbar'
import type { Recipe } from '@shared/types'
import { dayLabel } from '../../lib/format'
import { Spinner, cn, motion } from '../oats'

/** Icon tiles: one of these gradients per recipe, picked by its id. */
const TONES = [
  'from-oats-yellow-50 to-oats-yellow-100',
  'from-oats-blue-50 to-oats-blue-200',
  'from-oats-purple-100 to-oats-pink-100',
  'from-oats-red-50 to-oats-red-100',
  'from-oats-gold-100 to-oats-yellow-100',
  'from-oats-neutral-100 to-oats-neutral-300'
]

/** The panel both menus open in, above the bar (docs/granola-chat-bar.md §4: the inline variant). */
function MenuShell({ children, className, label }: { children: ReactNode; className?: string; label: string }): ReactNode {
  return (
    <motion.div
      role="listbox"
      aria-label={label}
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.2, ease: 'easeInOut' }}
      onMouseDown={(e) => e.preventDefault()}
      className={cn(
        'absolute inset-x-0 bottom-full z-40 mb-2 overflow-hidden rounded-[20px] border border-black/15 bg-white/70 shadow-lg backdrop-blur-xl dark:border-white/10 dark:bg-oats-neutral-800/80',
        className
      )}
    >
      {children}
    </motion.div>
  )
}

/** Keep the highlighted row in view as the arrow keys move it. */
function useScrollActive(active: number): React.RefObject<HTMLDivElement | null> {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)
    // scrollIntoView returns a Promise in recent Chromium; never return it from an effect.
    if (row) void row.scrollIntoView({ block: 'nearest' })
  }, [active])
  return list
}

export function recipeOrder(sections: RecipeSections): Recipe[] {
  return [...sections.recent, ...sections.mine, ...sections.all]
}

export function RecipeMenu({
  sections,
  query,
  active,
  onHover,
  onPick,
  onCreate,
  onBrowse
}: {
  sections: RecipeSections
  query: string
  active: number
  onHover: (i: number) => void
  onPick: (r: Recipe) => void
  onCreate: () => void
  onBrowse: () => void
}): ReactNode {
  const list = useScrollActive(active)
  let index = 0
  const section = (title: string, recipes: Recipe[]): ReactNode =>
    recipes.length > 0 && (
      <div key={title}>
        <div className="px-3 pt-2 pb-1 text-xs text-ink-tertiary">{title}</div>
        {recipes.map((r) => {
          const i = index++
          return (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={i === active}
              data-index={i}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(r)}
              className={cn('flex w-full cursor-default items-center gap-2.5 rounded-2xl p-1.5 pr-3 text-left', i === active && 'bg-oats-off-black-a6 dark:bg-oats-off-white-a6')}
            >
              <span className={cn('flex size-7 shrink-0 items-center justify-center rounded-lg bg-linear-to-br text-oats-neutral-800', TONES[recipeTone(r.id, TONES.length)])}>
                <WandSparkles size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink-primary">{titleCaseSlug(r.slug)}</span>
                {r.description && <span className="block truncate text-xs text-ink-tertiary">{r.description}</span>}
              </span>
              {r.usage_count >= 5 && <span className="shrink-0 text-xs text-ink-tertiary">Used {r.usage_count} times</span>}
            </button>
          )
        })}
      </div>
    )
  const empty = !sections.recent.length && !sections.mine.length && !sections.all.length
  return (
    <MenuShell label="Recipes">
      <div className="flex h-12 items-center gap-1 border-b border-hairline px-3">
        <span className="flex-1 text-sm font-medium text-ink-primary">Recipes</span>
        <button type="button" onClick={onCreate} className="flex h-7 cursor-default items-center gap-1 rounded-full px-2.5 text-sm text-ink-secondary hover:bg-highlight hover:text-ink-primary">
          <Plus size={14} /> Create
        </button>
        <button type="button" onClick={onBrowse} className="flex h-7 cursor-default items-center rounded-full px-2.5 text-sm text-ink-secondary hover:bg-highlight hover:text-ink-primary">
          Browse
        </button>
      </div>
      <div ref={list} className="max-h-80 overflow-y-auto p-1.5">
        {empty ? (
          <div className="px-3 py-4 text-sm text-ink-tertiary">No recipes found matching “{query}”</div>
        ) : (
          <>
            {section('Recent', sections.recent)}
            {section('My recipes', sections.mine)}
            {section('All recipes', sections.all)}
          </>
        )}
      </div>
    </MenuShell>
  )
}

export interface MentionCandidate {
  id: string
  title: string
  created_at: string
}

/** The title with the matched part in bold. */
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1
  if (at < 0) return text
  return (
    <>
      {text.slice(0, at)}
      <span className="font-semibold">{text.slice(at, at + query.length)}</span>
      {text.slice(at + query.length)}
    </>
  )
}

export function MentionMenu({
  notes,
  query,
  loading,
  active,
  onHover,
  onPick
}: {
  notes: MentionCandidate[]
  query: string
  loading: boolean
  active: number
  onHover: (i: number) => void
  onPick: (n: MentionCandidate) => void
}): ReactNode {
  const list = useScrollActive(active)
  return (
    <MenuShell label="Notes">
      <div className="flex h-10 items-center gap-2 px-3 text-xs text-ink-tertiary">
        <span className="flex-1">Notes</span>
        {loading && <Spinner className="size-3 border-[1.5px]" />}
      </div>
      <div ref={list} className="max-h-72 overflow-y-auto px-1.5 pb-1.5">
        {!loading && notes.length === 0 && <div className="px-3 py-3 text-sm text-ink-tertiary">{query ? `No notes found matching “${query}”` : 'No notes yet'}</div>}
        {notes.map((n, i) => (
          <button
            key={n.id}
            type="button"
            role="option"
            aria-selected={i === active}
            data-index={i}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(n)}
            className={cn('flex w-full cursor-default items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm', i === active && 'bg-oats-off-black-a6 dark:bg-oats-off-white-a6')}
          >
            <FileText size={16} className="shrink-0 text-ink-tertiary" />
            <span className="min-w-0 flex-1 truncate text-ink-primary">
              <Highlight text={n.title || 'New note'} query={query} />
            </span>
            <span className="shrink-0 text-xs text-ink-tertiary">{dayLabel(n.created_at)}</span>
          </button>
        ))}
      </div>
    </MenuShell>
  )
}
