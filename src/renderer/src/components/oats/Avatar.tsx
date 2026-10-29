import type { CSSProperties, ReactNode } from 'react'
import { cn } from './cn'

// Granola's avatar tints: a pastel background with matching ink, one per person.
const TONES = [
  'bg-oats-neutral-300 text-ink-secondary-strong dark:bg-oats-neutral-700',
  'bg-oats-gold-100 text-oats-gold-400 dark:bg-oats-gold-400 dark:text-oats-gold-100',
  'bg-oats-yellow-100 text-oats-yellow-400 dark:bg-oats-yellow-400 dark:text-oats-yellow-100',
  'bg-oats-blue-100 text-oats-blue-400 dark:bg-oats-blue-400 dark:text-oats-blue-100',
  'bg-oats-purple-100 text-oats-purple-400 dark:bg-oats-purple-400 dark:text-oats-purple-100',
  'bg-oats-pink-100 text-oats-pink-400 dark:bg-oats-pink-400 dark:text-oats-pink-100'
]

export function Avatar({ name, size = 20, square, className }: { name: string; size?: number; square?: boolean; className?: string }): ReactNode {
  const tone = TONES[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 0) % TONES.length]
  const letter = name.replace(/@.*/, '').trim()[0]?.toUpperCase() ?? '?'
  return (
    <span
      title={name}
      style={{ '--size': `${size}px` } as CSSProperties}
      className={cn('relative grid size-(--size) shrink-0 place-items-center', square ? 'rounded-[5px]' : 'rounded-full', tone, className)}
    >
      <span className="font-display text-[calc(var(--size)*0.55)] leading-none uppercase select-none">{letter}</span>
      <span className="pointer-events-none absolute inset-0 rounded-[inherit] ring-[0.5px] ring-hairline ring-inset" />
    </span>
  )
}

/** Overlapping avatars, each ringed in the surface colour. */
export function AvatarStack({ names, size = 18, max = 4 }: { names: string[]; size?: number; max?: number }): ReactNode {
  return (
    <span className="flex -space-x-1.5">
      {names.slice(0, max).map((n) => (
        <Avatar key={n} name={n} size={size} className="ring-2 ring-surface" />
      ))}
    </span>
  )
}
