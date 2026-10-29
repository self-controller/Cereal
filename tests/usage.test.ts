import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../src/main/db'
import { Store } from '../src/main/db/store'
import { UsageStore } from '../src/main/db/usage-store'
import { Recorder, type CaptureLike } from '../src/main/recorder'
import { AiService } from '../src/main/ai/service'
import { loadPrices, meter } from '../src/main/usage'
import type { GenerateOptions, LlmProvider } from '../src/main/llm/provider'
import type { TranscriptionStream } from '../src/main/transcription/types'
import { DEFAULT_PRICES, audioCost, mergePrices, tokenCost, tokenPrice, type PriceTable } from '@shared/pricing'
import { eventCost, summarize, whatIf, type NewUsageEvent, type UsageEvent } from '@shared/usage'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { makeAgent } from './agent-harness'

let nextId = 1
function event(e: NewUsageEvent & { created_at: string }): UsageEvent {
  return {
    id: nextId++,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    audio_seconds: 0,
    audio_mode: null,
    multilingual: false,
    diarized: false,
    keyterms: false,
    document_id: null,
    thread_id: null,
    run_id: null,
    ...e
  }
}

/** Local time, like the page's ranges. */
const at = (month: number, day: number, hour = 12): string => new Date(2026, month - 1, day, hour).toISOString()

