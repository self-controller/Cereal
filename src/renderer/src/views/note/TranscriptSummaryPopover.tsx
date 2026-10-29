import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { matchQuote, parseSummary } from '@shared/transcriptSummary'
import { transcriptLabels } from '@shared/transcript'
import { useNoteSpeakers } from './SpeakersChip'
import { call, errorMessage, useEvent } from '../../lib/api'
import { timeLabel } from '../../lib/format'
import { Inline } from '../../components/Markdown'
import { Popover } from '../../components/oats'
import type { NoteMode, TranscriptChunk } from '@shared/types'

// "Transcript Summary" (docs/granola-findings.md §6): opened from a line of the enhanced notes, it streams a short
// explanation of where the line came from, with quotes from the transcript. A quote that can be found in the
// transcript is a button that opens the transcript at that point.

interface SummaryState {
  text: string
  done: boolean
  error: string | null
}

const EMPTY: SummaryState = { text: '', done: false, error: null }

export function TranscriptSummaryPopover({
  anchor,
  documentId,
  line,
  chunks,
  mode,
  recording,
  onClose,
  onOpenQuote
}: {
  anchor: Element
  documentId: string
  line: string
  chunks: TranscriptChunk[]
  mode: NoteMode
  /** This note is still being transcribed, so the notes may be behind the transcript. */
  recording: boolean
  onClose: () => void
  onOpenQuote: (chunkId: string) => void
}): ReactNode {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const [state, setState] = useState<SummaryState>(EMPTY)

  useEvent('transcript-summary:update', (u) => {
    if (u.requestId === requestId) setState({ text: u.text, done: u.done, error: u.error })
  })

  useEffect(() => {
    let live = true
    setState(EMPTY)
    call('transcript-summary:start', requestId, documentId, line).catch((e) => live && setState({ text: '', done: true, error: errorMessage(e) }))
    return () => {
      live = false
      void call('transcript-summary:cancel', requestId)
    }
  }, [requestId, documentId, line])

  const parsed = useMemo(() => parseSummary(state.text, !state.done), [state])
  const byId = useMemo(() => new Map(chunks.map((c) => [c.id, c])), [chunks])
  const matches = useMemo(() => parsed.parts.map((p) => (p.kind === 'quote' ? matchQuote(p.text, chunks) : null)), [parsed, chunks])
  const labels = transcriptLabels(mode)
  const speakers = useNoteSpeakers()?.view
  const nothing = parsed.noContext || (state.done && !state.error && parsed.parts.length === 0)

  return (
    <Popover
      open
      anchor={anchor}
      onOpenChange={(o) => !o && onClose()}
      side="bottom"
      align="end"
      sideOffset={5}
      className="max-h-[28rem] w-[32rem] max-w-xs overflow-y-auto p-4 sm:max-w-sm lg:max-w-lg"
    >
      <h3 data-testid="transcript-summary-header" className="text-xs font-semibold tracking-wide text-ink-secondary uppercase">
        Transcript Summary
      </h3>
      <div className="mt-2 flex flex-col gap-2">
        {state.error ? (
          <p className="text-sm text-ink-danger">
            {state.error}{' '}
            <button type="button" className="cursor-default text-ink-secondary underline hover:text-ink-primary" onClick={() => setRequestId(crypto.randomUUID())}>
              Try again
            </button>
          </p>
        ) : nothing ? (
          <p className="text-base leading-relaxed text-ink-secondary">No related discussion found in the transcript.</p>
        ) : parsed.parts.length === 0 ? (
          <div className="space-y-2.5 py-1 motion-safe:animate-pulse" aria-label="Loading">
            {[92, 78, 60].map((w) => (
              <div key={w} className="h-3 rounded bg-highlight" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : (
          parsed.parts.map((p, i) => {
            if (p.kind === 'text')
              return (
                <p key={i} className="text-base leading-relaxed text-ink-primary">
                  <Inline text={p.text} />
                </p>
              )
            const match = matches[i]
            const chunk = match ? byId.get(match.chunkIds[0]) : undefined
            return (
              <button
                key={i}
                type="button"
                data-testid="transcript-summary-quote"
                disabled={!chunk}
                onClick={() => chunk && onOpenQuote(chunk.id)}
                className="flex w-full cursor-default gap-2.5 rounded-lg py-1 pr-2 text-left enabled:hover:bg-highlight"
              >
                <span aria-hidden className="w-px shrink-0 self-stretch bg-ink-accent" />
                <span className="min-w-0">
                  <span className="block text-sm leading-snug text-ink-primary">“{p.text}”</span>
                  {chunk && (
                    <span className="mt-0.5 block text-xs text-ink-tertiary">
                      {speakers?.labelOf(chunk) ?? labels[chunk.source]} • {timeLabel(chunk.start_timestamp)}
                    </span>
                  )}
                </span>
              </button>
            )
          })
        )}
      </div>
      {recording && <p className="mt-3 text-xs leading-snug text-ink-tertiary">Still transcribing. These notes were written earlier, so newer discussion may be missing.</p>}
    </Popover>
  )
}
