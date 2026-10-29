import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AudioLines, BrainCircuit, CircleAlert, FileJson, Sparkles } from 'lucide-react'
import { call, errorMessage } from '../../lib/api'
import { useApp } from '../../store'
import { Badge, Button, Select, cn } from '../../components/oats'
import { PROVIDER_MARKS, prettyModelName } from '@shared/models'
import { providerLabel, type UsageRange, type UsageSummary, type WhatIfRow } from '@shared/usage'
import type { LlmProviderId } from '@shared/types'
import { Group, Page, Row } from './layout'

// Settings → Usage: what Cereal's API use would cost, estimated from the tokens and audio minutes providers report
// and priced with src/shared/pricing.ts (plus the user's pricing.json).

const RANGES: { value: UsageRange; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All time' }
]

// Two categorical slots, validated together (CVD and contrast) against the card surface in each theme.
const LLM_FILL = 'fill-[#2a78d6] dark:fill-[#3987e5]'
const AUDIO_FILL = 'fill-[#eb6834] dark:fill-[#d95926]'
const LLM_SWATCH = 'bg-[#2a78d6] dark:bg-[#3987e5]'
const AUDIO_SWATCH = 'bg-[#eb6834] dark:bg-[#d95926]'

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const smallCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumSignificantDigits: 2 })
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
/** Axis ticks are exact (half of $0.03 is $0.015, not $0.02). */
const tickCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })

/** Dollars, with two significant digits below a cent so small costs don't all read "$0.00". */
export function usd(n: number): string {
  return n > 0 && n < 0.01 ? smallCurrency.format(n) : currency.format(n)
}

function minutesLabel(m: number): string {
  if (m < 1) return `${Math.round(m * 60)} sec`
  if (m < 60) return `${m.toFixed(m < 10 ? 1 : 0)} min`
  return `${(m / 60).toFixed(1)} hr`
}

/** A series key (`YYYY-MM-DD` or `YYYY-MM`) as a short local label. */
function bucketLabel(key: string, bucket: UsageSummary['bucket']): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d || 1)
  return bucket === 'day' ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

export function UsagePage(): ReactNode {
  const showToast = useApp((s) => s.showToast)
  const [range, setRange] = useState<UsageRange>('30d')
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    call('usage:summary', range)
      .then(setSummary)
      .catch((e) => showToast('error', errorMessage(e)))
      .finally(() => setLoading(false))
  }, [range, showToast])

  useEffect(() => {
    load()
    // Usage keeps accruing while the page is open in the background; catch up when the window comes back.
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])

  const empty = summary && summary.requests === 0 && summary.audioMinutes === 0
  return (
    <Page
      title="Usage"
      description="What Cereal’s API use would cost, estimated from the tokens and audio each provider reports."
      actions={<Select aria-label="Range" size="sm" value={range} onChange={setRange} options={RANGES} />}
    >
      {/* While a new range loads, the previous one stays up, dimmed. */}
      <div className={cn('transition-opacity', loading && summary && 'opacity-60')} data-testid="usage-page">
        {summary && (empty ? <EmptyState /> : <Overview summary={summary} />)}
        {summary && <PricesGroup summary={summary} />}
      </div>
    </Page>
  )
}

function EmptyState(): ReactNode {
  return (
    <Group>
      <Row
        icon={<Sparkles size={16} />}
        title="No usage recorded in this range"
        description="Enhanced notes, chat, the Assistant and transcription all count, from this version of Cereal on."
      />
    </Group>
  )
}

