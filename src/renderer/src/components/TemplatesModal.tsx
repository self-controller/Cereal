import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Copy, LayoutTemplate, Lock, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import { call, errorMessage } from '../lib/api'
import { useApp } from '../store'
import { Button, ConfirmDialog, Dialog, Field, IconButton, Input, Textarea, cn } from './oats'
import { useUi } from './shell/layout'
import type { Template, TemplateSection } from '@shared/types'

// Granola's "Note templates" dialog (docs/granola-ui.md §Templates modal): a resizable list on the left with
// "New template" and search, the template on the right, and "Apply template" when opened to pick one.

type Draft = { slug: string; title: string; description: string; sections: TemplateSection[] }

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `template-${Date.now().toString(36)}`
}

const LIST_MIN = 220
const LIST_MAX = 420

export function TemplatesModal(): ReactNode {
  const { open, slug: initialSlug, onApply } = useUi((s) => s.templates)
  const close = useUi((s) => s.closeTemplates)
  const templates = useApp((s) => s.templates)
  const refreshTemplates = useApp((s) => s.refreshTemplates)
  const showToast = useApp((s) => s.showToast)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [query, setQuery] = useState('')
  const [listWidth, setListWidth] = useState(280)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const drag = useRef<{ x: number; w: number } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setSelected(initialSlug ?? templates[0]?.slug ?? null)
    setDraft(null)
    setIsNew(false)
    setQuery('')
  }, [open])

  const current = templates.find((t) => t.slug === selected) ?? null
  useEffect(() => {
    if (current && !current.builtin) setDraft({ slug: current.slug, title: current.title, description: current.description, sections: current.sections })
    else if (!isNew) setDraft(null)
  }, [selected, templates])

  const visible = templates.filter((t) => !query.trim() || `${t.title} ${t.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  const firstBuiltin = visible.findIndex((t) => t.builtin)

  const startNew = (from?: Template): void => {
    setIsNew(true)
    setSelected(null)
    setDraft({
      slug: '',
      title: from ? `${from.title} (copy)` : 'New template',
      description: from?.description ?? '',
      sections: from?.sections.length ? from.sections.map((s) => ({ ...s })) : [{ heading: '', section_description: '' }]
    })
  }

  const save = async (): Promise<void> => {
    if (!draft) return
    try {
      const saved = await call('templates:upsert', { ...draft, slug: draft.slug || slugify(draft.title), sections: draft.sections.filter((s) => s.heading.trim()) })
      await refreshTemplates()
      setIsNew(false)
      setSelected(saved.slug)
      showToast('info', 'Template saved')
    } catch (e) {
      showToast('error', errorMessage(e))
    }
  }

  const setSection = (i: number, patch: Partial<TemplateSection>): void => setDraft((d) => d && { ...d, sections: d.sections.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const move = (i: number, dir: -1 | 1): void =>
    setDraft((d) => {
      if (!d) return d
      const s = [...d.sections]
      const j = i + dir
      if (j < 0 || j >= s.length) return d
      ;[s[i], s[j]] = [s[j], s[i]]
      return { ...d, sections: s }
    })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} initialFocus={searchRef} className="flex h-[85vh] max-h-[48rem] w-full max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
      <div className="shrink-0 border-b px-6 py-4">
        <h2 className="pr-6 text-lg font-medium text-ink-primary">Note templates</h2>
      </div>
      <div className="grid min-h-0 flex-1 items-stretch divide-x divide-hairline" style={{ gridTemplateColumns: `${listWidth}px minmax(0, 1fr)` }}>
        <div className="relative min-h-0">
          <ul className="flex h-full min-h-0 flex-col gap-px overflow-y-auto p-3 pb-8">
            <li>
              <button type="button" onClick={() => startNew()} className="mb-2 flex h-auto w-full cursor-default items-center gap-2 rounded-lg py-2 pl-2 font-medium hover:bg-fill-soft">
                <span className="grid size-9 place-items-center rounded-lg bg-fill-soft">
                  <Plus size={20} className="text-ink-secondary" />
                </span>
                <span className="text-sm text-ink-primary">New template</span>
              </button>
            </li>
            <li className="group mb-4 flex w-full items-center rounded-lg border border-transparent bg-highlight-faint pl-1.5 transition-colors duration-150 focus-within:border-hairline focus-within:bg-highlight hover:bg-highlight">
              <Search size={14} className="shrink-0 text-ink-secondary transition-colors duration-150 group-focus-within:text-ink-primary" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search templates..."
                className="min-w-0 flex-1 border-0 bg-transparent px-1.5 py-1.5 text-sm outline-none select-text placeholder:text-ink-tertiary"
              />
              {query.trim() && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="grid size-7 shrink-0 cursor-default place-items-center rounded-md text-ink-tertiary transition-colors duration-150 hover:text-ink-secondary">
                  <X size={14} />
                </button>
              )}
            </li>
            {visible.map((t, i) => (
              <li key={t.slug}>
                {firstBuiltin > 0 && i === firstBuiltin && <hr className="mx-2 my-3 border-0 border-t-[0.5px] border-hairline" />}
                <button
                  type="button"
                  onClick={() => {
                    setIsNew(false)
                    setSelected(t.slug)
                  }}
                  className={cn('flex w-full cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5 text-left', t.slug === selected && !isNew ? 'bg-fill-highlight' : 'hover:bg-fill-soft')}
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-fill-soft text-ink-secondary">{t.builtin ? <Lock size={14} /> : <LayoutTemplate size={14} />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink-primary">{t.title}</span>
                    {t.description && <span className="block truncate text-xs text-ink-secondary">{t.description}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div
            role="separator"
            aria-label="Resize template list"
            aria-orientation="vertical"
            className="group/resizer absolute top-0 z-10 flex h-full w-4 cursor-ew-resize items-center justify-center select-none"
            style={{ left: listWidth - 8 }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              drag.current = { x: e.clientX, w: listWidth }
            }}
            onPointerMove={(e) => drag.current && setListWidth(Math.max(LIST_MIN, Math.min(LIST_MAX, drag.current.w + e.clientX - drag.current.x)))}
            onPointerUp={() => (drag.current = null)}
          >
            <div className="h-full w-px rounded-full bg-ink-accent opacity-0 transition-opacity group-hover/resizer:opacity-100" />
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-xl px-8 py-6">
            {draft ? (
              <div className="flex flex-col gap-5">
                <Field label="Name">
                  <Input size="sm" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                </Field>
                <Field label="When to use it" hint="Describes the meeting type to the AI, e.g. “Weekly sync between a designer and an engineer”.">
                  <Input size="sm" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                </Field>
                <div>
                  <div className="mb-2 text-sm text-ink-primary">Sections</div>
                  <div className="flex flex-col gap-2.5">
                    {draft.sections.map((s, i) => (
                      <div key={i} className="rounded-xl bg-surface-elevated p-3 ring ring-hairline dark:ring-inset">
                        <div className="flex items-center gap-1">
                          <Input size="sm" className="font-medium" placeholder="Heading, e.g. Decisions" value={s.heading} onChange={(e) => setSection(i, { heading: e.target.value })} />
                          <IconButton size="sm" label="Move up" onClick={() => move(i, -1)}>
                            <ArrowUp size={14} />
                          </IconButton>
                          <IconButton size="sm" label="Move down" onClick={() => move(i, 1)}>
                            <ArrowDown size={14} />
                          </IconButton>
                          <IconButton size="sm" label="Remove section" onClick={() => setDraft({ ...draft, sections: draft.sections.filter((_, j) => j !== i) })}>
                            <X size={14} />
                          </IconButton>
                        </div>
                        <Textarea rows={2} size="sm" className="mt-2" placeholder="What should go in this section?" value={s.section_description} onChange={(e) => setSection(i, { section_description: e.target.value })} />
                      </div>
                    ))}
                  </div>
                  <Button size="sm" variant="ghost" className="mt-2" onClick={() => setDraft({ ...draft, sections: [...draft.sections, { heading: '', section_description: '' }] })}>
                    <Plus size={14} /> Add section
                  </Button>
                </div>
                <div className="flex items-center gap-2 border-t pt-5">
                  <Button onClick={() => void save()} disabled={!draft.title.trim()}>
                    Save template
                  </Button>
                  {!isNew && (
                    <Button variant="danger-outline" onClick={() => setConfirmDelete(true)}>
                      <Trash2 size={14} /> Delete
                    </Button>
                  )}
                </div>
              </div>
            ) : current ? (
              <div>
                <div className="flex items-start gap-3">
                  <h3 className="flex-1 text-h3 text-ink-primary">{current.title}</h3>
                  <Button size="sm" variant="soft" onClick={() => startNew(current)}>
                    <Copy size={14} /> Duplicate to edit
                  </Button>
                </div>
                {current.description && <p className="mt-2 mb-6 text-sm text-ink-secondary">{current.description}</p>}
                {current.sections.length === 0 ? (
                  <p className="flex items-center gap-2 rounded-xl bg-surface-elevated px-4 py-3 text-sm text-ink-secondary ring ring-hairline dark:ring-inset">
                    <Sparkles size={16} className="text-ink-accent" /> Headings are chosen automatically to fit each conversation.
                  </p>
                ) : (
                  <ol className="flex flex-col">
                    {current.sections.map((s, i) => (
                      <li key={i} className="py-2.5">
                        <div className="text-base font-semibold text-ink-primary">
                          <span className="mr-1.5 font-normal text-ink-tertiary">#</span>
                          {s.heading}
                        </div>
                        <div className="mt-0.5 text-sm text-ink-secondary">{s.section_description}</div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ) : (
              <p className="pt-20 text-center text-sm text-ink-tertiary">Choose a template, or make a new one.</p>
            )}
          </div>
        </div>
      </div>
      {onApply && current && !isNew && (
        <div className="flex items-center justify-end border-t px-4 py-3">
          <Button
            onClick={() => {
              onApply(current.slug)
              close()
            }}
          >
            Apply template
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this template?"
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (!draft) return
          await call('templates:delete', draft.slug)
          await refreshTemplates()
          setSelected(templates[0]?.slug ?? null)
        }}
      />
    </Dialog>
  )
}
