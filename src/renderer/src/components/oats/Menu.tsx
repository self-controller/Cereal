import type { ReactElement, ReactNode } from 'react'
import { Menu as Base } from '@base-ui/react/menu'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from './cn'

const POPUP =
  'max-w-sm min-w-[220px] overflow-y-auto rounded-xl p-1 bg-surface-elevated shadow-lg outline-none ring-[0.5px] ring-hairline dark:ring-inset origin-[var(--transform-origin)] focus:outline-none transition-[transform,scale,opacity] duration-75 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0'
const SIZES = { sm: 'max-h-[24rem]', md: 'max-h-[32rem]', lg: 'max-h-[40rem]' }
const ITEM =
  'flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none select-none text-oats-neutral-800 dark:text-oats-neutral-50 data-[highlighted]:bg-oats-off-black-a6 dark:data-[highlighted]:bg-oats-off-white-a6 data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&>svg]:shrink-0 [&>svg]:text-ink-secondary'
const DANGER = 'text-oats-red-400 dark:text-oats-red-200 data-[highlighted]:bg-oats-red-50 dark:data-[highlighted]:bg-oats-red-400/15 [&>svg]:text-oats-red-400 dark:[&>svg]:text-oats-red-200'

/** A dropdown menu (Base UI) styled as Granola's MenuContent: starts aligned with the trigger, 4px below it. */
export function Menu({
  trigger,
  children,
  side = 'bottom',
  align = 'start',
  sideOffset = 4,
  size = 'md',
  className,
  open,
  onOpenChange
}: {
  trigger: ReactElement
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  size?: keyof typeof SIZES
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): ReactNode {
  return (
    <Base.Root open={open} onOpenChange={onOpenChange ? (o) => onOpenChange(o) : undefined}>
      <Base.Trigger render={trigger} />
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50 outline-none data-[side=right]:translate-x-[2px]">
          <Base.Popup className={cn(POPUP, SIZES[size], className)}>{children}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}

export function MenuItem({
  children,
  onClick,
  danger,
  disabled,
  closeOnClick,
  className
}: {
  children: ReactNode
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  closeOnClick?: boolean
  className?: string
}): ReactNode {
  return (
    <Base.Item onClick={onClick} disabled={disabled} closeOnClick={closeOnClick} className={cn(ITEM, danger && DANGER, className)}>
      {children}
    </Base.Item>
  )
}

/** An item with a trailing check when selected (single choice lists such as templates or modes). */
export function MenuCheckItem({ checked, onClick, children, disabled }: { checked: boolean; onClick?: () => void; children: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <Base.Item onClick={onClick} disabled={disabled} className={ITEM}>
      {children}
      <span className={cn('ml-auto flex items-center justify-center text-ink-secondary', !checked && 'invisible')}>
        <Check size={16} />
      </span>
    </Base.Item>
  )
}

export function MenuSeparator(): ReactNode {
  return <Base.Separator className="mx-2 my-1 h-[0.5px] bg-hairline" />
}

export function MenuLabel({ children }: { children: ReactNode }): ReactNode {
  return <div className="px-2 pt-1.5 pb-1 text-xs text-oats-neutral-500 select-none dark:text-oats-neutral-400">{children}</div>
}

/** A nested menu that opens to the side of its row. */
export function SubMenu({ label, children }: { label: ReactNode; children: ReactNode }): ReactNode {
  return (
    <Base.SubmenuRoot>
      <Base.SubmenuTrigger className={ITEM}>
        {label}
        <ChevronRight size={16} className="ml-auto text-ink-secondary" />
      </Base.SubmenuTrigger>
      <Base.Portal>
        <Base.Positioner side="right" align="start" sideOffset={4} className="z-50 outline-none">
          <Base.Popup className={cn(POPUP, SIZES.md)}>{children}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.SubmenuRoot>
  )
}
