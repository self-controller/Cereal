import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { FileText, TextSelect, X } from 'lucide-react'
import { extensionOf, formatBytes, middleTruncate } from '@shared/attachments'
import type { ChatAttachment } from '@shared/types'
import { Dialog, Menu, MenuItem, Spinner, Tooltip, cn } from '../oats'
import { attachmentUrl, type DraftFile } from './useAttachments'

/** Something the bar (or a sent message) carries besides its text. */
export type ChipItem =
  | { type: 'file'; key: string; file: Pick<DraftFile, 'id' | 'name' | 'mime' | 'kind' | 'size' | 'status' | 'previewUrl'> }
  | { type: 'note'; key: string; id: string; title: string }
  | { type: 'selection'; key: string; text: string }

export function fileChip(f: DraftFile | ChatAttachment): ChipItem {
  const draft = 'key' in f
  return {
    type: 'file',
    key: draft ? f.key : `att-${f.id}`,
    file: { id: f.id, name: f.name, mime: f.mime, kind: f.kind, size: f.size, status: draft ? f.status : f.status, previewUrl: draft ? f.previewUrl : null }
  }
}

function FileGlyph({ name }: { name: string }): ReactNode {
  const ext = extensionOf(name).slice(0, 4).toUpperCase()
  return (
    <span className="relative flex h-4 w-[13px] shrink-0 items-end justify-center rounded-[3px] bg-oats-neutral-200 pb-px text-[6.5px] leading-none font-bold tracking-tight text-oats-neutral-700 ring-[0.5px] ring-black/10 dark:bg-oats-neutral-700 dark:text-oats-neutral-200">
      {ext}
    </span>
  )
}

function ChipIcon({ item }: { item: ChipItem }): ReactNode {
  if (item.type === 'note') return <FileText size={16} className="shrink-0 text-ink-tertiary" />
  if (item.type === 'selection') return <TextSelect size={16} className="shrink-0 text-ink-tertiary" />
  const f = item.file
  if (f.status === 'uploading' || f.status === 'processing') return <Spinner className="size-3.5 shrink-0 border-[1.5px]" />
  if (f.kind === 'image' && (f.previewUrl || f.id)) return <img src={f.previewUrl ?? attachmentUrl(f.id!)} alt="" className="size-4 shrink-0 rounded-[3px] object-cover" draggable={false} />
  return <FileGlyph name={f.name} />
}

function chipLabel(item: ChipItem): string {
  if (item.type === 'note') return item.title || 'New note'
  if (item.type === 'selection') return 'Selected text'
  return item.file.name
}

