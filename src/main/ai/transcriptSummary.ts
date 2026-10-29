// "Transcript Summary" (docs/granola-findings.md §6): on demand, explain where one line of the enhanced notes came from.
// Nothing is stored; each request streams its text back as `transcript-summary:update`, keyed by the caller's id.
import type { Store } from '../db/store'
import type { SettingsService } from '../settings'
import type { LlmProvider } from '../llm/provider'
import { describeLlmError } from '../llm'
import { meter, type RecordUsage } from '../usage'
import type { TranscriptSummaryUpdate } from '@shared/ipc'
import { formatTranscript } from '@shared/transcript'
import { selectTranscriptChunks } from '@shared/transcriptSummary'
import { promptSpeakers } from './variables'
import { transcriptSummarySystemPrompt, transcriptSummaryUserMessage } from './prompts'

export interface TranscriptSummaryDeps {
  store: Store
  settings: SettingsService
  provider: () => LlmProvider
  emit: (update: TranscriptSummaryUpdate) => void
  recordUsage?: RecordUsage
}

const EMIT_MS = 80

export class TranscriptSummaryService {
  private running = new Map<string, AbortController>()

  constructor(private readonly deps: TranscriptSummaryDeps) {}

  /** Throws before streaming when there is nothing to explain from or no model is set up. */
  start(requestId: string, documentId: string, line: string): void {
    const { store, settings } = this.deps
    const doc = store.getDocument(documentId)
    if (!doc) throw new Error('Note not found')
    const chunks = store.getTranscript(documentId).filter((c) => c.is_final)
    if (chunks.length === 0) throw new Error('This note has no transcript')
    const provider = this.deps.provider()

    const selected = selectTranscriptChunks(chunks, line, Math.floor(provider.maxInputChars * 0.6))
    const transcript = formatTranscript(selected, { speakers: promptSpeakers(doc, chunks, settings.get()), origin: chunks[0].start_timestamp })
    const when = new Date(doc.calendar_event?.start ?? doc.created_at)
    const abort = new AbortController()
    this.running.get(requestId)?.abort()
    this.running.set(requestId, abort)
    void this.run(requestId, abort, provider, documentId, {
      system: transcriptSummarySystemPrompt(doc.mode === 'lecture'),
      user: transcriptSummaryUserMessage({
        title: doc.calendar_event?.title || doc.title,
        date: when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
        line: line.trim(),
        transcript,
        lecture: doc.mode === 'lecture',
        partial: selected.length < chunks.length
      })
    })
  }

  cancel(requestId: string): void {
    this.running.get(requestId)?.abort()
    this.running.delete(requestId)
  }

  private async run(requestId: string, abort: AbortController, provider: LlmProvider, documentId: string, prompt: { system: string; user: string }): Promise<void> {
    let text = ''
    let lastEmit = 0
    const emit = (done: boolean, error: string | null = null): void => {
      lastEmit = Date.now()
      this.deps.emit({ requestId, text, done, error })
    }
    try {
      await provider.generate({
        tier: 'fast',
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        maxTokens: 700,
        signal: abort.signal,
        onUsage: meter(this.deps.recordUsage, 'transcript-summary', { document_id: documentId }),
        onText: (delta) => {
          text += delta
          if (Date.now() - lastEmit >= EMIT_MS) emit(false)
        }
      })
      if (!abort.signal.aborted) emit(true)
    } catch (e) {
      if (!abort.signal.aborted) emit(true, describeLlmError(e))
    } finally {
      if (this.running.get(requestId) === abort) this.running.delete(requestId)
    }
  }
}
