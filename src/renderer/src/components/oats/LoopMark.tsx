import { useId, type ReactNode } from 'react'
import { cn } from './cn'

// Cereal's "thinking" mark: the three cereal rings from the app icon (build/icon.svg), drawn as pen strokes that
// unwind and redraw on a loop, with blurred blue echoes trailing behind on their own easing. The technique follows
// Granola's swirl (docs/granola-motion.md §The swirl); the shapes, colours and curves are Cereal's own.

const RINGS = [
  { cx: 190, cy: 214, r: 40 },
  { cx: 286, cy: 186, r: 40 },
  { cx: 352, cy: 236, r: 36 }
]
/** Each ring runs this many seconds behind the one before it, so the unwinding ripples from ring to ring. */
const RING_STEP = 0.14
/** Echo layers, painted from the back: deep blue on the strongest curve first, the palest closest to the ink. */
const ECHOES = [
  { color: 'text-loop-echo-3', curve: 'loop-mark-echo-3' },
  { color: 'text-loop-echo-2', curve: 'loop-mark-echo-2' },
  { color: 'text-loop-echo-1', curve: 'loop-mark-echo-1' }
]

/** A circle as one clockwise pen stroke that starts and ends at the top, so the dash draws like a hand-drawn O. */
function ringPath({ cx, cy, r }: (typeof RINGS)[number]): string {
  return `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r}`
}

function Rings({ className, strokeWidth }: { className: string; strokeWidth: number }): ReactNode {
  return RINGS.map((ring, i) => (
    <path key={i} d={ringPath(ring)} pathLength={1} strokeWidth={strokeWidth} strokeDasharray="1 0.75" className={className} style={{ animationDelay: `${i * RING_STEP}s` }} />
  ))
}

/** Sized by height (16px by default); the width follows the rings' 9:5 shape. The ink takes the text colour. */
export function LoopMark({ className, strokeWidth = 14 }: { className?: string; strokeWidth?: number }): ReactNode {
  const blur = `loop-blur-${useId().replace(/:/g, '')}`
  return (
    <svg viewBox="143 139 252 140" fill="none" aria-hidden className={cn('loop-mark h-4 w-auto shrink-0 overflow-visible', className)}>
      <defs>
        <filter id={blur} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation={6} />
        </filter>
      </defs>
      {ECHOES.map((echo) => (
        <g key={echo.curve} filter={`url(#${blur})`} className={cn('loop-mark-echo', echo.color)}>
          <Rings className={echo.curve} strokeWidth={strokeWidth} />
        </g>
      ))}
      <Rings className="loop-mark-ink" strokeWidth={strokeWidth} />
    </svg>
  )
}
