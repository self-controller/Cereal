// What Cereal's API use costs, for the estimates in Settings → Usage. Each price was checked on PRICES_AS_OF against
// the provider's own page; where a provider runs a promotion, the regular price is used and the promotion noted, so
// estimates err high. `<userData>/pricing.json` (same shape, any subset of fields) overrides these without a rebuild.
//
// Sources: platform.claude.com/docs/en/about-claude/pricing, developers.openai.com/api/docs/pricing,
// ai.google.dev/gemini-api/docs/pricing, deepgram.com/pricing.

export const PRICES_AS_OF = '2026-10-20'

/** USD per million tokens. `input` is uncached input; cache writes are 5-minute writes, the only kind Cereal makes. */
export interface TokenRates {
  input: number
  output: number
  /** Defaults to `input` when missing. */
  cacheRead?: number
  /** Defaults to `input` when missing. */
  cacheWrite?: number
}

export interface TokenPrice extends TokenRates {
  /** A request whose prompt (input + cache reads + cache writes) is over `above` tokens pays these rates instead. */
  longContext?: TokenRates & { above: number }
}

/** USD per minute of audio, by how it is sent. */
export interface AudioRates {
  streaming: number
  prerecorded: number
}

export interface AudioPrice extends AudioRates {
  /** Replaces the base rates when the language is 'multi'. */
  multilingual?: AudioRates
  /** Added per minute when speakers are diarized. */
  diarization?: AudioRates
  /** Added per minute when the request carries keyterms (dictionary words, attendee names). */
  keyterms?: AudioRates
}

/** Keyed `provider/model`. */
export interface PriceTable {
  tokens: Record<string, TokenPrice>
  audio: Record<string, AudioPrice>
}

export const DEFAULT_PRICES: PriceTable = {
  tokens: {
    'anthropic/claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    'anthropic/claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    'anthropic/claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    'anthropic/claude-haiku-5-5': {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      longContext: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }
    },
    // OpenAI lists only the -sol/-terra/-luna variants of GPT-5.6; plain `gpt-5.6` is priced as Sol, the flagship.
    // Sol's rates are promotional "at least through November 21, 2026"; the page doesn't publish the regular ones.
    'openai/gpt-5.6': { input: 4, output: 20, cacheRead: 0.4, longContext: { above: 272_000, input: 8, output: 30, cacheRead: 0.8 } },
    'openai/gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, longContext: { above: 272_000, input: 8, output: 30, cacheRead: 0.8 } },
    'openai/gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, longContext: { above: 272_000, input: 4, output: 18, cacheRead: 0.4 } },
    'openai/gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, longContext: { above: 272_000, input: 0.4, output: 1.8, cacheRead: 0.04 } },
    'openai/gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, longContext: { above: 272_000, input: 10, output: 45, cacheRead: 1 } },
    'openai/gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075 },
    'gemini/gemini-3.1-pro-preview': { input: 2, output: 12, cacheRead: 0.2, longContext: { above: 200_000, input: 4, output: 18, cacheRead: 0.4 } },
    // Not on Google's page as of PRICES_AS_OF (it lists 3.8 and 3.6 Flash); these are the last published rates.
    'gemini/gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15 },
    // Promotional $0.75 / $3.75 / $0.075 through December 31, 2026.
    'gemini/gemini-3.8-flash': { input: 1.5, output: 7.5, cacheRead: 0.15 },
    'gemini/gemini-3.6-flash': { input: 1.5, output: 7.5, cacheRead: 0.15 }
  },
  audio: {
    // Pay As You Go. Streaming is promotional at $0.0048 ($0.0058 multilingual), with no end date given.
    'deepgram/nova-3': {
      streaming: 0.0077,
      prerecorded: 0.0043,
      multilingual: { streaming: 0.0092, prerecorded: 0.0052 },
      diarization: { streaming: 0.002, prerecorded: 0 },
      keyterms: { streaming: 0.0013, prerecorded: 0.0013 }
    }
  }
}

