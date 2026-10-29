import type { ReactNode } from 'react'
import { ChevronUp, Mic, Square } from 'lucide-react'
import { useApp } from '../../store'
import { DancingBars, Spinner, Tooltip, cn } from '../../components/oats'

// Granola's recording widget (docs/granola-ui.md §Recording widget): a pill on the left of the chat input. Its main
// segment (bars and a chevron) shows or hides the transcript, which opens above it in the same card; the trailing
// segment stops, resumes or starts transcribing. There's no pause: Stop then Resume is the pause.

const SEGMENT = 'flex h-full cursor-default items-center outline-none transition-colors hover:bg-highlight focus-visible:bg-highlight disabled:pointer-events-none disabled:opacity-50'

function LiveBars(): ReactNode {
  const level = useApp((s) => Math.max(s.levels.microphone, s.levels.system))
  return <DancingBars active level={level} />
}

export function RecordingWidget({
  live,
  starting,
  hasTranscript,
  busyElsewhere,
  open,
  merged,
  onToggle,
  onStart,
  onStop
}: {
  live: boolean
  starting: boolean
  hasTranscript: boolean
  /** Another note is being transcribed, so this one can't start. */
  busyElsewhere: boolean
  /** The transcript is showing. */
  open: boolean
  /** Inside the open card, so it drops its own ring and shadow and spans the card. */
  merged: boolean
  onToggle: () => void
  onStart: () => void
  onStop: () => void
}): ReactNode {
  const startLabel = hasTranscript ? 'Resume' : 'Start now'
  return (
    <div
      data-testid="recording-widget"
      className={cn('pointer-events-auto relative shrink-0 rounded-[28px] bg-surface-elevated', merged ? 'w-full' : 'shadow-bottom-bar ring-[0.5px] ring-hairline dark:ring-inset')}
    >
      <div className="relative flex h-14 items-center p-1 text-sm">
        <Tooltip content={open ? 'Hide transcript' : 'Show transcript'} delay={300}>
          <button
            type="button"
            data-testid={open ? 'hide-transcript-button' : 'show-transcript-button'}
            aria-label={open ? 'Hide transcript' : 'Show transcript'}
            aria-expanded={open}
            // Keep the editor's focus and selection.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onToggle}
            className={cn(SEGMENT, 'min-w-[48px] justify-center gap-1.5 rounded-l-3xl rounded-r-lg pr-2.5 pl-4 text-ink-secondary')}
          >
            {starting ? <Spinner className="size-3 border-[1.5px] text-ink-accent" /> : live ? <LiveBars /> : hasTranscript ? <DancingBars active={false} /> : <Mic size={16} />}
            <ChevronUp size={16} className={cn('text-ink-tertiary transition-transform duration-200', open && 'rotate-180')} />
          </button>
        </Tooltip>
        {live ? (
          <Tooltip content="Stop transcript" delay={300}>
            <button
              type="button"
              data-testid="stop-transcript-button"
              aria-label="Stop transcribing"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onStop}
              className={cn(SEGMENT, 'w-12 justify-center rounded-l-lg rounded-r-3xl text-ink-primary')}
            >
              <Square size={12} fill="currentColor" className="rounded-[2px]" />
            </button>
          </Tooltip>
        ) : (
          !starting && (
            <Tooltip content={busyElsewhere ? 'Another note is being transcribed' : hasTranscript ? 'Resume transcribing' : 'Start transcribing'} delay={300}>
              <button
                type="button"
                data-testid={hasTranscript ? 'resume-transcript-button' : 'start-transcript-button'}
                disabled={busyElsewhere}
                onMouseDown={(e) => e.preventDefault()}
                onClick={onStart}
                className={cn(SEGMENT, 'rounded-l-lg rounded-r-3xl pr-4 pl-2.5 font-medium whitespace-nowrap text-ink-accent')}
              >
                {startLabel}
              </button>
            </Tooltip>
          )
        )}
      </div>
    </div>
  )
}
