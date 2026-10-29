import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react'
import { cn } from './cn'

// Granola's NestedButton: one pill holding several hit areas (e.g. "Generate notes | ▾" or the live
// transcription control). Each Action highlights its own Inner on hover.
type Variant = 'primary' | 'accent' | 'accent-soft' | 'soft' | 'ghost' | 'outline'

const ROOT: Record<Variant, string> = {
  primary: 'bg-fill-primary',
  accent: 'text-ink-primary-inverse-static bg-fill-accent',
  'accent-soft': 'bg-fill-accent-highlight text-ink-accent-strong',
  soft: 'bg-oats-off-black-a6 text-oats-neutral-800 dark:bg-oats-off-white-a6 dark:text-oats-neutral-50',
  ghost: 'text-ink-secondary',
  outline: 'border border-oats-off-black-a20 bg-transparent text-oats-neutral-800 dark:border-oats-off-white-a20 dark:text-oats-neutral-50'
}
const INNER: Record<Variant, string> = {
  primary: 'text-ink-primary-inverse group-hover/nested-button:bg-fill-highlight-strong-inverse',
  accent: 'text-ink-primary-inverse-static group-hover/nested-button:bg-fill-accent-hover',
  'accent-soft': 'text-ink-accent-strong group-hover/nested-button:bg-fill-accent-highlight-strong',
  soft: 'group-hover/nested-button:bg-oats-off-black-a12 dark:group-hover/nested-button:bg-oats-off-white-a15',
  ghost: 'group-hover/nested-button:bg-oats-off-black-a6 dark:group-hover/nested-button:bg-oats-off-white-a6',
  outline: 'group-hover/nested-button:bg-oats-off-black-a6 dark:group-hover/nested-button:bg-oats-off-white-a6'
}
const ACTION_SIZES = { sm: 'p-0.5 text-xs', md: 'p-[2px] text-sm', lg: 'p-[4px] text-base' }
const INNER_SIZES = { sm: 'gap-1 px-2 py-[2px]', md: 'h-6 gap-1 px-2', lg: 'gap-2 px-2.5 py-1.25' }

export const NestedButton = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { variant?: Variant }>(function NestedButton({ variant = 'primary', className, ...props }, ref) {
  return <div ref={ref} className={cn('inline-flex cursor-default items-stretch rounded-full ring-focus-ring outline-none no-drag', ROOT[variant], className)} {...props} />
})

export const NestedAction = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { size?: keyof typeof ACTION_SIZES }>(function NestedAction({ size = 'md', className, type = 'button', ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'group/nested-button inline-flex cursor-default items-center justify-center self-stretch outline-none first:rounded-l-full last:rounded-r-full [&:not(:first-child)]:pl-0.5 [&:not(:last-child)]:pr-0.5 disabled:pointer-events-none',
        ACTION_SIZES[size],
        className
      )}
      {...props}
    />
  )
})

export function NestedInner({ variant = 'primary', size = 'md', className, children }: { variant?: Variant; size?: keyof typeof INNER_SIZES; className?: string; children: ReactNode }): ReactNode {
  return <span className={cn('inline-flex items-center justify-center rounded-full font-book whitespace-nowrap select-none', INNER[variant], INNER_SIZES[size], className)}>{children}</span>
}