describe('pricing', () => {
  it('finds a model by id or by its dated snapshot, and nothing for unknown models', () => {
    expect(tokenPrice(DEFAULT_PRICES, 'anthropic', 'claude-opus-5-5')).toMatchObject({ input: 4, output: 20 })
    expect(tokenPrice(DEFAULT_PRICES, 'openai', 'gpt-5.5-2026-04-23')).toMatchObject({ input: 5, output: 30 })
    expect(tokenPrice(DEFAULT_PRICES, 'openai', 'gpt-9')).toBeNull()
    expect(tokenPrice(DEFAULT_PRICES, 'gemini', 'claude-opus-5-5')).toBeNull()
  })

  it('prices each kind of token, falling back to the input rate for missing cache rates', () => {
    const opus = DEFAULT_PRICES.tokens['anthropic/claude-opus-5-5']
    expect(tokenCost(opus, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo(4)
    expect(tokenCost(opus, { input: 0, output: 100_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(2 + 0.2 + 5)
    expect(tokenCost({ input: 1, output: 2 }, { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(2)
  })

  it('switches to long-context rates on the request’s whole prompt, cache reads included', () => {
    const haiku = DEFAULT_PRICES.tokens['anthropic/claude-haiku-5-5']
    expect(tokenCost(haiku, { input: 90_000, output: 1_000, cacheRead: 0, cacheWrite: 0 })).toBeCloseTo((90_000 * 0.1 + 1_000 * 0.5) / 1e6)
    // 10k uncached + 95k cached is a 105k prompt: every token pays the higher rates.
    expect(tokenCost(haiku, { input: 10_000, output: 1_000, cacheRead: 95_000, cacheWrite: 0 })).toBeCloseTo((10_000 * 0.5 + 1_000 * 2.5 + 95_000 * 0.05) / 1e6)
  })

  it('adds Deepgram’s per-minute surcharges by how the audio was sent', () => {
    const nova = DEFAULT_PRICES.audio['deepgram/nova-3']
    const minute = { seconds: 60, multilingual: false, diarized: false, keyterms: false }
    expect(audioCost(nova, { ...minute, mode: 'streaming' })).toBeCloseTo(0.0077)
    expect(audioCost(nova, { ...minute, mode: 'streaming', diarized: true, keyterms: true })).toBeCloseTo(0.0077 + 0.002 + 0.0013)
    expect(audioCost(nova, { ...minute, mode: 'streaming', multilingual: true })).toBeCloseTo(0.0092)
    // Diarization is included for pre-recorded audio.
    expect(audioCost(nova, { ...minute, mode: 'prerecorded', diarized: true })).toBeCloseTo(0.0043)
  })

  it('merges overrides field by field, adds new models and reports what it skipped', () => {
    const { prices, errors } = mergePrices(DEFAULT_PRICES, {
      _readme: 'ignored',
      tokens: {
        'openai/gpt-5.6': { input: 5, output: 30 },
        'openai/gpt-9': { input: 1, output: 2 },
        'openai/half': { input: 1 },
        'anthropic/claude-opus-5-5': { input: 'four' }
      },
      audio: { 'deepgram/nova-3': { streaming: 0.0048, diarization: { streaming: 0.001 } } }
    })
    expect(prices.tokens['openai/gpt-5.6']).toMatchObject({ input: 5, output: 30, cacheRead: 0.4, longContext: { above: 272_000 } })
    expect(prices.tokens['openai/gpt-9']).toEqual({ input: 1, output: 2 })
    expect(prices.tokens['openai/half']).toBeUndefined()
    expect(prices.tokens['anthropic/claude-opus-5-5'].input).toBe(4)
    expect(prices.audio['deepgram/nova-3']).toMatchObject({ streaming: 0.0048, prerecorded: 0.0043, diarization: { streaming: 0.001, prerecorded: 0 } })
    expect(errors).toEqual([expect.stringContaining('openai/half'), expect.stringContaining('claude-opus-5-5"].input')])
    // The defaults are untouched.
    expect(DEFAULT_PRICES.tokens['openai/gpt-5.6'].input).toBe(4)
  })

  it('loads pricing.json over the defaults, and keeps the defaults when the file is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cereal-pricing-'))
    expect(loadPrices(join(dir, 'missing.json'))).toEqual({ prices: DEFAULT_PRICES, errors: [] })
    writeFileSync(join(dir, 'pricing.json'), JSON.stringify({ tokens: { 'openai/gpt-5.6': { input: 5 } } }))
    expect(loadPrices(join(dir, 'pricing.json')).prices.tokens['openai/gpt-5.6'].input).toBe(5)
    writeFileSync(join(dir, 'broken.json'), '{ nope')
    const broken = loadPrices(join(dir, 'broken.json'))
    expect(broken.prices).toBe(DEFAULT_PRICES)
    expect(broken.errors[0]).toMatch(/couldn't be read/)
  })
})

describe('summarize', () => {
  const now = new Date(2026, 9, 20, 12)
  const opus = (created_at: string, purpose: UsageEvent['purpose'] = 'enhance'): UsageEvent =>
    event({ kind: 'llm', provider: 'anthropic', model: 'claude-opus-5-5', purpose, created_at, input_tokens: 1_000_000, output_tokens: 100_000 })
  const events: UsageEvent[] = [
    opus(at(9, 25), 'chat'),
    event({ kind: 'audio', provider: 'deepgram', model: 'nova-3', purpose: 'transcription', created_at: at(10, 1), audio_seconds: 600, audio_mode: 'streaming', diarized: true }),
    event({ kind: 'llm', provider: 'ollama', model: 'llama3.1', purpose: 'chat', created_at: at(10, 19), input_tokens: 2_000, output_tokens: 500 }),
    event({ kind: 'llm', provider: 'openai', model: 'gpt-9', purpose: 'chat', created_at: at(10, 19), input_tokens: 10 }),
    opus(at(10, 20))
  ]

  it('prices events: local ones are free, unknown models have no price', () => {
    expect(eventCost(events[0], DEFAULT_PRICES)).toBeCloseTo(6)
    expect(eventCost(events[1], DEFAULT_PRICES)).toBeCloseTo(10 * (0.0077 + 0.002))
    expect(eventCost(events[2], DEFAULT_PRICES)).toBe(0)
    expect(eventCost(events[3], DEFAULT_PRICES)).toBeNull()
  })

  it('totals a range, leaving out unpriced usage, and projects the month at its pace so far', () => {
    const s = summarize(events, DEFAULT_PRICES, '7d', now)
    expect(s.from).toBe(new Date(2026, 9, 14).toISOString())
    expect(s.cost).toEqual({ total: expect.closeTo(6, 6), llm: expect.closeTo(6, 6), audio: 0 })
    expect(s.unpriced).toEqual({ requests: 1, minutes: 0 })
    expect(s.requests).toBe(3)
    expect(s.series).toHaveLength(7)
    expect(s.series.at(-1)).toEqual({ key: '2026-10-20', llm: expect.closeTo(6, 6), audio: 0 })

    // The month counts October only (not September's chat), whatever the range.
    const spent = 6 + 10 * (0.0077 + 0.002)
    expect(s.month.spent).toBeCloseTo(spent)
    expect(s.month.projected).toBeCloseTo(spent / (19.5 / 31))
  })

  it('breaks the range down by model, engine and feature', () => {
    const s = summarize(events, DEFAULT_PRICES, '30d', now)
    expect(s.models.map((m) => [m.model, m.requests, m.cost, m.local])).toEqual([
      ['claude-opus-5-5', 2, expect.closeTo(12, 6), false],
      ['llama3.1', 1, 0, true],
      ['gpt-9', 1, null, false]
    ])
    expect(s.models[0]).toMatchObject({ label: 'Claude Opus 5.5', inputTokens: 2_000_000, outputTokens: 200_000 })
    expect(s.audio).toEqual([{ provider: 'deepgram', model: 'nova-3', label: 'Deepgram Nova-3', mode: 'streaming', minutes: 10, cost: expect.closeTo(0.097, 6), local: false }])
    expect(s.purposes.map((p) => [p.purpose, p.requests])).toEqual([
      ['chat', 3],
      ['enhance', 1],
      ['transcription', 1]
    ])
    expect(s.audioMinutes).toBe(10)
  })

  it('buckets all time by day, or by month once it spans more than two months', () => {
    expect(summarize(events, DEFAULT_PRICES, 'all', now)).toMatchObject({ from: null, bucket: 'day' })
    expect(summarize(events, DEFAULT_PRICES, 'all', now).series[0].key).toBe('2026-09-25')
    const old = summarize([opus(at(6, 2)), ...events], DEFAULT_PRICES, 'all', now)
    expect(old.bucket).toBe('month')
    expect(old.series.map((p) => p.key)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
  })

  it('prices the same usage on every model in the picker, local usage included, cheapest first', () => {
    const local = [events[2]]
    const w = whatIf(local, DEFAULT_PRICES)
    expect(w.audio).toEqual([])
    expect(w.llm[0]).toMatchObject({ model: 'claude-haiku-5-5', cost: expect.closeTo((2_000 * 0.1 + 500 * 0.5) / 1e6, 9) })
    expect(w.llm.find((r) => r.model === 'claude-opus-5-5')!.cost).toBeCloseTo((2_000 * 4 + 500 * 20) / 1e6)
    expect(w.llm.map((r) => r.cost)).toEqual([...w.llm.map((r) => r.cost)].sort((a, b) => a - b))

    const whisper = event({ kind: 'audio', provider: 'whisper', model: 'base.en', purpose: 'transcription', created_at: at(10, 20), audio_seconds: 120, audio_mode: 'streaming', keyterms: true })
    expect(whatIf([whisper], DEFAULT_PRICES).audio).toEqual([{ provider: 'deepgram', model: 'nova-3', label: 'Deepgram Nova-3', cost: expect.closeTo(2 * (0.0077 + 0.0013), 9) }])
  })

  it('re-prices history when a price changes', () => {
    const cheaper: PriceTable = mergePrices(DEFAULT_PRICES, { tokens: { 'anthropic/claude-opus-5-5': { input: 2 } } }).prices
    expect(summarize(events, cheaper, '7d', now).cost.total).toBeCloseTo(4)
  })
})

describe('UsageStore', () => {
  it('records events and summarizes them', () => {
    const usage = new UsageStore(openDatabase(':memory:'))
    usage.record({ kind: 'llm', provider: 'anthropic', model: 'claude-haiku-5-5', purpose: 'note-title', input_tokens: 120.4, output_tokens: 9, document_id: 'doc1' })
    usage.record({ kind: 'audio', provider: 'deepgram', model: 'nova-3', purpose: 'transcription', audio_seconds: 90, audio_mode: 'streaming', diarized: true })
    const [llm, audio] = usage.list(null)
    expect(llm).toMatchObject({ kind: 'llm', input_tokens: 120, output_tokens: 9, cache_read_tokens: 0, document_id: 'doc1', diarized: false, audio_mode: null })
    expect(audio).toMatchObject({ kind: 'audio', audio_seconds: 90, diarized: true, multilingual: false })
    const s = usage.summary('7d', DEFAULT_PRICES)
    expect(s.requests).toBe(1)
    expect(s.audioMinutes).toBe(1.5)
    expect(s.cost.audio).toBeCloseTo(1.5 * (0.0077 + 0.002))
  })

  it('never lets a failed write break the request it measures', () => {
    const onUsage = meter(() => {
      throw new Error('disk full')
    }, 'chat')!
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => onUsage({ provider: 'anthropic', model: 'm', usage: { inputTokens: 1 } })).not.toThrow()
    warn.mockRestore()
    expect(meter(undefined, 'chat')).toBeUndefined()
  })
})

describe('recording usage', () => {
  it('records chat turns, compaction and thread titles with their thread and run', async () => {
    const a = makeAgent(() => ({ text: 'x'.repeat(400) }), { maxInputChars: 1_000 })
    const { threadId } = a.chat.send({ text: 'q1' })
    await a.settle()
    a.chat.send({ threadId, text: 'q2' })
    await a.settle()
    a.chat.send({ threadId, text: 'q3' })
    await a.settle()
    await new Promise((r) => setTimeout(r, 0))
    const rows = a.usage.list(null)
    expect(rows.filter((r) => r.purpose === 'chat')).toHaveLength(3)
    expect(rows.find((r) => r.purpose === 'chat')).toMatchObject({ provider: 'anthropic', model: 'scripted', input_tokens: 10, output_tokens: 5, thread_id: threadId, run_id: expect.any(String) })
    expect(rows.find((r) => r.purpose === 'compaction')).toMatchObject({ model: 'scripted-fast', input_tokens: 100, thread_id: threadId })
    expect(rows.find((r) => r.purpose === 'chat-title')).toMatchObject({ thread_id: threadId, run_id: null })
  })

  it('records Assistant turns as assistant usage', async () => {
    const a = makeAgent(() => ({ text: 'Done.' }))
    a.assistant.send({ text: 'Hello', clientMessageId: 'c1' })
    await a.settle()
    expect(a.usage.list(null).map((r) => r.purpose)).toContain('assistant')
  })

  it('records enhanced notes, the condensing step and the note title', async () => {
    const store = new Store(openDatabase(':memory:'))
    const usage = new UsageStore(store.db)
    const doc = store.createDocument({ title: '' })
    store.upsertChunks([
      { id: 'a', document_id: doc.id, source: 'microphone', text: 'word '.repeat(400), start_timestamp: '2026-10-19T15:00:00Z', end_timestamp: '2026-10-19T15:00:03Z', is_final: true }
    ])
    const provider: LlmProvider = {
      id: 'gemini',
      maxInputChars: 1_000,
      async generate(opts: GenerateOptions) {
        opts.onUsage?.({ provider: 'gemini', model: opts.tier === 'fast' ? 'gemini-3.5-flash' : 'gemini-3.1-pro-preview', usage: { inputTokens: 50, outputTokens: 10 } })
        return opts.tier === 'fast' ? 'Title' : '- note'
      },
      step: async () => {
        throw new Error('unused')
      },
      listModels: async () => []
    }
    const settings = { get: () => DEFAULT_SETTINGS }
    const ai = new AiService({ store, settings: settings as never, provider: () => provider, emitPanel: () => undefined, emitDocumentChanged: () => undefined, recordUsage: (e) => usage.record(e) })
    const panel = ai.enhance(doc.id)
    await vi.waitFor(() => expect(store.getPanel(panel.id)!.generation_finished_at).not.toBeNull())
    await vi.waitFor(() => expect(usage.list(null).some((r) => r.purpose === 'note-title')).toBe(true))
    const purposes = usage.list(null).map((r) => r.purpose)
    expect(purposes).toContain('condense')
    expect(purposes).toContain('enhance')
    expect(usage.list(null).every((r) => r.document_id === doc.id && r.provider === 'gemini')).toBe(true)
  })

  it('records each recording stream’s audio, billed the way it was sent', async () => {
    class Stream extends EventEmitter implements TranscriptionStream {
      write(): void {}
      async finish(): Promise<void> {}
      close(): void {}
    }
    class Capture extends EventEmitter implements CaptureLike {
      start(): void {}
      stop(): void {}
    }
    const store = new Store(openDatabase(':memory:'))
    const usage = new UsageStore(store.db)
    const doc = store.createDocument({ title: 'Call' })
    const captures: Capture[] = []
    const recorder = new Recorder({
      store,
      settings: () => ({ ...DEFAULT_SETTINGS, dictionary: ['Cereal'] }),
      createEngine: async () => ({ id: 'deepgram', open: async () => new Stream() }),
      createCapture: () => {
        const c = new Capture()
        captures.push(c)
        return c
      },
      emitChunks: () => undefined,
      emitState: () => undefined,
      emitLevels: () => undefined,
      sampleRate: 16_000,
      recordUsage: (e) => usage.record(e)
    })
    await recorder.start(doc.id)
    captures[0].emit('data', Buffer.alloc(32_000)) // 1 s of 16 kHz PCM16
    captures[1].emit('data', Buffer.alloc(64_000))
    await recorder.stop()
    expect(usage.list(null)).toEqual([
      expect.objectContaining({ kind: 'audio', provider: 'deepgram', model: 'nova-3', purpose: 'transcription', audio_seconds: 1, audio_mode: 'streaming', diarized: true, keyterms: true, document_id: doc.id }),
      expect.objectContaining({ audio_seconds: 2 })
    ])
  })
})
