import { useEffect, useState, type ReactNode } from 'react'
import { Pencil, Plus, Trash2, WandSparkles } from 'lucide-react'
import { call, errorMessage } from '../lib/api'
import { useApp } from '../store'
import { Badge, Button, ConfirmDialog, Dialog, Field, IconButton, Input, Textarea, Tooltip } from '../components/oats'
import { ToolbarContent } from '../components/shell/Toolbar'
import type { Recipe } from '@shared/types'

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `recipe-${Date.now().toString(36)}`
}

type Edit = { id?: string; name: string; slug: string; prompt: string }

/** Recipes: saved prompts you can run from any chat bar with "/slug". */
export function RecipesView(): ReactNode {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [edit, setEdit] = useState<Edit | null>(null)
  const [deleting, setDeleting] = useState<Recipe | null>(null)
  const showToast = useApp((s) => s.showToast)
  const refresh = (): void => void call('recipes:list').then(setRecipes)
  useEffect(refresh, [])

  return (
    <div className="relative flex h-full min-h-0">
      <ToolbarContent>
        <div className="flex-1" />
        <Button variant="outline" className="pr-3 pl-1.5" onClick={() => setEdit({ name: '', slug: '', prompt: '' })}>
          <Plus size={16} className="text-ink-secondary" />
          New recipe
        </Button>
      </ToolbarContent>
      <div className="h-full min-w-0 flex-1 overflow-y-auto pt-11 pb-16">
        <div className="mx-auto w-full max-w-2xl px-6">
          <h1 className="mt-3 px-2 text-h3 text-ink-primary">Recipes</h1>
          <p className="mt-1 mb-6 px-2 text-sm text-ink-secondary">Saved prompts. Type “/” in any chat bar to run one.</p>
          <div className="flex flex-col">
            {recipes.map((r) => (
              <div key={r.id} className="group/recipe flex items-center rounded-xl py-[5px] pr-2 pl-2 hover:bg-highlight-faint">
                <span className="mr-4 grid size-7 shrink-0 place-items-center rounded-md bg-highlight text-ink-tertiary ring-[0.75px] ring-black/5 ring-inset dark:ring-white/5">
                  <WandSparkles size={16} />
                </span>
                <div className="mr-2 min-w-0 flex-1">
                  <div className="flex items-center gap-2 truncate text-base text-ink-primary">
                    {r.name}
                    <span className="text-sm text-ink-tertiary">/{r.slug}</span>
                    {r.builtin && <Badge>Built in</Badge>}
                  </div>
                  <div className="truncate text-xs text-ink-secondary">{r.prompt}</div>
                </div>
                {!r.builtin && (
                  <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/recipe:opacity-100 group-focus-within/recipe:opacity-100">
                    <Tooltip content="Edit">
                      <IconButton label="Edit recipe" onClick={() => setEdit({ id: r.id, name: r.name, slug: r.slug, prompt: r.prompt })}>
                        <Pencil size={16} />
                      </IconButton>
                    </Tooltip>
                    <Tooltip content="Delete">
                      <IconButton label="Delete recipe" onClick={() => setDeleting(r)}>
                        <Trash2 size={16} />
                      </IconButton>
                    </Tooltip>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <Dialog open={edit !== null} onOpenChange={(o) => !o && setEdit(null)} title={edit?.id ? 'Edit recipe' : 'New recipe'} className="sm:max-w-md">
        {edit && (
          <form
            className="flex flex-col gap-4"
            onSubmit={async (e) => {
              e.preventDefault()
              try {
                await call('recipes:upsert', { ...edit, slug: edit.slug || slugify(edit.name) })
                setEdit(null)
                refresh()
              } catch (err) {
                showToast('error', errorMessage(err))
              }
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name">
                <Input autoFocus size="sm" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </Field>
              <Field label="Command">
                <Input size="sm" placeholder={slugify(edit.name || 'my-recipe')} value={edit.slug} onChange={(e) => setEdit({ ...edit, slug: e.target.value })} />
              </Field>
            </div>
            <Field label="Prompt">
              <Textarea rows={4} size="sm" value={edit.prompt} onChange={(e) => setEdit({ ...edit, prompt: e.target.value })} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="soft" onClick={() => setEdit(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!edit.name.trim() || !edit.prompt.trim()}>
                Save recipe
              </Button>
            </div>
          </form>
        )}
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ''}”?`}
        confirmLabel="Delete"
        danger
        onConfirm={async () => {
          if (deleting) await call('recipes:delete', deleting.id)
          refresh()
        }}
      />
    </div>
  )
}