function Chip({ item, onRemove, onOpen, measuring }: { item: ChipItem; onRemove?: () => void; onOpen?: () => void; measuring?: boolean }): ReactNode {
  const label = chipLabel(item)
  return (
    <div
      className="inline-flex h-7 max-w-40 shrink-0 animate-chip-enter items-center gap-1 rounded-full pr-1 pl-2 text-sm text-ink-primary ring ring-black/15 ring-inset dark:ring-white/15"
      data-testid={measuring ? undefined : 'chat-chip'}
    >
      <button type="button" onClick={onOpen} disabled={!onOpen} className="flex min-w-0 cursor-default items-center gap-1.5 pr-1 disabled:cursor-default" title={label}>
        <ChipIcon item={item} />
        <span className="truncate">{middleTruncate(label)}</span>
      </button>
      {onRemove && (
        <Tooltip content="Remove" side="top">
          <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="flex size-5 shrink-0 cursor-default items-center justify-center rounded-full text-ink-tertiary hover:bg-highlight hover:text-ink-primary">
            <X size={12} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}

/**
 * Chips above the editor, or under a sent message (right-aligned). Chips that don't fit fold into a "+N" menu.
 * Clicking a file opens its preview; the selected-text chip shows the text.
 */
export function ChipRow({ items, onRemove, align = 'start', className }: { items: ChipItem[]; onRemove?: (item: ChipItem) => void; align?: 'start' | 'end'; className?: string }): ReactNode {
  const row = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(items.length)
  const [preview, setPreview] = useState<ChipItem | null>(null)

  useLayoutEffect(() => {
    const compute = (): void => {
      const width = row.current?.clientWidth ?? 0
      const chips = Array.from(measure.current?.children ?? []) as HTMLElement[]
      let used = 0
      let n = 0
      for (const [i, el] of chips.entries()) {
        // Room for the "+N" pill whenever something would be left over.
        const reserve = i < chips.length - 1 ? 44 : 0
        if (used + el.offsetWidth + (n ? 6 : 0) + reserve > width && n > 0) break
        used += el.offsetWidth + (n ? 6 : 0)
        n++
      }
      setFit(Math.max(1, n))
    }
    compute()
    const ro = new ResizeObserver(compute)
    if (row.current) ro.observe(row.current)
    return () => ro.disconnect()
  }, [items])

  if (!items.length) return null
  const shown = items.slice(0, fit)
  const rest = items.slice(fit)
  return (
    <>
      <div ref={row} className={cn('relative flex min-w-0 items-center gap-1.5', align === 'end' && 'justify-end', className)}>
        <div ref={measure} aria-hidden className="pointer-events-none invisible absolute flex gap-1.5">
          {items.map((item) => (
            <Chip key={item.key} item={item} measuring onRemove={onRemove ? () => undefined : undefined} />
          ))}
        </div>
        {shown.map((item) => (
          <Chip key={item.key} item={item} onRemove={onRemove ? () => onRemove(item) : undefined} onOpen={item.type === 'note' ? undefined : () => setPreview(item)} />
        ))}
        {rest.length > 0 && (
          <Menu
            side="top"
            align="end"
            trigger={
              <button type="button" className="flex h-7 shrink-0 cursor-default items-center rounded-full px-2.5 text-sm text-ink-secondary ring ring-black/15 ring-inset hover:text-ink-primary dark:ring-white/15">
                +{rest.length}
              </button>
            }
          >
            {rest.map((item) => (
              <MenuItem key={item.key} onClick={() => item.type !== 'note' && setPreview(item)}>
                <ChipIcon item={item} />
                <span className="min-w-0 flex-1 truncate">{chipLabel(item)}</span>
                {onRemove && (
                  <span
                    role="button"
                    aria-label={`Remove ${chipLabel(item)}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(item)
                    }}
                    className="flex size-5 items-center justify-center rounded-full text-ink-tertiary hover:text-ink-primary"
                  >
                    <X size={12} />
                  </span>
                )}
              </MenuItem>
            ))}
          </Menu>
        )}
      </div>
      <PreviewDialog item={preview} onClose={() => setPreview(null)} />
    </>
  )
}

/** The lightbox: images and PDFs shown in place, text files as text, the selected text as a quote. */
function PreviewDialog({ item, onClose }: { item: ChipItem | null; onClose: () => void }): ReactNode {
  const [text, setText] = useState<string | null>(null)
  const file = item?.type === 'file' ? item.file : null
  const url = file?.id ? attachmentUrl(file.id) : (file?.previewUrl ?? null)
  useEffect(() => {
    setText(null)
    if (!file?.id || file.kind !== 'text') return
    let live = true
    void fetch(attachmentUrl(file.id))
      .then((r) => r.text())
      .then((t) => live && setText(t.slice(0, 200_000)))
      .catch(() => live && setText('Couldn’t load this file.'))
    return () => {
      live = false
    }
  }, [file?.id, file?.kind])
  if (!item) return null
  const title = item.type === 'selection' ? 'Selected text' : item.type === 'file' ? item.file.name : item.title
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} className="h-[80vh] max-h-[48rem] grid-rows-[auto_1fr] sm:max-w-3xl" description={file ? `${formatBytes(file.size)}` : undefined}>
      <div className="min-h-0 overflow-hidden rounded-lg bg-surface-sunken">
        {item.type === 'selection' ? (
          <blockquote className="selectable h-full overflow-y-auto p-4 text-base leading-relaxed whitespace-pre-wrap text-ink-primary">{item.text}</blockquote>
        ) : file?.kind === 'image' && url ? (
          <img src={url} alt={file.name} className="h-full w-full object-contain" />
        ) : file?.kind === 'pdf' && url ? (
          <iframe src={url} title={file.name} className="h-full w-full bg-white" />
        ) : file?.kind === 'text' ? (
          <pre className="selectable h-full overflow-auto p-4 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-primary">{text ?? 'Loading…'}</pre>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-secondary">
            <FileText size={40} />
            <p>Preview isn’t available for this file type.</p>
          </div>
        )}
      </div>
    </Dialog>
  )
}
