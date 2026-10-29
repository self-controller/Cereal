import type { ReactNode } from 'react'
import { Select as Base } from '@base-ui/react/select'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from './cn'

const TRIGGER =
  'flex w-fit items-center justify-between gap-1.5 whitespace-nowrap outline-none select-none rounded-lg bg-surface-elevated px-2.5 text-sm text-ink-primary ring ring-hairline ring-inset transition-colors data-[placeholder]:text-ink-tertiary focus-visible:ring-1 focus-visible:ring-ink-accent data-[disabled]:cursor-not-allowed data-[disabled]:bg-surface-sunken data-[disabled]:text-ink-tertiary'
const SIZES = { sm: 'h-7', md: 'h-8', lg: 'h-9 text-base' }
const POPUP =
  'min-w-[max(180px,calc(var(--anchor-width)+0.25rem))] overflow-x-hidden overflow-y-auto rounded-xl p-1 bg-surface-elevated shadow-lg outline-none ring-[0.5px] ring-hairline dark:ring-inset focus:outline-none max-h-[var(--available-height)]'
const ITEM =
  'flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none select-none text-oats-neutral-800 dark:text-oats-neutral-50 data-[highlighted]:bg-oats-off-black-a6 dark:data-[highlighted]:bg-oats-off-white-a6 data-[disabled]:pointer-events-none data-[disabled]:opacity-40'

export interface SelectOption<T extends string> {
  value: T
  label: ReactNode
  hint?: ReactNode
}

/** A single-choice select (Base UI) with Granola's trigger and popup styling. */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  size = 'md',
  className,
  disabled,
  'aria-label': ariaLabel
}: {
  value: T | null
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: string
  size?: keyof typeof SIZES
  className?: string
  disabled?: boolean
  'aria-label'?: string
}): ReactNode {
  return (
    <Base.Root
      value={value}
      items={options.map((o) => ({ value: o.value, label: o.label }))}
      onValueChange={(v) => v !== null && onChange(v as T)}
      disabled={disabled}
    >
      <Base.Trigger aria-label={ariaLabel} className={cn(TRIGGER, SIZES[size], className)}>
        <Base.Value placeholder={placeholder} className="min-w-0 truncate" />
        <Base.Icon className="flex text-ink-tertiary">
          <ChevronsUpDown size={14} />
        </Base.Icon>
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner sideOffset={4} className="isolate z-50 outline-none">
          <Base.Popup className={POPUP}>
            <Base.List>
              {options.map((o) => (
                <Base.Item key={o.value} value={o.value} className={ITEM}>
                  <span className="min-w-0 flex-1">
                    <Base.ItemText className="block truncate">{o.label}</Base.ItemText>
                    {o.hint && <span className="block text-xs text-ink-secondary">{o.hint}</span>}
                  </span>
                  <Base.ItemIndicator className="ml-auto flex items-center justify-center text-ink-secondary">
                    <Check size={16} />
                  </Base.ItemIndicator>
                </Base.Item>
              ))}
            </Base.List>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
