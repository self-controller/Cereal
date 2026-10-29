import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'

export type ButtonVariant = 'primary' | 'accent' | 'accent-soft' | 'accent-outline' | 'soft' | 'soft-opaque' | 'surface' | 'outline' | 'danger' | 'danger-outline' | 'ghost'
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

// Pill buttons, after Granola's oats Button (docs/granola-ui.md §Button). Hover states switch instantly:
// the oats button has no colour transition.
const BASE = 'inline-flex items-center justify-center rounded-full font-book whitespace-nowrap cursor-default ring-focus-ring outline-none no-drag select-none disabled:pointer-events-none'

const SIZES: Record<ButtonSize, string> = {
  xs: 'py-1 gap-0.5 px-1.5 text-xs',
  sm: 'py-1 gap-0.5 px-2.5 text-xs',
  md: 'h-7 gap-[3px] px-3 text-sm',
  lg: 'py-[9px] gap-1 px-4 text-base'
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'text-ink-primary-inverse bg-fill-primary hover:bg-fill-primary-hover data-popup-open:bg-fill-primary-hover disabled:bg-fill-disabled disabled:text-ink-secondary',
  accent: 'text-ink-primary-inverse-static bg-fill-accent hover:bg-fill-accent-hover data-popup-open:bg-fill-accent-hover disabled:bg-fill-disabled disabled:text-ink-secondary',
  'accent-soft':
    'bg-fill-accent-highlight text-ink-accent-strong hover:bg-fill-accent-highlight-strong data-popup-open:bg-fill-accent-highlight-strong disabled:text-ink-accent-strong/50',
  'accent-outline': 'border border-ink-accent-strong bg-transparent text-ink-accent-strong hover:bg-fill-accent-highlight data-popup-open:bg-fill-accent-highlight disabled:opacity-70',
  soft: 'bg-fill-soft text-ink-primary hover:bg-fill-soft-hover data-popup-open:bg-fill-soft-hover disabled:text-ink-secondary',
  'soft-opaque': 'bg-fill-soft-opaque text-ink-primary hover:bg-fill-soft-opaque-hover data-popup-open:bg-fill-soft-opaque-hover disabled:text-ink-secondary',
  surface: 'bg-surface text-ink-primary ring ring-hairline dark:ring-inset hover:bg-surface-sunken data-popup-open:bg-surface-sunken disabled:text-ink-secondary',
  outline:
    'border border-oats-off-black-a20 bg-transparent text-oats-neutral-800 dark:border-oats-off-white-a20 dark:text-oats-neutral-50 hover:bg-oats-off-black-a6 dark:hover:bg-oats-off-white-a6 data-popup-open:bg-oats-off-black-a6 dark:data-popup-open:bg-oats-off-white-a6 disabled:text-ink-secondary dark:disabled:text-oats-neutral-500',
  danger: 'bg-fill-danger text-ink-primary-inverse-static hover:bg-fill-danger-hover data-popup-open:bg-fill-danger-hover disabled:bg-fill-disabled disabled:text-ink-secondary',
  'danger-outline':
    'border border-oats-off-black-a20 bg-transparent text-ink-danger dark:border-oats-off-white-a20 hover:bg-oats-off-black-a6 dark:hover:bg-oats-off-white-a6 data-popup-open:bg-oats-off-black-a6 dark:data-popup-open:bg-oats-off-white-a6 disabled:text-ink-secondary',
  ghost:
    'bg-transparent text-ink-secondary hover:bg-oats-off-black-a6 dark:hover:bg-oats-off-white-a6 data-popup-open:bg-oats-off-black-a6 dark:data-popup-open:bg-oats-off-white-a6 disabled:text-ink-tertiary disabled:opacity-65'
}

/** The class string for a button look, for elements rendered by other components (menu triggers, links). */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md', className?: string): string {
  return cn(BASE, SIZES[size], VARIANTS[variant], className)
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'primary', size = 'md', className, type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} className={buttonClass(variant, size, className)} {...props} />
})

const ICON_SIZES: Record<ButtonSize, string> = { xs: 'size-4', sm: 'size-6', md: 'size-7', lg: 'size-9' }

/** A square icon-only button. Its label doubles as the tooltip-less accessible name. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton({ variant = 'ghost', size = 'md', label, className, type = 'button', ...props }, ref) {
  return <button ref={ref} type={type} aria-label={label} className={buttonClass(variant, size, cn('gap-0 p-0', ICON_SIZES[size], className))} {...props} />
})

/** Granola's Button.Busy: a small spinner and status text while an action runs. */
export function Busy({ busy, text, children }: { busy: boolean; text?: ReactNode; children: ReactNode }): ReactNode {
  if (!busy) return <>{children}</>
  return (
    <span className="flex items-center" role="status">
      <span aria-hidden className="mr-1.5 box-border size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-b-transparent" />
      {text ?? children}
    </span>
  )
}

export function Spinner({ className }: { className?: string }): ReactNode {
  return <span aria-hidden className={cn('box-border inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-b-transparent', className)} />
}

/** Keyboard shortcut chip, e.g. inside a tooltip ("Ctrl K"). */
export function Kbd({ children, inverted, className }: { children: ReactNode; inverted?: boolean; className?: string }): ReactNode {
  return (
    <kbd
      className={cn(
        'min-w-4 rounded px-0.5 text-center font-[system-ui] text-xs font-medium not-italic select-none',
        inverted ? 'bg-fill-highlight-strong-inverse text-ink-secondary-inverse-static' : 'bg-fill-highlight-strong text-ink-secondary',
        className
      )}
    >
      {children}
    </kbd>
  )
}
