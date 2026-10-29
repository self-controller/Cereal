// API usage and what it costs (Settings → Usage). Main records one event per model request or stretch of transcribed
// audio; these pure functions price them with the table in ./pricing and roll them up for the page.
import { CURATED_MODELS, PROVIDER_LABELS, prettyModelName } from './models'
import { PRICES_AS_OF, audioCost, audioPrice, isLocalProvider, tokenCost, tokenPrice, type PriceTable, type TokenCounts } from './pricing'
import type { LlmProviderId } from './types'

export type UsagePurpose =
  | 'enhance'
  | 'condense'
  | 'note-title'
  | 'transcript-summary'
  | 'chat'
  | 'chat-title'
  | 'assistant'
  | 'compaction'
  | 'connection-test'
  | 'transcription'
  | 'dictation'

export const PURPOSE_LABELS: Record<UsagePurpose, string> = {
  enhance: 'Enhanced notes',
  condense: 'Condensing long transcripts',
  'note-title': 'Note titles',
  'transcript-summary': 'Transcript summaries',
  chat: 'Chat',
  'chat-title': 'Chat titles',
  assistant: 'Assistant',
  compaction: 'Summarizing long conversations',
  'connection-test': 'Connection tests',
  transcription: 'Meeting transcription',
  dictation: 'Dictation'
}

export type AudioMode = 'streaming' | 'prerecorded'

/** One model request (kind 'llm') or one stretch of transcribed audio (kind 'audio'). */
export interface UsageEvent {
  id: number
  created_at: string
  kind: 'llm' | 'audio'
  /** An LLM provider id, or a transcription engine ('deepgram', 'whisper'). */
  provider: string
  model: string
  purpose: UsagePurpose
  /** Uncached input. */
  input_tokens: number
  /** Reasoning included. */
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  audio_seconds: number
  audio_mode: AudioMode | null
  multilingual: boolean
  diarized: boolean
  keyterms: boolean
  document_id: string | null
  thread_id: string | null
  run_id: string | null
}

export type NewUsageEvent = Pick<UsageEvent, 'kind' | 'provider' | 'model' | 'purpose'> & Partial<Omit<UsageEvent, 'id' | 'kind' | 'provider' | 'model' | 'purpose'>>

export type UsageRange = '7d' | '30d' | 'month' | 'all'

export interface UsageModelRow {
  provider: string
  model: string
  label: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Null when the model has no known price. */
  cost: number | null
  local: boolean
}

export interface UsageAudioRow {
  provider: string
  model: string
  label: string
  mode: AudioMode
  minutes: number
  cost: number | null
  local: boolean
}

export interface WhatIfRow {
  provider: string
  model: string
  label: string
  cost: number
}

export interface UsageSummary {
  range: UsageRange
  /** Start of the range (local midnight), or null for all time. */
  from: string | null
  pricesAsOf: string
  /** The prices used: Cereal's table with pricing.json on top. */
  prices: PriceTable
  /** Problems found in pricing.json. */
  pricingErrors: string[]
  cost: { total: number; llm: number; audio: number }
  /** Usage left out of `cost` because its model has no price. */
  unpriced: { requests: number; minutes: number }
  /** This calendar month so far, and that pace kept up for the whole month. */
  month: { spent: number; projected: number }
  /** Days for short ranges; months when all time spans more than about two months. */
  bucket: 'day' | 'month'
  /** One entry per bucket (local `YYYY-MM-DD` or `YYYY-MM`), gaps included. */
  series: { key: string; llm: number; audio: number }[]
  models: UsageModelRow[]
  audio: UsageAudioRow[]
  purposes: { purpose: UsagePurpose; label: string; requests: number; cost: number }[]
  /** The range's usage priced on each model instead; token counts are kept, so these are estimates across tokenizers. */
  whatIf: { llm: WhatIfRow[]; audio: WhatIfRow[] }
  requests: number
  tokens: number
  audioMinutes: number
}

const AUDIO_LABELS: Record<string, string> = { deepgram: 'Deepgram', whisper: 'Whisper' }

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider as LlmProviderId] ?? AUDIO_LABELS[provider] ?? provider
}

