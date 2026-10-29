// Recording API usage (see src/shared/usage.ts) and loading the prices it's costed at.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { DEFAULT_PRICES, mergePrices, type PriceTable } from '@shared/pricing'
import type { NewUsageEvent, UsagePurpose } from '@shared/usage'
import type { UsageReport } from './llm/provider'

export type RecordUsage = (e: NewUsageEvent) => void

export type UsageIds = Pick<NewUsageEvent, 'document_id' | 'thread_id' | 'run_id'>

/** A model request's report as a usage event. */
export function llmUsageEvent(r: UsageReport, purpose: UsagePurpose, ids: UsageIds = {}): NewUsageEvent {
  return {
    kind: 'llm',
    provider: r.provider,
    model: r.model,
    purpose,
    input_tokens: r.usage.inputTokens ?? 0,
    output_tokens: r.usage.outputTokens ?? 0,
    cache_read_tokens: r.usage.cacheReadTokens ?? 0,
    cache_write_tokens: r.usage.cacheWriteTokens ?? 0,
    ...ids
  }
}

/** Record an event if anything records usage. Never throws: recording must not fail what it measures. */
export function recordSafely(record: RecordUsage | undefined, e: NewUsageEvent): void {
  try {
    record?.(e)
  } catch (err) {
    console.warn('Could not record API usage:', err)
  }
}

/** An `onUsage` callback that records each request under `purpose`; undefined when usage isn't being recorded. */
export function meter(record: RecordUsage | undefined, purpose: UsagePurpose, ids: UsageIds = {}): ((r: UsageReport) => void) | undefined {
  return record && ((r) => recordSafely(record, llmUsageEvent(r, purpose, ids)))
}

const PRICING_TEMPLATE = {
  _readme:
    "Overrides for the prices in Settings → Usage, merged over Cereal's own table. Keys are provider/model. Token prices are USD per million tokens (input, output, cacheRead, cacheWrite, and an optional longContext with `above`); audio prices are USD per minute (streaming, prerecorded, and optional multilingual, diarization and keyterms). Name only the fields you want to change.",
  tokens: {},
  audio: {}
}

/** Create the overrides file if it's missing (with a short explanation and nothing overridden). */
export function ensurePricingFile(file: string): void {
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(PRICING_TEMPLATE, null, 2) + '\n')
}

/** Cereal's prices with pricing.json on top; a file that can't be read leaves the defaults and says why. */
export function loadPrices(file: string): { prices: PriceTable; errors: string[] } {
  if (!existsSync(file)) return { prices: DEFAULT_PRICES, errors: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { prices: DEFAULT_PRICES, errors: [`pricing.json couldn't be read: ${(e as Error).message}`] }
  }
  return mergePrices(DEFAULT_PRICES, parsed)
}
