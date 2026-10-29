import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { cn } from './cn'

export interface SegmentedTab<T extends string> {
  value: T
  label: string
  icon: ReactNode
  /** Tooltip while the tab is collapsed to its icon (defaults to the label). */
  tooltip?: ReactNode
  /** Show a chevron on the active tab, which then opens a menu (see `wrapActive`). */
  chevron?: boolean
}

// Granola's note tabs (My notes / Enhanced): a sunken pill in which inactive tabs collapse to their
// icon and the active tab expands to show its label, while a raised thumb slides under it (325 ms, ease-out-expo).
const ICON_W = 32
const LABEL_GAP = 4
const PAD_RIGHT = 10
const CHEVRON_W = 18

export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  wrapActive,
  className
}: {
  tabs: SegmentedTab<T>[]
  value: T
  onChange: (value: T) => void
  /** Wraps the active tab's button, e.g. in a menu trigger. */
  wrapActive?: (value: T, button: ReactElement) => ReactNode
  className?: string
}): ReactNode {
  const measure = useRef<HTMLSpanElement>(null)
  const [labelWidths, setLabelWidths] = useState<number[]>([])

  useLayoutEffect(() => {
    const read = (): void => {
      const spans = measure.current ? Array.from(measure.current.children) : []
      setLabelWidths(spans.map((s) => Math.ceil((s as HTMLElement).getBoundingClientRect().width)))
    }
    read()
    void document.fonts?.ready.then(read)
  }, [tabs.map((t) => t.label).join('\u0000')])

  const widths = tabs.map((t, i) => (t.value === value ? ICON_W - 8 + LABEL_GAP + (labelWidths[i] ?? 60) + PAD_RIGHT + (t.chevron ? CHEVRON_W : 0) : ICON_W))
  const index = Math.max(0, tabs.findIndex((t) => t.value === value))
  const left = widths.slice(0, index).reduce((a, b) => a + b, 0)
  const total = widths.reduce((a, b) => a + b, 0)

  return (
    <div
      role="tablist"
      className={cn(
        'group/tabs relative isolate z-10 h-8 shrink-0 overflow-hidden rounded-full bg-surface-sunken text-ink-secondary-strong ring ring-hairline ring-inset no-drag',
        'transition-[width] duration-[260ms] ease-out-expo',
        className
      )}
      style={{ width: total }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute top-[2px] left-0 z-[-1] h-[28px] rounded-full border border-[#d2cfc6] bg-surface-elevated transition-[transform,width] duration-[325ms] ease-out-expo dark:border-[#424242]"
        style={{ width: Math.max(0, widths[index] - 4), transform: `translateX(${left + 2}px)` }}
      />
      <div className="flex h-full">
        {tabs.map((t, i) => {
          const active = t.value === value
          const button = (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              aria-label={t.label}
              data-active={active ? '' : undefined}
              onClick={() => !active && onChange(t.value)}
              className="flex h-8 shrink-0 cursor-default items-center overflow-hidden rounded-full pl-2 text-ink-secondary outline-none transition-[width] duration-[260ms] ease-out-expo hover:text-ink-secondary-strong focus-visible:text-ink-primary data-[active]:text-ink-secondary-strong"
              style={{ width: widths[i] }}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">{t.icon}</span>
              <span
                className={cn('inline-block overflow-hidden text-sm leading-none whitespace-nowrap ease-out-expo', active ? 'ml-1 max-w-[100px] opacity-100' : 'ml-0 max-w-0 opacity-0')}
                style={
                  {
                    transitionProperty: 'max-width, width, opacity, margin-left',
                    transitionDuration: active ? '260ms, 260ms, 200ms, 260ms' : '260ms, 260ms, 48ms, 260ms',
                    transitionDelay: active ? '0ms, 0ms, 40ms, 0ms' : '0ms'
                  } as CSSProperties
                }
              >
                {t.label}
              </span>
              {active && t.chevron && (
                <span className="ml-0.5 flex size-3.5 shrink-0 items-center justify-center">
                  <ChevronDown size={14} />
                </span>
              )}
            </button>
          )
          return active ? (
            <span key={t.value} className="contents">
              {wrapActive ? wrapActive(t.value, button) : button}
            </span>
          ) : (
            <Tooltip key={t.value} content={t.tooltip ?? t.label} delay={300}>
              {button}
            </Tooltip>
          )
        })}
      </div>
      <span ref={measure} aria-hidden className="pointer-events-none absolute top-0 -left-[9999px] flex text-sm leading-none whitespace-nowrap">
        {tabs.map((t) => (
          <span key={t.value}>{t.label}</span>
        ))}
      </span>
    </div>
  )
}
