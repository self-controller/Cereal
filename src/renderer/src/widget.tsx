import { StrictMode, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { Wheat } from 'lucide-react'
import { useEvent } from './lib/api'
import { DancingBars, cn } from './components/oats'
import type { RecordingState } from '@shared/types'
import type { WidgetState } from '@shared/ipc'
import '@fontsource-variable/inter/opsz.css'
import './styles.css'

// Granola's "nub" (docs/granola-ui.md §Nub): a 34px dark pill at the screen edge while Cereal transcribes in the
// background, which turns into a small card asking to take notes when a meeting is detected. The window is
// sized to whatever the page draws.

const LAYOUT = { type: 'spring', duration: 0.3, bounce: 0.15 } as const
const SWAP = {
  initial: { y: -12, opacity: 0, scale: 0.9, filter: 'blur(3px)' },
  animate: { y: 0, opacity: 1, scale: 1, filter: 'blur(0px)' },
  exit: { y: 12, opacity: 0, scale: 0.9, filter: 'blur(3px)' },
  transition: { duration: 0.2, ease: 'easeInOut' }
} as const
const MARGIN = 8

function Widget(): ReactNode {
  const [state, setState] = useState<WidgetState>({ mode: 'recording', documentId: null })
  const [recording, setRecording] = useState<RecordingState | null>(null)
  const [levels, setLevels] = useState({ microphone: 0, system: 0 })
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.cereal.invoke('widget:state').then(setState)
    void window.cereal.invoke('recording:state').then(setRecording)
  }, [])
  useEvent('widget:state', setState)
  useEvent('recording:state', setRecording)
  useEvent('audio:levels', setLevels)

  // Fit the window to the pill or card (plus room for its shadow).
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const report = (): void => {
      // Layout size, not the transformed box mid-animation.
      void window.cereal.invoke('widget:resize', { width: el.offsetWidth + MARGIN * 2, height: el.offsetHeight + MARGIN * 2 })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const prompt = state.mode === 'prompt'
  const live = recording?.status === 'recording'
  const act = (action: 'start' | 'dismiss' | 'open'): void => void window.cereal.invoke('widget:action', action)

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex h-screen w-screen items-start justify-end" style={{ padding: MARGIN }}>
        <motion.div
          ref={root}
          layout
          transition={LAYOUT}
          data-testid="widget"
          style={{ borderRadius: prompt ? 14 : 17 }}
          className={cn(
            'drag grid justify-items-center overflow-hidden text-xs transition-[color,background-color,border-color,box-shadow] duration-300 ease-in-out contain-layout contain-paint',
            prompt
              ? 'w-max max-w-30 min-w-24 border border-white/20 bg-oats-yellow-300 p-1 text-white shadow-[0_1px_3px_0_rgba(0,0,0,0.35),0_0_3px_0_rgba(0,0,0,0.55),0_0_0_1px_rgba(0,0,0,0.70)] motion-safe:animate-nudge'
              : 'w-8.5 border border-oats-neutral-600/95 bg-[rgba(38,38,38,0.95)] p-0 text-white shadow-[0_2px_4px_-1px_rgba(0,0,0,0.7)] ring-[0.75px] ring-black/80'
          )}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {prompt ? (
              <motion.div key="prompt" layout="position" {...SWAP} className="grid w-full justify-items-center">
                <span className="grid h-7.5 w-8 place-items-center">
                  <Wheat size={16} className="opacity-80" />
                </span>
                <p title={state.title ?? undefined} className="mb-2 line-clamp-3 px-0.75 text-center break-words">
                  {state.title ?? `Meeting in ${state.app}`}
                </p>
                <div className="no-drag grid w-full gap-1">
                  <button type="button" onClick={() => act('start')} className="cursor-default rounded-full bg-oats-neutral-800 py-1 text-xs font-book text-white hover:bg-oats-neutral-700">
                    {state.title ? 'Take notes' : 'Start'}
                  </button>
                  <button type="button" onClick={() => act('dismiss')} className="cursor-default rounded-full bg-white/20 py-1 text-xs font-book text-white hover:bg-white/30">
                    Not now
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div key="pill" layout="position" {...SWAP} className="grid w-full justify-items-center">
                <button type="button" aria-label="Open Cereal" onClick={() => act('open')} className="no-drag grid h-7.5 w-8 cursor-default place-items-center rounded-full hover:bg-white/10">
                  <Wheat size={16} className="opacity-80" />
                </button>
                <span className="grid h-7.5 w-8 place-items-center" title={live ? 'Transcribing' : undefined}>
                  <DancingBars variant="nub" active={live} level={Math.max(levels.microphone, levels.system)} />
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </div>
    </MotionConfig>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Widget />
  </StrictMode>
)
