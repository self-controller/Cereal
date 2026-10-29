import { forwardRef, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion, useSpring, type HTMLMotionProps, type Transition } from 'motion/react'
import { easeInExpo, foldAwayDuration } from '@shared/motion'
import { buttonClass, type ButtonSize, type ButtonVariant } from './Button'
import { cn } from './cn'

// Motion configs observed in Granola (docs/granola-ui.md §Motion).
export const SPRING_0_3: Transition = { type: 'spring', bounce: 0, duration: 0.3 }
export const SPRING_0_25: Transition = { type: 'spring', bounce: 0, duration: 0.25 }
export const EASE_STANDARD = [0.4, 0, 0.2, 1] as const
export const EASE_OUT_EXPO = [0.16, 1, 0.3, 1] as const

const MORPH_LAYOUT: Transition = { type: 'spring', bounce: 0.15, duration: 0.25 }
const MORPH_CONTENT: Transition = { duration: 0.15, ease: 'easeOut' }
const OUTLINE_RINGS: Partial<Record<ButtonVariant, string>> = {
  outline: 'border-0 ring-1 ring-oats-off-black-a20 ring-inset dark:ring-oats-off-white-a20',
  'accent-outline': 'border-0 ring-1 ring-ink-accent-strong ring-inset',
  'danger-outline': 'border-0 ring-1 ring-oats-off-black-a20 ring-inset dark:ring-oats-off-white-a20'
}

type MorphProps = {
  /** Changing the key cross-fades the content (blur + opacity) while the pill springs to its new width. */
  contentKey: string
  variant?: ButtonVariant
  size?: ButtonSize
  layoutTransition?: Transition
  contentTransition?: Transition
  className?: string
  children: ReactNode
}

function MorphContent({ contentKey, size, contentTransition, children }: Pick<MorphProps, 'contentKey' | 'size' | 'contentTransition' | 'children'>): ReactNode {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={contentKey}
        layout="position"
        className={cn('flex items-center', size === 'sm' ? 'h-4 gap-1' : size === 'lg' ? 'h-5 gap-2' : 'h-4 gap-[5px]')}
        initial={{ opacity: 0, filter: 'blur(3px)' }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, filter: 'blur(3px)' }}
        transition={contentTransition ?? MORPH_CONTENT}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  )
}

function morphClass(variant: ButtonVariant, size: ButtonSize, className?: string): string {
  return cn(buttonClass(variant, size), OUTLINE_RINGS[variant], 'overflow-hidden', size === 'lg' && 'py-2', className)
}

/** Granola's MorphButton: a pill that springs to fit new content, which swaps with a blur cross-fade. */
export const MorphButton = forwardRef<HTMLButtonElement, MorphProps & Omit<HTMLMotionProps<'button'>, 'children'>>(function MorphButton(
  { contentKey, variant = 'primary', size = 'md', layoutTransition, contentTransition, className, children, style, ...props },
  ref
) {
  return (
    <motion.button ref={ref} type="button" layout transition={layoutTransition ?? MORPH_LAYOUT} className={morphClass(variant, size, className)} style={{ borderRadius: 9999, ...style }} {...props}>
      <MorphContent contentKey={contentKey} size={size} contentTransition={contentTransition}>
        {children}
      </MorphContent>
    </motion.button>
  )
})

/** The same morphing pill as a container, for content that holds its own buttons. */
export function MorphPill({ contentKey, variant = 'ghost', size = 'md', layoutTransition, contentTransition, className, children }: MorphProps): ReactNode {
  return (
    <motion.div layout transition={layoutTransition ?? MORPH_LAYOUT} className={morphClass(variant, size, cn('p-0', className))} style={{ borderRadius: 9999 }}>
      <MorphContent contentKey={contentKey} size={size} contentTransition={contentTransition}>
        {children}
      </MorphContent>
    </motion.div>
  )
}

const CHROME: Transition = { height: SPRING_0_3, y: SPRING_0_3, scale: SPRING_0_3, opacity: { duration: 0.15 } }

/**
 * An item in a page's top or bottom "chrome zone" (Generate notes pill, banners, feedback). It grows its slot
 * from zero height while the content rises from below (or drops from above) and scales up from 90%.
 */
