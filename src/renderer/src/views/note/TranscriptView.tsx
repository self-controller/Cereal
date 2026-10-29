import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown } from 'lucide-react'
import { groupChunks, groupTurns, type TranscriptMatch } from '@shared/transcript'
import { timeLabel } from '../../lib/format'
import { AnimatePresence, cn, motion } from '../../components/oats'
import { JumpingDots } from '../../components/Chat'
import { SpeakerLabel, useNoteSpeakers } from './SpeakersChip'
import type { NoteMode, TranscriptChunk } from '@shared/types'

// The transcript in the note's bottom-bar panel, drawn like Granola's (docs/granola-ui.md §Transcript): the microphone
// on the right in the accent tint and system audio on the left, with no speaker labels unless the engine told voices
// apart (docs/notion-speakers.md): then a bubble from a new speaker carries their name, which opens "Who is this?". Mic
// echoes of the call audio are left out. A speaker's chunks share one bubble until a sentence ends, interim words sit
// inline at half opacity, and the live bubble ends in jumping dots.
// Neighbouring bubbles from one side get tighter inner corners. Each chunk is its own span (`data-chunk-id`), so
// "Find" can mark matches and the Transcript Summary can scroll to the words a quote came from.

/** How close to the bottom still counts as following the live transcript (Granola's threshold). */
const NEAR_BOTTOM = 48

function radius(you: boolean, prev: boolean, next: boolean): string {
  if (you) return prev && next ? 'rounded-r-md rounded-l-lg' : prev ? 'rounded-br-lg rounded-tr-md rounded-l-lg' : next ? 'rounded-tr-lg rounded-br-md rounded-l-lg' : 'rounded-lg'
  return prev && next ? 'rounded-l-md rounded-r-lg' : prev ? 'rounded-bl-lg rounded-tl-md rounded-r-lg' : next ? 'rounded-tl-lg rounded-bl-md rounded-r-lg' : 'rounded-lg'
}

const NO_MATCHES: TranscriptMatch[] = []
const NO_INDEXED: { index: number; start: number; end: number }[] = []

function LiveDots(): ReactNode {
  return <JumpingDots step={0.25} label="Listening" className="ml-1" />
}

/** Scroll to this chunk and flash it (a Transcript Summary quote). `nonce` repeats the request for the same chunk. */
export interface TranscriptFocus {
  chunkId: string
  nonce: number
}

/** A chunk's text, with "Find" matches marked. */
function ChunkText({ chunk, matches, active }: { chunk: TranscriptChunk; matches: { index: number; start: number; end: number }[]; active: number | null }): ReactNode {
  if (matches.length === 0) return chunk.text
  const parts: ReactNode[] = []
  let at = 0
  for (const m of matches) {
    if (m.start > at) parts.push(chunk.text.slice(at, m.start))
    parts.push(
      <mark key={m.index} data-match-index={m.index} className={cn('rounded-[3px] text-inherit', m.index === active ? 'bg-oats-yellow-200' : 'bg-oats-yellow-100 dark:bg-oats-yellow-400')}>
        {chunk.text.slice(m.start, m.end)}
      </mark>
    )
    at = m.end
  }
  if (at < chunk.text.length) parts.push(chunk.text.slice(at))
  return parts
}

