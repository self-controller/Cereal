import type { DB } from './index'
import type { PriceTable } from '@shared/pricing'
import { rangeStart, summarize, type NewUsageEvent, type UsageEvent, type UsageRange, type UsageSummary } from '@shared/usage'

const now = (): string => new Date().toISOString()

interface UsageRow extends Omit<UsageEvent, 'multilingual' | 'diarized' | 'keyterms'> {
  multilingual: number
  diarized: number
  keyterms: number
}

/** API usage events (table `usage_events`), for Settings → Usage. */
export class UsageStore {
  constructor(readonly db: DB) {}

  record(e: NewUsageEvent): void {
    this.db
      .prepare(
        `INSERT INTO usage_events (created_at, kind, provider, model, purpose, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           audio_seconds, audio_mode, multilingual, diarized, keyterms, document_id, thread_id, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        e.created_at ?? now(),
        e.kind,
        e.provider,
        e.model,
        e.purpose,
        Math.max(0, Math.round(e.input_tokens ?? 0)),
        Math.max(0, Math.round(e.output_tokens ?? 0)),
        Math.max(0, Math.round(e.cache_read_tokens ?? 0)),
        Math.max(0, Math.round(e.cache_write_tokens ?? 0)),
        Math.max(0, e.audio_seconds ?? 0),
        e.audio_mode ?? null,
        e.multilingual ? 1 : 0,
        e.diarized ? 1 : 0,
        e.keyterms ? 1 : 0,
        e.document_id ?? null,
        e.thread_id ?? null,
        e.run_id ?? null
      )
  }

  /** Events since `since` (all of them when null), oldest first. */
  list(since: Date | null): UsageEvent[] {
    const rows = (
      since
        ? this.db.prepare('SELECT * FROM usage_events WHERE created_at >= ? ORDER BY created_at, id').all(since.toISOString())
        : this.db.prepare('SELECT * FROM usage_events ORDER BY created_at, id').all()
    ) as UsageRow[]
    return rows.map((r) => ({ ...r, multilingual: !!r.multilingual, diarized: !!r.diarized, keyterms: !!r.keyterms }))
  }

  summary(range: UsageRange, prices: PriceTable, pricingErrors: string[] = [], at = new Date()): UsageSummary {
    // The month's projection needs the whole month even when the range is shorter.
    const from = rangeStart(range, at)
    const month = rangeStart('month', at)!
    return summarize(this.list(from && from < month ? from : from ? month : null), prices, range, at, pricingErrors)
  }
}
