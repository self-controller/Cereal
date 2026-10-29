import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cn } from './cn'
import { createBarsRenderer, type BarsRenderer } from './barsRenderer'
import { barOffset, levelNormaliser } from '@shared/barLevels'

// Granola's "dancing bars" (docs/granola-ui.md §Dancing bars): three rounded bars, each drawn as a top half and a
// mirrored bottom half that slide out of a clipped box. Live bars are drawn by a WebGL canvas with motion blur
// (./barsRenderer.ts), over DOM bars that stay as the measuring template and as the fallback. Live bars only move
// for sound above the room's noise (src/shared/barLevels.ts), so they rest as dots until someone speaks.

const SILENT_MS = 3000
const DEAD = '#bd4a30'

// The idle glyph: short outer bars, tall middle bar.
const IDLE = [6, 2.5, 6]

export function DancingBars({
  level = 0,
  active,
  variant = 'default',
  className,
  color = 'var(--color-system-dancing-bars)'
}: {
  /** Latest RMS level, 0..1. */
  level?: number
  /** Live: bars follow the level. Otherwise the static glyph in tertiary ink. */
  active: boolean
  variant?: 'default' | 'nub'
  className?: string
  /** CSS colour of live bars. */
  color?: string
}): ReactNode {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const norm = useRef(levelNormaliser())
  const silentSince = useRef<number | null>(null)
  const barColor = useRef('')
  const root = useRef<HTMLSpanElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<BarsRenderer | null>(null)
  const offsets = useRef(IDLE)
  const [gl, setGl] = useState(false)
  const [glFailed, setGlFailed] = useState(false)
  const nub = variant === 'nub'

  // Live bars get a WebGL renderer; idle glyphs stay plain DOM so they don't hold GL contexts.
  useEffect(() => {
    if (!active || glFailed || !canvas.current || !root.current) return
    const r = createBarsRenderer(canvas.current, root.current, offsets.current, () => setGlFailed(true))
    if (!r) return setGlFailed(true)
    renderer.current = r
    setGl(true)
    return () => {
      r.dispose()
      renderer.current = null
      setGl(false)
    }
  }, [active, glFailed])

  useEffect(() => {
    const set = (next: number[]): void => {
      offsets.current = next
      if (renderer.current) return renderer.current.setTargets(next)
      bars.current.forEach((el, i) => el?.style.setProperty('transform', `translateY(${next[i % 3]}px)`))
    }
    if (!active) {
      silentSince.current = null
      barColor.current = ''
      return set(IDLE)
    }
    const v = norm.current(Math.max(0, level))
    // Nothing at all coming through for 3 s (a dead capture, not just quiet): turn the bars red.
    if (level === 0) silentSince.current ??= Date.now()
    else silentSince.current = null
    const dead = silentSince.current !== null && Date.now() - silentSince.current > SILENT_MS
    const nextColor = dead ? DEAD : color
    if (nextColor !== barColor.current) {
      barColor.current = nextColor
      root.current?.style.setProperty('--barcolor', nextColor)
      renderer.current?.refreshColor()
    }
    const steps = nub ? 7 : 10
    set([barOffset(v, 2, steps), barOffset(v, 1, steps), barOffset(v, 2, steps)])
  }, [level, active, nub, color, gl])

  const box = cn('flex justify-between overflow-hidden', nub ? 'h-[10px] w-[12px] gap-[3px]' : 'h-[10px] w-[13px] gap-[2px]', gl && 'opacity-0')
  const bar = cn('h-[16px] rounded-full bg-(--barcolor) transition-transform duration-300 ease-in-out', nub ? 'w-[2px]' : 'w-[3px]')
  return (
    <span
      ref={root}
      aria-hidden
      className={cn('relative inline-flex flex-col', className)}
      style={{ '--barcolor': active ? color : 'var(--color-ink-tertiary)' } as CSSProperties}
    >
      {[false, true].map((mirrored) => (
        <span key={String(mirrored)} className={cn(box, mirrored && '-scale-y-100')}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              ref={(el) => {
                bars.current[(mirrored ? 3 : 0) + i] = el
              }}
              className={bar}
              style={{ transform: `translateY(${IDLE[i]}px)` }}
            />
          ))}
        </span>
      ))}
      {active && !glFailed && <canvas ref={canvas} className={cn('pointer-events-none absolute top-0 left-0', !gl && 'hidden')} />}
    </span>
  )
}