function Overview({ summary }: { summary: UsageSummary }): ReactNode {
  const rangeLabel = RANGES.find((r) => r.value === summary.range)?.label ?? ''
  return (
    <>
      <section className="mb-8 rounded-2xl bg-surface-elevated p-5 ring ring-hairline dark:ring-inset">
        <div className="text-sm text-ink-secondary">Estimated cost · {rangeLabel.toLowerCase()}</div>
        <div className="mt-1 text-[48px] leading-[52px] font-medium tracking-tight" data-testid="usage-total">
          {usd(summary.cost.total)}
        </div>
        {summary.unpriced.requests + summary.unpriced.minutes > 0 && (
          <div className="mt-1 flex items-center gap-1 text-xs text-ink-secondary">
            <CircleAlert size={13} /> Leaves out {summary.unpriced.requests ? `${summary.unpriced.requests} requests` : minutesLabel(summary.unpriced.minutes)} on models
            with no price. Add them in pricing.json.
          </div>
        )}
        <div className="mt-5 grid grid-cols-2 gap-4 @md:grid-cols-4">
          <Stat label="Language models" value={usd(summary.cost.llm)} />
          <Stat label="Transcription" value={usd(summary.cost.audio)} />
          <Stat label="This month so far" value={usd(summary.month.spent)} />
          <Stat label="Month at this pace" value={usd(summary.month.projected)} />
        </div>
        <CostBars summary={summary} />
      </section>
      <WhatIfGroup summary={summary} />
      {summary.models.length > 0 && <ModelsGroup summary={summary} />}
      {summary.audio.length > 0 && <AudioGroup summary={summary} />}
      <FeaturesGroup summary={summary} />
    </>
  )
}

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="truncate text-xs text-ink-secondary">{label}</div>
      <div className="text-base font-medium">{value}</div>
    </div>
  )
}

// --------------------------------------------------------------- the chart

const CHART_H = 148
const PAD = { top: 8, right: 4, bottom: 22, left: 48 }
const GAP = 2
const MAX_BAR = 24

/** The smallest of 1–8 × 10ⁿ at or above `n` whose half is also a clean value (the middle tick). */
function niceCeil(n: number): number {
  if (n <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(n))
  return [1, 2, 3, 4, 5, 6, 8, 10].map((f) => f * p).find((v) => v >= n * (1 - 1e-9))!
}

