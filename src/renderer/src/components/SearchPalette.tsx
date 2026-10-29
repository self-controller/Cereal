import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Dialog as Base } from '@base-ui/react/dialog'
import { Bot, FileText, LayoutTemplate, MessageCircle, Settings, SquarePen, WandSparkles } from 'lucide-react'
import { call } from '../lib/api'
import { navigate } from '../lib/router'
import { dayLabel } from '../lib/format'
import { useApp } from '../store'
import { createNote } from '../views/HomeView'
import { useUi } from './shell/layout'
import { cn } from './oats'
import type { SearchHit } from '@shared/types'

// Ctrl+K palette over the FTS5 index, drawn as Granola's command menu (docs/granola-ui.md §Command palette).

interface Item {
  id: string
  group: string
  icon: ReactNode
  title: string
  sub?: ReactNode
  meta?: string
  run: () => void
}

function Snippet({ text }: { text: string }): ReactNode {
  return (
    <>
      {text.split(/[«»]/).map((part, j) =>
        j % 2 ? (
          <mark key={j} className="rounded-sm bg-fill-accent-highlight px-0.5 text-ink-accent-strong">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  )
}

export function SearchPalette(): ReactNode {
  const open = useUi((s) => s.searchOpen)
  const setOpen = useUi((s) => s.setSearch)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [active, setActive] = useState(0)
  const documents = useApp((s) => s.documents)

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
    }
  }, [open])

  useEffect(() => {
    let live = true
    const t = setTimeout(async () => {
      const res = q.trim() ? await call('search:query', q) : []
      if (live) {
        setHits(res)
        setActive(0)
      }
    }, 120)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q])

  const close = (): void => setOpen(false)
  const go = (path: string): void => {
    navigate(path)
    close()
  }

  const items: Item[] = useMemo(() => {
    if (q.trim())
      return hits.map((h) => ({ id: h.document_id, group: 'Notes', icon: <FileText />, title: h.title || 'Untitled', sub: <Snippet text={h.snippet} />, meta: dayLabel(h.created_at), run: () => go(`/note/${h.document_id}`) }))
    return [
      ...documents.slice(0, 6).map((d) => ({ id: d.id, group: 'Recent', icon: <FileText />, title: d.title || d.calendar_event?.title || 'Untitled', meta: dayLabel(d.created_at), run: () => go(`/note/${d.id}`) })),
      { id: 'new', group: 'Actions', icon: <SquarePen />, title: 'New note', meta: 'Ctrl N', run: () => (close(), void createNote()) },
      { id: 'chat', group: 'Actions', icon: <MessageCircle />, title: 'Chat with your meetings', run: () => go('/chat') },
      { id: 'assistant', group: 'Actions', icon: <Bot />, title: 'Open the Assistant', run: () => go('/assistant') },
      { id: 'templates', group: 'Actions', icon: <LayoutTemplate />, title: 'Templates', run: () => (close(), useUi.getState().openTemplates()) },
      { id: 'recipes', group: 'Actions', icon: <WandSparkles />, title: 'Recipes', run: () => go('/recipes') },
      { id: 'settings', group: 'Actions', icon: <Settings />, title: 'Settings', meta: 'Ctrl ,', run: () => go('/settings') }
    ]
  }, [q, hits, documents])

  return (
    <Base.Root open={open} onOpenChange={(o) => setOpen(o)}>
      <Base.Portal>
        <Base.Backdrop className="fixed inset-0 z-50 bg-black/10 transition-opacity duration-100 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Base.Popup className="fixed inset-x-0 top-[25vh] z-50 mx-auto max-w-lg px-4 outline-none transition-[opacity,scale] duration-100 ease-out data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 xl:max-w-xl">
          <div className="flex flex-col overflow-hidden rounded-xl bg-surface-elevated shadow-xl ring-[0.5px] ring-hairline select-none dark:ring-inset">
            <Base.Title className="sr-only">Search</Base.Title>
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActive((a) => Math.min(items.length - 1, a + 1))
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive((a) => Math.max(0, a - 1))
                }
                if (e.key === 'Enter' && items[active]) items[active].run()
              }}
              placeholder="Search notes, transcripts and enhanced notes…"
              className="h-12 w-full border-b-[0.5px] border-hairline bg-transparent px-4 text-sm text-ink-primary outline-none select-text placeholder:text-ink-tertiary"
            />
            <div className="max-h-85 overflow-y-auto p-2">
              {items.length === 0 && <div className="flex h-9 items-center justify-center px-2 text-sm text-ink-tertiary">{q.trim() ? 'No matching notes' : 'No notes yet'}</div>}
              {items.map((item, i) => (
                <div key={`${item.group}-${item.id}`}>
                  {item.group !== items[i - 1]?.group && <div className="flex h-8 items-center px-2 pt-1 text-xs font-medium text-ink-secondary">{item.group}</div>}
                  <button
                    type="button"
                    onMouseMove={() => setActive(i)}
                    onClick={item.run}
                    className={cn('flex min-h-9 w-full cursor-default items-center gap-3 rounded-lg px-2 py-2 text-left text-sm', i === active && 'bg-oats-off-black-a6 dark:bg-oats-off-white-a6')}
                  >
                    <span className="grid size-5 shrink-0 place-items-center text-ink-secondary [&_svg]:size-4">{item.icon}</span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-ink-primary">{item.title}</span>
                      {item.sub && <span className="mt-0.5 line-clamp-2 text-xs leading-[16px] text-ink-secondary">{item.sub}</span>}
                    </span>
                    {item.meta && <span className="max-w-[24ch] shrink-0 truncate text-xs text-ink-secondary">{item.meta}</span>}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  )
}
