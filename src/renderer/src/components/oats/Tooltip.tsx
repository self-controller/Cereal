import type { ReactElement, ReactNode } from 'react'
import { Tooltip as Base } from '@base-ui/react/tooltip'
import { cn } from './cn'

const POPUP =
  'bg-surface-tooltip text-ink-primary-inverse-static select-none rounded-lg px-2 py-1 text-xs ring-hairline ring-inset dark:ring origin-[var(--transform-origin)] transition-[transform,scale,opacity] duration-75 ease-out data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[instant]:duration-0'

/** App-wide tooltip timing (Base UI's 600 ms open delay, instant hand-off between neighbours). */
export function TooltipProvider({ children, delay }: { children: ReactNode; delay?: number }): ReactNode {
  return <Base.Provider delay={delay}>{children}</Base.Provider>
}

/**
 * A dark tooltip below (by default) its trigger, as Granola draws them. `children` must be a single element that
 * forwards refs and props, such as a Button.
 */
export function Tooltip({
  content,
  kbd,
  side = 'bottom',
  align = 'center',
  sideOffset = 6,
  delay,
  disabled,
  className,
  children
}: {
  content: ReactNode
  kbd?: ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  delay?: number
  disabled?: boolean
  className?: string
  children: ReactElement
}): ReactNode {
  if (disabled || content == null || content === '') return children
  return (
    <Base.Root disableHoverablePopup>
      <Base.Trigger render={children} delay={delay} />
      <Base.Portal>
        <Base.Positioner side={side} align={align} sideOffset={sideOffset} className="z-200 max-w-xs">
          <Base.Popup className={cn(POPUP, className)}>
            {content}
            {kbd && <TooltipKbd className="ml-1.5">{kbd}</TooltipKbd>}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  )
}

export function TooltipKbd({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return <kbd className={cn('font-[system-ui] text-ink-secondary-strong-inverse-static not-italic [word-spacing:-0.25ch]', className)}>{children}</kbd>
}

/** The platform's modifier key as Granola writes it in shortcut hints. */
export const MOD = 'Ctrl'