export function ChromeItem({
  show,
  zone = 'bottom',
  entrance = 'slide',
  itemKey = 'item',
  className,
  children
}: {
  show: boolean
  zone?: 'top' | 'bottom'
  entrance?: 'slide' | 'fade'
  itemKey?: string
  className?: string
  children: ReactNode
}): ReactNode {
  const from = entrance === 'fade' ? { y: 8, scale: 0.98 } : { y: zone === 'top' ? 8 : '100%', scale: 0.9 }
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key={itemKey} className={cn('flex w-full flex-col items-center justify-end', className)} initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={CHROME}>
          <motion.div
            className="flex w-full flex-col items-center"
            style={{ originY: zone === 'top' ? 0 : 1 }}
            initial={{ opacity: 0, ...from }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, ...from }}
            transition={CHROME}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Fade + 6px rise used for the Generate notes pill and similar single calls to action. */
export function RiseIn({ show, itemKey = 'rise', className, children }: { show: boolean; itemKey?: string; className?: string; children: ReactNode }): ReactNode {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div key={itemKey} className={className} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.2, ease: EASE_STANDARD }}>
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const GROW = { visualDuration: 0.7, bounce: 0 }

/** A box whose height eases after its content as it grows (streamed notes), instead of jumping a line at a time. */
export function GrowHeight({ className, children }: { className?: string; children: ReactNode }): ReactNode {
  const inner = useRef<HTMLDivElement>(null)
  const height = useSpring(0, GROW)
  const reduced = useReducedMotion()
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    height.jump(el.offsetHeight)
    const ro = new ResizeObserver(() => (reduced ? height.jump(el.offsetHeight) : height.set(el.offsetHeight)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [height, reduced])
  return (
    <motion.div style={{ height }} className={cn('flex-none overflow-y-clip', className)}>
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </motion.div>
  )
}

const FOLD_DELAY = 1
const FOLD_CLOSE: Transition = { duration: 0.5, ease: 'easeInOut' }
type FoldPhase = 'hidden' | 'shown' | 'rising' | 'closing'

/**
 * Shows its children while `active`. When `active` turns false, the children wait a second, then rise by their own
 * height into the content above (clipped only below), fading and blurring as they go; then the space they held closes.
 * Children never shown while active stay hidden. With `fold` false (or reduced motion) they disappear at once.
 */
export function FoldAway({ active, fold = true, children }: { active: boolean; fold?: boolean; children: ReactNode }): ReactNode {
  const inner = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const [phase, setPhase] = useState<FoldPhase>(active ? 'shown' : 'hidden')
  const [rise, setRise] = useState(0)
  if (active && phase !== 'shown') setPhase('shown')

  useLayoutEffect(() => {
    if (active || phase !== 'shown') return
    const h = inner.current?.offsetHeight ?? 0
    if (!fold || reduced || h <= 0) {
      setPhase('hidden')
    } else {
      setRise(Math.min(h, window.innerHeight))
      setPhase('rising')
    }
  }, [active, phase, fold, reduced])

  if (phase === 'hidden') return null
  const leaving = phase !== 'shown'
  const duration = foldAwayDuration(rise, window.innerHeight)
  const fade = { duration, ease: easeInExpo, delay: FOLD_DELAY, times: [0, 0.5, 1] }
  return (
    <motion.div
      initial={false}
      animate={{ height: phase === 'closing' ? 0 : 'auto' }}
      transition={FOLD_CLOSE}
      onAnimationComplete={() => phase === 'closing' && setPhase('hidden')}
      className="[clip-path:inset(-2rem_-100vmax_0)]"
    >
      <motion.div
        ref={inner}
        initial={false}
        animate={leaving ? { y: -rise, opacity: [1, 1, 0], filter: ['blur(0px)', 'blur(0px)', 'blur(8px)'] } : { y: 0, opacity: 1, filter: 'blur(0px)' }}
        transition={leaving ? { y: { duration, ease: easeInExpo, delay: FOLD_DELAY }, opacity: fade, filter: fade } : { duration: 0 }}
        onAnimationComplete={() => phase === 'rising' && setPhase('closing')}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}

export { AnimatePresence, motion }
