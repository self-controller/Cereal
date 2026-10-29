import type { ReactElement, ReactNode } from 'react'
import { Popover as Base } from '@base-ui/react/popover'
import { cn } from './cn'

const POPUP =
  'rounded-xl p-3 bg-surface-elevated shadow-lg outline-none ring-[0.5px] ring-hairline dark:ring-inset origin-[var(--transform-origin)] focus:outline-none transition-[transform,scale,opacity] duration-75 data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0'

export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  className,
  open,
  onOpenChange,
  anchor
}: {
  /** The button that toggles it; leave out for a controlled popover placed against `anchor`. */
  trigger?: ReactElement
  children: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  className?: string
  open?: boolean
  onOpenChange?: (open: boolean) => void
  anchor?: Element | null
}): ReactNode {
  return (
    <Base.Root open={open} onOpenChange={onOpenChange ? (o) => onOpenChange(o) : undefined}>
      {trigger && <Base.Trigger render={trigger} />}
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={sideOffset} anchor={anchor ?? undefined} className="z-50 outline-none">
          <Base.Popup className={cn(POPUP, className)}>{children}</Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}
