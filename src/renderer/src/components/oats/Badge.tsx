import type { ReactNode } from 'react'
import { cn } from './cn'

const VARIANTS = {
  accent: 'bg-surface-tint-accent text-ink-secondary',
  blue: 'bg-surface-accent-blue text-ink-secondary',
  purple: 'bg-surface-accent-purple text-ink-secondary',
  neutral: 'bg-surface-tint-neutral text-ink-secondary',
  outline: 'bg-transparent text-ink-secondary ring-1 ring-border-strong ring-inset',
  yellow: 'bg-oats-yellow-50 text-oats-yellow-400 dark:bg-oats-yellow-400/15 dark:text-oats-yellow-100',
  danger: 'bg-fill-danger/15 text-ink-danger'
}
const SIZES = { '2xs': 'gap-0.5 px-1.5 text-2xs has-[>svg]:pl-1', xs: 'gap-1 px-2 py-0.5 text-xs has-[>svg]:pl-1.5' }

export function Badge({ variant = 'neutral', size = '2xs', className, children }: { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; className?: string; children: ReactNode }): ReactNode {
  return <span className={cn('inline-flex items-center rounded-full font-normal select-none', VARIANTS[variant], SIZES[size], className)}>{children}</span>
}