/** A bar's outline: 4px round at the data end, square at the baseline. */
function barPath(x: number, y: number, w: number, h: number, rounded: boolean): string {
  const r = rounded ? Math.min(4, w / 2, h) : 0
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

function CostBars({ summary }: { summary: UsageSummary }): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const { series, bucket } = summary
  if (summary.cost.total === 0) {
    return (
      <p className="mt-5 border-t border-hairline pt-4 text-sm text-ink-secondary">
        Everything in this range ran locally or on models without a price, so it cost nothing. See “What if” for what it would cost on a cloud model.
      </p>
    )
  }
  const max = niceCeil(Math.max(...series.map((s) => s.llm + s.audio)))
  const plotW = Math.max(0, width - PAD.left - PAD.right)
  const plotH = CHART_H - PAD.top - PAD.bottom
  const slot = series.length ? plotW / series.length : 0
  const barW = Math.max(1, Math.min(MAX_BAR, slot - GAP))
  const y = (v: number): number => PAD.top + plotH - (v / max) * plotH
  const ticks = [0, max / 2, max]
  const labelled = new Set([0, Math.floor((series.length - 1) / 2), series.length - 1])
  const point = hover === null ? null : series[hover]

  return (
    <div className="mt-5 border-t border-hairline pt-4">
      <div className="mb-2 flex items-center gap-4 text-xs text-ink-secondary">
        <span className="flex items-center gap-1.5">
          <span className={cn('size-2.5 rounded-[3px]', LLM_SWATCH)} /> Language models
        </span>
        <span className="flex items-center gap-1.5">
          <span className={cn('size-2.5 rounded-[3px]', AUDIO_SWATCH)} /> Transcription
        </span>
      </div>
      <div ref={box} className="relative" onPointerLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={CHART_H} role="img" aria-label={`Estimated cost per ${bucket}`} className="block overflow-visible">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="stroke-hairline" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-tertiary text-[11px] tabular-nums">
                  {tickCurrency.format(t)}
                </text>
              </g>
            ))}
            {series.map((s, i) => {
              const x = PAD.left + i * slot + (slot - barW) / 2
              const llmH = (s.llm / max) * plotH
              const audioH = (s.audio / max) * plotH
              // A 2px gap in the surface colour separates the stacked segments.
              const audioVisible = audioH > GAP
              return (
                <g
                  key={s.key}
                  tabIndex={0}
                  aria-label={`${bucketLabel(s.key, bucket)}: ${usd(s.llm + s.audio)}`}
                  onPointerEnter={() => setHover(i)}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover(null)}
                  className={cn('outline-none', hover === i && 'brightness-110')}
                >
                  {/* The hit target is the whole column, not just the painted bar. */}
                  <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent" />
                  {llmH > 0 && <path d={barPath(x, y(s.llm), barW, llmH, !audioVisible)} className={LLM_FILL} />}
                  {audioVisible && <path d={barPath(x, y(s.llm + s.audio), barW, audioH - (llmH > 0 ? GAP : 0), true)} className={AUDIO_FILL} />}
                  {labelled.has(i) && (
                    <text x={PAD.left + i * slot + slot / 2} y={CHART_H - 6} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'} className="fill-ink-tertiary text-[11px]">
                      {bucketLabel(s.key, bucket)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
        {point && hover !== null && (
          <div
            className="pointer-events-none absolute z-10 w-max -translate-x-1/2 rounded-lg bg-surface-elevated px-2.5 py-2 text-xs shadow-lg ring ring-hairline"
            style={{ left: Math.min(Math.max(PAD.left + hover * slot + slot / 2, 70), width - 70), bottom: CHART_H - PAD.top + 4 }}
          >
            <div className="mb-1 text-ink-secondary">{bucketLabel(point.key, bucket)}</div>
            <TooltipLine swatch={LLM_SWATCH} value={usd(point.llm)} label="Language models" />
            <TooltipLine swatch={AUDIO_SWATCH} value={usd(point.audio)} label="Transcription" />
          </div>
        )}
      </div>
      {/* The same numbers without hovering. */}
      <table className="sr-only">
        <caption>Estimated cost per {bucket}</caption>
        <thead>
          <tr>
            <th>{bucket === 'day' ? 'Day' : 'Month'}</th>
            <th>Language models</th>
            <th>Transcription</th>
          </tr>
        </thead>
        <tbody>
          {series.map((s) => (
            <tr key={s.key}>
              <td>{bucketLabel(s.key, bucket)}</td>
              <td>{usd(s.llm)}</td>
              <td>{usd(s.audio)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TooltipLine({ swatch, value, label }: { swatch: string; value: string; label: string }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className={cn('h-0.5 w-3 rounded-full', swatch)} />
      <span className="font-medium text-ink-primary tabular-nums">{value}</span>
      <span className="text-ink-secondary">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------- the lists

function ProviderMark({ provider }: { provider: string }): ReactNode {
  const mark = PROVIDER_MARKS[provider as LlmProviderId]
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-surface-tint-neutral text-[11px] font-medium text-ink-secondary">
      {mark ?? <AudioLines size={12} />}
    </span>
  )
}

function WhatIfList({ rows, current }: { rows: WhatIfRow[]; current: Set<string> }): ReactNode {
  return (
    <div className="flex flex-col px-4 pb-3">
      {rows.map((r) => (
        <div key={`${r.provider}/${r.model}`} className="flex items-center gap-2.5 py-1.5 text-sm">
          <ProviderMark provider={r.provider} />
          <span className="min-w-0 truncate">{r.label}</span>
          {current.has(`${r.provider}/${r.model}`) && <Badge>In use</Badge>}
          <span className="ml-auto text-ink-secondary tabular-nums">{usd(r.cost)}</span>
        </div>
      ))}
    </div>
  )
}

function WhatIfGroup({ summary }: { summary: UsageSummary }): ReactNode {
  const { llm, audio } = summary.whatIf
  if (!llm.length && !audio.length) return null
  const current = new Set([...summary.models.map((m) => `${m.provider}/${m.model}`), ...summary.audio.map((a) => `${a.provider}/${a.model}`)])
  return (
    <Group label="What if">
      {llm.length > 0 && (
        <div>
          <Row
            icon={<BrainCircuit size={16} />}
            title="The same requests on each model"
            description={`${summary.requests.toLocaleString()} requests, ${compact.format(summary.tokens)} tokens. Models count tokens differently, so these are estimates.`}
          />
          <WhatIfList rows={llm} current={current} />
        </div>
      )}
      {audio.length > 0 && (
        <div>
          <Row icon={<AudioLines size={16} />} title="The same audio on each engine" description={`${minutesLabel(summary.audioMinutes)} of audio, sent the way it was.`} />
          <WhatIfList rows={audio} current={current} />
        </div>
      )}
    </Group>
  )
}

function CostCell({ cost, local }: { cost: number | null; local: boolean }): ReactNode {
  if (local) return <span className="text-ink-secondary">Free</span>
  if (cost === null) return <span className="text-ink-secondary">No price</span>
  return <>{usd(cost)}</>
}

const TH = 'px-2 py-2 text-left text-xs font-book text-ink-secondary first:pl-4 last:pr-4'
const TD = 'px-2 py-2 first:pl-4 last:pr-4'

function ModelsGroup({ summary }: { summary: UsageSummary }): ReactNode {
  return (
    <Group label="By model">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={TH}>Model</th>
              <th className={cn(TH, 'text-right')}>Requests</th>
              <th className={cn(TH, 'text-right')}>Input</th>
              <th className={cn(TH, 'text-right')}>Cached</th>
              <th className={cn(TH, 'text-right')}>Output</th>
              <th className={cn(TH, 'text-right')}>Cost</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {summary.models.map((m) => (
              <tr key={`${m.provider}/${m.model}`} className="border-t border-hairline">
                <td className={TD}>
                  <span className="flex items-center gap-2.5">
                    <ProviderMark provider={m.provider} />
                    <span className="min-w-0 truncate">{m.label}</span>
                  </span>
                </td>
                <td className={cn(TD, 'text-right')}>{m.requests.toLocaleString()}</td>
                <td className={cn(TD, 'text-right')}>{compact.format(m.inputTokens)}</td>
                <td className={cn(TD, 'text-right')} title={`${m.cacheReadTokens.toLocaleString()} read, ${m.cacheWriteTokens.toLocaleString()} written`}>
                  {compact.format(m.cacheReadTokens + m.cacheWriteTokens)}
                </td>
                <td className={cn(TD, 'text-right')}>{compact.format(m.outputTokens)}</td>
                <td className={cn(TD, 'text-right')}>
                  <CostCell cost={m.cost} local={m.local} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Group>
  )
}

function AudioGroup({ summary }: { summary: UsageSummary }): ReactNode {
  return (
    <Group label="Transcription">
      {summary.audio.map((a) => (
        <Row
          key={`${a.provider}/${a.model}/${a.mode}`}
          icon={<AudioLines size={16} />}
          title={a.local ? `${a.label} (on this computer)` : a.label}
          description={`${minutesLabel(a.minutes)}, ${a.mode === 'streaming' ? 'live meetings' : 'dictation'}`}
        >
          <span className="text-sm tabular-nums">
            <CostCell cost={a.cost} local={a.local} />
          </span>
        </Row>
      ))}
    </Group>
  )
}

function FeaturesGroup({ summary }: { summary: UsageSummary }): ReactNode {
  return (
    <Group label="By feature">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className={TH}>Feature</th>
              <th className={cn(TH, 'text-right')}>Uses</th>
              <th className={cn(TH, 'text-right')}>Cost</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {summary.purposes.map((p) => (
              <tr key={p.purpose} className="border-t border-hairline">
                <td className={TD}>{p.label}</td>
                <td className={cn(TD, 'text-right')}>{p.requests.toLocaleString()}</td>
                <td className={cn(TD, 'text-right')}>{usd(p.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Group>
  )
}

// ----------------------------------------------------------------- prices

const rate = (n: number | undefined): string => (n === undefined ? '–' : tickCurrency.format(n))

/** A price table key as a name: the picker's label when Cereal knows the model, else provider and id. */
function priceName(key: string): string {
  const provider = key.slice(0, key.indexOf('/'))
  const model = key.slice(key.indexOf('/') + 1)
  const label = prettyModelName(model)
  return label !== model ? label : `${providerLabel(provider)} ${model}`
}

const RATE_TH = 'py-1 text-right font-book whitespace-nowrap pl-3'
const RATE_TD = 'py-1 text-right tabular-nums whitespace-nowrap pl-3'

function PricesGroup({ summary }: { summary: UsageSummary }): ReactNode {
  const showToast = useApp((s) => s.showToast)
  const { prices } = summary
  return (
    <Group label="Prices">
      <Row
        icon={<FileJson size={16} />}
        title={`Cereal’s price table, checked ${new Date(`${summary.pricesAsOf}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}`}
        description="Regular prices, not promotions. Your bill can differ with free tiers, credits and taxes. Change any price in pricing.json."
      >
        <Button size="sm" variant="soft" onClick={() => void call('usage:open-pricing').catch((e) => showToast('error', errorMessage(e)))}>
          Edit prices
        </Button>
      </Row>
      {summary.pricingErrors.length > 0 && (
        <div className="flex flex-col gap-1 px-4 py-3 text-xs text-ink-danger">
          {summary.pricingErrors.map((e) => (
            <span key={e} className="flex items-center gap-1">
              <CircleAlert size={13} /> {e}
            </span>
          ))}
        </div>
      )}
      <details className="group/prices px-4 py-3">
        <summary className="cursor-default text-sm text-ink-secondary">Show the rates</summary>
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-ink-secondary">
              <th className="py-1 text-left font-book">Per million tokens</th>
              <th className={RATE_TH}>Input</th>
              <th className={RATE_TH}>Output</th>
              <th className={RATE_TH}>Cache read</th>
              <th className={RATE_TH}>Cache write</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(prices.tokens).flatMap(([key, p]) => [
              <tr key={key} className="border-t border-hairline">
                <td className="py-1">{priceName(key)}</td>
                <td className={RATE_TD}>{rate(p.input)}</td>
                <td className={RATE_TD}>{rate(p.output)}</td>
                <td className={RATE_TD}>{rate(p.cacheRead)}</td>
                <td className={RATE_TD}>{rate(p.cacheWrite)}</td>
              </tr>,
              p.longContext && (
                <tr key={`${key}/long`} className="text-ink-secondary">
                  <td className="py-1 pl-3">Prompts over {compact.format(p.longContext.above)} tokens</td>
                  <td className={RATE_TD}>{rate(p.longContext.input)}</td>
                  <td className={RATE_TD}>{rate(p.longContext.output)}</td>
                  <td className={RATE_TD}>{rate(p.longContext.cacheRead)}</td>
                  <td className={RATE_TD}>{rate(p.longContext.cacheWrite)}</td>
                </tr>
              )
            ])}
          </tbody>
        </table>
        <table className="mt-4 w-full text-xs">
          <thead>
            <tr className="text-ink-secondary">
              <th className="py-1 text-left font-book">Per minute of audio</th>
              <th className={RATE_TH}>Streaming</th>
              <th className={RATE_TH}>Pre-recorded</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(prices.audio).flatMap(([key, p]) => [
              <tr key={key} className="border-t border-hairline">
                <td className="py-1">{priceName(key)}</td>
                <td className={RATE_TD}>{rate(p.streaming)}</td>
                <td className={RATE_TD}>{rate(p.prerecorded)}</td>
              </tr>,
              ...(
                [
                  ['Multilingual, instead', p.multilingual],
                  ['Speaker labels, added', p.diarization],
                  ['Keyterms, added', p.keyterms]
                ] as const
              ).flatMap(([label, r]) =>
                r
                  ? [
                      <tr key={`${key}/${label}`} className="text-ink-secondary">
                        <td className="py-1 pl-3">{label}</td>
                        <td className={RATE_TD}>{r.streaming ? rate(r.streaming) : 'Included'}</td>
                        <td className={RATE_TD}>{r.prerecorded ? rate(r.prerecorded) : 'Included'}</td>
                      </tr>
                    ]
                  : []
              )
            ])}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-ink-tertiary">Ollama and Whisper run on this computer and cost nothing.</p>
      </details>
    </Group>
  )
}