/** Providers that run on this machine: their usage costs nothing. */
export const LOCAL_PROVIDERS: readonly string[] = ['ollama', 'whisper']

export const isLocalProvider = (provider: string): boolean => LOCAL_PROVIDERS.includes(provider)

/** Dated snapshots (`gpt-5.5-2026-04-23`, `…-20260423`) price as their base model. */
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{8})$/

function lookup<T>(table: Record<string, T>, provider: string, model: string): T | null {
  return table[`${provider}/${model}`] ?? table[`${provider}/${model.replace(SNAPSHOT, '')}`] ?? null
}

export const tokenPrice = (prices: PriceTable, provider: string, model: string): TokenPrice | null => lookup(prices.tokens, provider, model)

export const audioPrice = (prices: PriceTable, provider: string, model: string): AudioPrice | null => lookup(prices.audio, provider, model)

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** USD for one request. Long-context rates depend on that request's own prompt size, so price requests one by one. */
export function tokenCost(price: TokenPrice, t: TokenCounts): number {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  const r: TokenRates = price.longContext && prompt > price.longContext.above ? price.longContext : price
  return (t.input * r.input + t.output * r.output + t.cacheRead * (r.cacheRead ?? r.input) + t.cacheWrite * (r.cacheWrite ?? r.input)) / 1_000_000
}

export interface AudioUse {
  seconds: number
  mode: 'streaming' | 'prerecorded'
  multilingual: boolean
  diarized: boolean
  keyterms: boolean
}

/** USD for a stretch of audio, with its language and add-on surcharges. */
export function audioCost(price: AudioPrice, a: AudioUse): number {
  const base = a.multilingual && price.multilingual ? price.multilingual : price
  let perMinute = base[a.mode]
  if (a.diarized && price.diarization) perMinute += price.diarization[a.mode]
  if (a.keyterms && price.keyterms) perMinute += price.keyterms[a.mode]
  return (a.seconds / 60) * perMinute
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Merge a number-only object over `base`, field by field, recursing into nested rate objects. */
function mergeRates<T extends object>(base: T | undefined, patch: unknown, path: string, errors: string[]): T {
  const out: Record<string, unknown> = { ...(base ?? {}) }
  if (!isRecord(patch)) {
    errors.push(`${path} should be an object of prices`)
    return out as T
  }
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
    else if (isRecord(v)) out[k] = mergeRates(isRecord(out[k]) ? (out[k] as object) : undefined, v, `${path}.${k}`, errors)
    else errors.push(`${path}.${k} should be a non-negative number`)
  }
  return out as T
}

/**
 * The defaults with a user's overrides (parsed pricing.json) on top. A new key adds a model; an existing key changes
 * only the fields it names. Fields that aren't prices are skipped and reported.
 */
export function mergePrices(base: PriceTable, overrides: unknown): { prices: PriceTable; errors: string[] } {
  const errors: string[] = []
  const prices: PriceTable = { tokens: { ...base.tokens }, audio: { ...base.audio } }
  if (!isRecord(overrides)) {
    if (overrides !== undefined && overrides !== null) errors.push('pricing.json should contain an object')
    return { prices, errors }
  }
  for (const section of ['tokens', 'audio'] as const) {
    const entries = overrides[section]
    if (entries === undefined) continue
    if (!isRecord(entries)) {
      errors.push(`"${section}" should be an object keyed by provider/model`)
      continue
    }
    for (const [key, patch] of Object.entries(entries)) {
      const merged = mergeRates<object>(prices[section][key], patch, `${section}["${key}"]`, errors) as TokenPrice & AudioPrice
      const required = section === 'tokens' ? ['input', 'output'] : ['streaming', 'prerecorded']
      if (required.every((f) => typeof (merged as unknown as Record<string, unknown>)[f] === 'number')) prices[section][key] = merged
      else errors.push(`${section}["${key}"] needs ${required.join(' and ')}`)
    }
  }
  return { prices, errors }
}
