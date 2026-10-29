import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, Copy, Search, X } from 'lucide-react'
import { findInChunks, formatTranscript, transcriptLabels } from '@shared/transcript'
import { IconButton, MOD, Tooltip, cn, motion } from '../../components/oats'
import { TranscriptView, type TranscriptFocus } from './TranscriptView'
import { useNoteSpeakers } from './SpeakersChip'
import type { NoteMode, TranscriptChunk } from '@shared/types'

// The transcript panel that the recording widget opens above the chat bar (docs/granola-ui.md §Transcript). Its header
// has no title: "Find in transcript" on the left, Copy and Close on the right; the border shows once the list scrolls.

export function TranscriptPanel({
  chunks,
  mode,
  live,
  starting,
  focus,
  onClose
}: {
  chunks: TranscriptChunk[]
  mode: NoteMode
  live: boolean
  starting: boolean
  focus: TranscriptFocus | null
  onClose: () => void
}): ReactNode {
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const [finding, setFinding] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [copied, setCopied] = useState(false)
  const matches = useMemo(() => (finding ? findInChunks(chunks, query) : []), [chunks, query, finding])
  const current = matches.length ? Math.min(active, matches.length - 1) : null
  const hasFinal = chunks.some((c) => c.is_final)
  const speakers = useNoteSpeakers()

  const openFind = (): void => {
    setFinding(true)
    requestAnimationFrame(() => input.current?.select())
  }
  const closeFind = (): void => {
    setFinding(false)
    setQuery('')
  }
  const step = (by: number): void => {
    if (matches.length) setActive(((current ?? 0) + by + matches.length) % matches.length)
  }

  // Ctrl+F finds while the panel is open; Escape closes the search first, then the panel.
  const keys = useRef({ finding, onClose })
  keys.current = { finding, onClose }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openFind()
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        if (keys.current.finding) closeFind()
        else keys.current.onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 3000)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <>
      <div className={cn('flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3 transition-colors', scrolled ? 'border-hairline' : 'border-transparent')}>
        <div className="flex min-w-0 items-center gap-1">
          <motion.div
            initial={false}
            animate={{ width: finding ? 220 : 28 }}
            transition={{ duration: 0.1 }}
            className={cn('flex h-7 shrink-0 items-center overflow-hidden rounded-full', finding && 'bg-highlight')}
          >
            {finding ? (
              <>
                <Search size={14} className="ml-2 shrink-0 text-ink-tertiary" />
                <input
                  ref={input}
                  value={query}
                  placeholder="Find"
                  aria-label="Find in transcript"
                  onChange={(e) => {
                    setQuery(e.target.value)
                    setActive(0)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      step(e.shiftKey ? -1 : 1)
                    }
                  }}
                  onBlur={() => !query && closeFind()}
                  className="min-w-0 flex-1 bg-transparent px-1.5 text-sm text-ink-primary outline-none placeholder:text-ink-tertiary"
                />
              </>
            ) : (
              <Tooltip content="Find in transcript" kbd={`${MOD} F`}>
                <IconButton size="sm" label="Find in transcript" onClick={openFind}>
                  <Search size={16} />
                </IconButton>
              </Tooltip>
            )}
          </motion.div>
          {finding && query.trim() && (
            <>
              <span className="shrink-0 px-1 text-xs text-ink-tertiary tabular-nums" data-testid="transcript-find-count">
                {current === null ? 'No results' : `${current + 1}/${matches.length}`}
              </span>
              <IconButton size="sm" label="Previous match" disabled={!matches.length} onClick={() => step(-1)}>
                <ChevronUp size={16} />
              </IconButton>
              <IconButton size="sm" label="Next match" disabled={!matches.length} onClick={() => step(1)}>
                <ChevronDown size={16} />
              </IconButton>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip content={copied ? 'Copied' : 'Copy transcript'}>
            <IconButton
              size="sm"
              label="Copy transcript"
              disabled={!hasFinal}
              onClick={() => {
                void navigator.clipboard.writeText(formatTranscript(chunks, { labels: transcriptLabels(mode), speakers: speakers?.view }))
                setCopied(true)
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </IconButton>
          </Tooltip>
          <Tooltip content="Close transcript">
            <IconButton size="sm" label="Close transcript" onClick={onClose}>
              <X size={16} />
            </IconButton>
          </Tooltip>
        </div>
      </div>
      <div ref={scroller} data-testid="transcript-scroller" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)} className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2">
        <TranscriptView chunks={chunks} mode={mode} live={live} starting={starting} scroller={scroller} matches={matches} activeMatch={current} focus={focus} />
      </div>
    </>
  )
}