export function TranscriptView({
  chunks,
  mode,
  live,
  starting = false,
  scroller,
  matches = NO_MATCHES,
  activeMatch = null,
  focus = null
}: {
  chunks: TranscriptChunk[]
  mode: NoteMode
  live: boolean
  starting?: boolean
  scroller: React.RefObject<HTMLDivElement | null>
  /** "Find" results, in transcript order. */
  matches?: TranscriptMatch[]
  /** The current "Find" result, scrolled into view. */
  activeMatch?: number | null
  focus?: TranscriptFocus | null
}): ReactNode {
  // Whether the view follows new text. The ref is what scrolling reads; the state only shows the "latest" pill.
  const stuck = useRef(true)
  const [stick, setStick] = useState(true)
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const lecture = mode === 'lecture'
  const view = useNoteSpeakers()?.view
  const labelOf = view?.attributed ? view.labelOf : undefined
  const visible = useMemo(() => (view?.echo.size ? chunks.filter((c) => !view.echo.has(c.id)) : chunks), [chunks, view])
  const groups = useMemo(() => groupChunks(visible, labelOf), [visible, labelOf])
  const hasContent = groups.length > 0
  const matchesByChunk = useMemo(() => {
    const map = new Map<string, { index: number; start: number; end: number }[]>()
    matches.forEach((m, index) => map.set(m.chunkId, [...(map.get(m.chunkId) ?? []), { index, start: m.start, end: m.end }]))
    return map
  }, [matches])

  // Scroll only the panel's scroller (scrollIntoView would also move its ancestors).
  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [scroller])

  /** Put an element a third of the way down the scroller, and stop following unless that is the bottom anyway. */
  const reveal = useCallback(
    (target: Element | null | undefined) => {
      const el = scroller.current
      if (!el || !target) return
      const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
      el.scrollTop = Math.max(0, top - el.clientHeight / 3)
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM
      stuck.current = atBottom
      setStick(atBottom)
    },
    [scroller]
  )

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = (): void => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM
      if (atBottom === stuck.current) return
      stuck.current = atBottom
      setStick(atBottom)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [scroller])

  useLayoutEffect(() => {
    if (stuck.current) toBottom()
  }, [chunks, toBottom])

  // Bubbles also change height after a render (corner and margin transitions, rewrapping on resize): keep following.
  useEffect(() => {
    const el = content.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      if (stuck.current) toBottom()
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [hasContent, toBottom])

  useEffect(() => {
    if (activeMatch === null) return
    reveal(content.current?.querySelector(`[data-match-index="${activeMatch}"]`))
  }, [activeMatch, matches, reveal])

  // The panel may still be growing when a quote opens it, so scroll again once it has settled.
  useEffect(() => {
    if (!focus) return
    const find = (): Element | null | undefined => content.current?.querySelector(`[data-chunk-id="${CSS.escape(focus.chunkId)}"]`)
    reveal(find())
    setHighlighted(focus.chunkId)
    const again = setTimeout(() => reveal(find()), 220)
    const clear = setTimeout(() => setHighlighted(null), 2000)
    return () => {
      clearTimeout(again)
      clearTimeout(clear)
    }
  }, [focus, reveal])

  if (!hasContent) {
    return (
      <div className="flex flex-col items-center px-6 py-16 text-center">
        <p className="text-xl text-ink-primary">{live ? 'Transcript on…' : starting ? 'Transcript starting…' : 'Transcript paused'}</p>
        {live && <p className="mt-1 text-sm text-ink-tertiary">Say something and it will show up here.</p>}
      </div>
    )
  }

  const chunkSpan = (c: TranscriptChunk, className?: string): ReactNode => (
    <span key={c.id} data-chunk-id={c.id} data-highlighted={highlighted === c.id || undefined} className={cn('rounded-[3px] transition-colors duration-300 data-[highlighted]:bg-oats-yellow-100 dark:data-[highlighted]:bg-oats-yellow-400', className)}>
      <ChunkText chunk={c} matches={matchesByChunk.get(c.id) ?? NO_INDEXED} active={activeMatch} />{' '}
    </span>
  )
  const byId = new Map(chunks.map((c) => [c.id, c]))
  const interim = lecture ? visible.filter((c) => !c.is_final && c.text.trim()) : []
  const sameSpeaker = (a: TranscriptChunk | undefined, b: TranscriptChunk): boolean => !!a && a.source === b.source && (!labelOf || labelOf(a) === labelOf(b))
  /** The speaker's name, when voices are told apart and this isn't the note-taker's own mic. */
  const nameTag = (c: TranscriptChunk, align: 'start' | 'end'): ReactNode => {
    const speaker = labelOf ? view?.speakerOf(c) : undefined
    return speaker && speaker.origin !== 'self' ? <SpeakerLabel speaker={speaker} align={align} /> : null
  }

  return (
    <div className="selectable relative w-full px-1">
      <div ref={content}>
        <p className="px-6 pt-1 pb-3 text-center text-xs text-ink-tertiary">Make sure everyone knows they are being transcribed.</p>
        {lecture ? (
          <div className="space-y-4 px-2">
            {groupTurns(
              visible.filter((c) => c.is_final),
              undefined,
              undefined,
              labelOf
            ).map((t) => (
              <div key={t.chunkIds[0]}>
                <span className="mb-0.5 flex items-center text-xs text-ink-tertiary tabular-nums">
                  {labelOf ? (
                    <>
                      {nameTag(byId.get(t.chunkIds[0])!, 'start')}
                      <span className="px-1">·</span>
                    </>
                  ) : (
                    t.source === 'system' && 'Them · '
                  )}
                  {timeLabel(t.start)}
                </span>
                <p className="text-base leading-relaxed text-ink-primary">{t.chunkIds.map((id) => byId.get(id)).map((c) => c && chunkSpan(c))}</p>
              </div>
            ))}
            {interim.length > 0 && (
              <p className="text-base leading-relaxed text-ink-primary">
                {interim.map((c) => chunkSpan(c, 'opacity-50'))}
                {live && <LiveDots />}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col">
            {groups.map((group, i) => {
              const first = group[0]
              const you = first.source === 'microphone'
              const prev = sameSpeaker(groups[i - 1]?.[0], first)
              const next = sameSpeaker(groups[i + 1]?.[0], first)
              return (
                <div
                  key={first.id}
                  className={cn('group/bubble relative mx-2 flex flex-col gap-1 py-px text-sm transition-all', you ? 'items-end self-end pl-16' : 'items-start self-start pr-16')}
                  style={{ marginTop: prev ? 0 : '0.25rem', marginBottom: next ? 0 : '0.25rem' }}
                >
                  {!prev && nameTag(first, you ? 'end' : 'start')}
                  <p
                    className={cn(
                      'relative max-w-full items-baseline gap-1 px-2 py-1.5 text-sm leading-snug transition-all',
                      radius(you, prev, next),
                      you ? 'bg-bubble-you text-bubble-you-ink' : 'bg-bubble-them text-ink-primary'
                    )}
                  >
                    {group.map((c) => chunkSpan(c, c.is_final ? undefined : 'opacity-50'))}
                    {live && group.some((c) => !c.is_final) && <LiveDots />}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {/* Zero height, so showing the pill never changes the content's height. */}
      <div className="pointer-events-none sticky bottom-3 z-20 flex h-0 justify-center">
        <AnimatePresence>
          {!stick && (
            <motion.button
              type="button"
              aria-label="Scroll to latest"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.1 }}
              onClick={toBottom}
              className="pointer-events-auto absolute bottom-0 grid h-8 w-12 cursor-default place-items-center rounded-full bg-oats-neutral-50/80 text-ink-primary shadow-lg ring-[0.5px] ring-hairline backdrop-blur-lg hover:bg-oats-neutral-200/80 dark:bg-oats-neutral-600/50 dark:ring-inset dark:hover:bg-oats-neutral-600/80"
            >
              <ArrowDown size={16} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