function audioLabel(provider: string, model: string): string {
  const name = model.replace(/^nova-(\d)/, 'Nova-$1')
  return `${providerLabel(provider)} ${name}`
}

/** Local midnight at the start of a range; null for all time. */
export function rangeStart(range: UsageRange, now: Date): Date | null {
  if (range === 'all') return null
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === '7d') d.setDate(d.getDate() - 6)
  else if (range === '30d') d.setDate(d.getDate() - 29)
  else d.setDate(1)
  return d
}

const counts = (e: UsageEvent): TokenCounts => ({ input: e.input_tokens, output: e.output_tokens, cacheRead: e.cache_read_tokens, cacheWrite: e.cache_write_tokens })

const audioUse = (e: UsageEvent, mode: AudioMode): Parameters<typeof audioCost>[1] => ({
  seconds: e.audio_seconds,
  mode,
  multilingual: e.multilingual,
  diarized: e.diarized,
  keyterms: e.keyterms
})

/** USD for one event: 0 when it ran locally, null when its model has no price. */
export function eventCost(e: UsageEvent, prices: PriceTable): number | null {
  if (isLocalProvider(e.provider)) return 0
  if (e.kind === 'llm') {
    const price = tokenPrice(prices, e.provider, e.model)
    return price ? tokenCost(price, counts(e)) : null
  }
  const price = audioPrice(prices, e.provider, e.model)
  return price && e.audio_mode ? audioCost(price, audioUse(e, e.audio_mode)) : null
}

const pad = (n: number): string => String(n).padStart(2, '0')
const dayKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const monthKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

/** Every bucket key from `start` through `end`, so days without usage still show. */
function bucketKeys(start: Date, end: Date, bucket: 'day' | 'month'): string[] {
  const keys: string[] = []
  const d = bucket === 'day' ? new Date(start.getFullYear(), start.getMonth(), start.getDate()) : new Date(start.getFullYear(), start.getMonth(), 1)
  while (d <= end) {
    keys.push(bucket === 'day' ? dayKey(d) : monthKey(d))
    if (bucket === 'day') d.setDate(d.getDate() + 1)
    else d.setMonth(d.getMonth() + 1)
  }
  return keys
}

const DAY_MS = 86_400_000

/**
 * Price and roll up `events` for `range`. `events` must include the whole current month (for the month's
 * projection) as well as the range.
 */
export function summarize(events: UsageEvent[], prices: PriceTable, range: UsageRange, now: Date, pricingErrors: string[] = []): UsageSummary {
  const from = rangeStart(range, now)
  const monthStart = rangeStart('month', now)!
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const priced = events.map((e) => ({ e, at: new Date(e.created_at), cost: eventCost(e, prices) }))
  const inRange = priced.filter((p) => !from || p.at >= from)

  // A day's worth of elapsed time at least, so the first hours of a month don't project wildly.
  const spent = priced.filter((p) => p.at >= monthStart).reduce((n, p) => n + (p.cost ?? 0), 0)
  const elapsed = Math.max(now.getTime() - monthStart.getTime(), DAY_MS) / (monthEnd.getTime() - monthStart.getTime())

  const first = inRange.reduce<Date | null>((min, p) => (!min || p.at < min ? p.at : min), null)
  const seriesStart = from ?? first ?? now
  const bucket: 'day' | 'month' = !from && now.getTime() - seriesStart.getTime() > 62 * DAY_MS ? 'month' : 'day'
  const series = new Map(bucketKeys(seriesStart, now, bucket).map((k) => [k, { key: k, llm: 0, audio: 0 }]))

  const cost = { total: 0, llm: 0, audio: 0 }
  const unpriced = { requests: 0, minutes: 0 }
  const models = new Map<string, UsageModelRow>()
  const audio = new Map<string, UsageAudioRow>()
  const purposes = new Map<UsagePurpose, { purpose: UsagePurpose; label: string; requests: number; cost: number }>()
  let requests = 0
  let tokens = 0
  let audioMinutes = 0

  for (const { e, at, cost: c } of inRange) {
    const minutes = e.audio_seconds / 60
    if (c === null) {
      if (e.kind === 'llm') unpriced.requests++
      else unpriced.minutes += minutes
    } else {
      cost.total += c
      cost[e.kind] += c
      const point = series.get(bucket === 'day' ? dayKey(at) : monthKey(at))
      if (point) point[e.kind] += c
    }
    const p = purposes.get(e.purpose) ?? { purpose: e.purpose, label: PURPOSE_LABELS[e.purpose] ?? e.purpose, requests: 0, cost: 0 }
    p.requests++
    p.cost += c ?? 0
    purposes.set(e.purpose, p)

    if (e.kind === 'llm') {
      requests++
      tokens += e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens
      const key = `${e.provider}/${e.model}`
      const m = models.get(key) ?? {
        provider: e.provider,
        model: e.model,
        label: prettyModelName(e.model),
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
        local: isLocalProvider(e.provider)
      }
      m.requests++
      m.inputTokens += e.input_tokens
      m.outputTokens += e.output_tokens
      m.cacheReadTokens += e.cache_read_tokens
      m.cacheWriteTokens += e.cache_write_tokens
      m.cost = m.cost === null || c === null ? null : m.cost + c
      models.set(key, m)
    } else {
      audioMinutes += minutes
      const mode = e.audio_mode ?? 'streaming'
      const key = `${e.provider}/${e.model}/${mode}`
      const a = audio.get(key) ?? { provider: e.provider, model: e.model, label: audioLabel(e.provider, e.model), mode, minutes: 0, cost: 0, local: isLocalProvider(e.provider) }
      a.minutes += minutes
      a.cost = a.cost === null || c === null ? null : a.cost + c
      audio.set(key, a)
    }
  }

  const byCost = <T extends { cost: number | null }>(a: T, b: T): number => (b.cost ?? -1) - (a.cost ?? -1)
  return {
    range,
    from: from?.toISOString() ?? null,
    pricesAsOf: PRICES_AS_OF,
    prices,
    pricingErrors,
    cost,
    unpriced,
    month: { spent, projected: spent / elapsed },
    bucket,
    series: [...series.values()],
    models: [...models.values()].sort((a, b) => byCost(a, b) || b.requests - a.requests),
    audio: [...audio.values()].sort((a, b) => byCost(a, b) || b.minutes - a.minutes),
    purposes: [...purposes.values()].sort((a, b) => b.cost - a.cost || b.requests - a.requests),
    whatIf: whatIf(inRange.map((p) => p.e), prices),
    requests,
    tokens,
    audioMinutes
  }
}

/**
 * The same usage priced on other models: every request on each model in the picker, every minute of audio on each
 * priced engine (keeping how it was sent). Cheapest first.
 */
export function whatIf(events: UsageEvent[], prices: PriceTable): { llm: WhatIfRow[]; audio: WhatIfRow[] } {
  const llmEvents = events.filter((e) => e.kind === 'llm')
  const audioEvents = events.filter((e) => e.kind === 'audio')
  const llm: WhatIfRow[] = []
  if (llmEvents.length) {
    for (const m of CURATED_MODELS) {
      const price = tokenPrice(prices, m.provider, m.model)
      if (price) llm.push({ provider: m.provider, model: m.model, label: m.label, cost: llmEvents.reduce((n, e) => n + tokenCost(price, counts(e)), 0) })
    }
  }
  const audio: WhatIfRow[] = []
  if (audioEvents.length) {
    for (const [key, price] of Object.entries(prices.audio)) {
      const [provider, model] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)]
      audio.push({ provider, model, label: audioLabel(provider, model), cost: audioEvents.reduce((n, e) => n + audioCost(price, audioUse(e, e.audio_mode ?? 'streaming')), 0) })
    }
  }
  const cheapest = (a: WhatIfRow, b: WhatIfRow): number => a.cost - b.cost
  return { llm: llm.sort(cheapest), audio: audio.sort(cheapest) }
}
