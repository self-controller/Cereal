import type { Store } from '../db/store'
import type { SettingsService } from '../settings'
import type { LlmProvider } from '../llm/provider'
import { describeLlmError } from '../llm'
import { meter, type RecordUsage } from '../usage'
import type { ChatCitation, Panel } from '@shared/types'
import { AUTO_TEMPLATE_SLUG, defaultTemplateFor } from '@shared/defaults'
import { computeGeneratedLines, generatedLineTexts } from '@shared/attribution'
import { docToMarkdown, markdownLineText, markdownToDoc, parseLines, type PMNode } from '@shared/markdown'
import { buildPromptVariables } from './variables'
import { TITLE_SYSTEM_PROMPT, condenseSystemPrompt, enhanceSystemPrompt, enhanceUserMessage } from './prompts'

export interface AiDeps {
  store: Store
  settings: SettingsService
  provider: () => LlmProvider
  emitPanel: (panel: Panel) => void
  emitDocumentChanged: (id: string) => void
  recordUsage?: RecordUsage
}

const PANEL_FLUSH_MS = 150

/** Split text into pieces of at most `size` characters, on line boundaries. */
export function splitByLines(text: string, size: number): string[] {
  const parts: string[] = []
  let current = ''
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > size) {
      parts.push(current)
      current = ''
    }
    current += (current ? '\n' : '') + line
  }
  if (current) parts.push(current)
  return parts
}

/** Map "[n]" citation markers in an answer to the sources they refer to (chat answers cite meetings this way). */
export function extractCitations(answer: string, sources: { n: number; document_id: string; title: string }[]): ChatCitation[] {
  const used = new Set([...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))
  return sources.filter((s) => used.has(s.n)).map((s) => ({ n: s.n, document_id: s.document_id, title: s.title }))
}

export class AiService {
  private running = new Map<string, AbortController>()

  constructor(private readonly deps: AiDeps) {}

  // ----------------------------------------------------------------- enhance

  /** Start generating an enhanced-notes panel; returns the new panel immediately and streams updates. */
  enhance(documentId: string, templateSlug?: string | null, extraInstructions?: string): Panel {
    const { store, settings } = this.deps
    const doc = store.getDocument(documentId)
    if (!doc) throw new Error('Note not found')
    const slug = templateSlug || doc.selected_template || defaultTemplateFor(doc.mode, settings.get())
    const template = store.getTemplate(slug) ?? store.getTemplate(AUTO_TEMPLATE_SLUG)
    const provider = this.deps.provider() // throws a friendly config error before any panel is created
    const panel = store.createPanel(documentId, template && template.slug !== AUTO_TEMPLATE_SLUG ? template.title : 'Summary', template?.slug ?? AUTO_TEMPLATE_SLUG)
    if (doc.selected_template !== panel.template_slug) store.updateDocument(documentId, { selected_template: panel.template_slug })
    this.deps.emitPanel(panel)
    void this.runEnhance(panel, provider, extraInstructions)
    return panel
  }

  /** Regenerate a panel's content with extra instructions (Granola's "rewrite"), starting from the notes as edited. */
  rewrite(panelId: string, instructions: string): Panel {
    const panel = this.deps.store.getPanel(panelId)
    if (!panel) throw new Error('Panel not found')
    this.running.get(panelId)?.abort()
    const provider = this.deps.provider()
    const finished = !!panel.generation_finished_at
    // Lines the user typed or edited into the notes stay theirs (black) after the rewrite.
    const generated = new Set(panel.generated_lines)
    const userLines = finished
      ? parseLines(panel.content)
          .map(markdownLineText)
          .filter((t) => t && !generated.has(t))
      : []
    const reset = this.deps.store.updatePanel(panelId, {
      content: '',
      content_json: null,
      generated_lines: [],
      generation_started_at: new Date().toISOString(),
      generation_finished_at: null,
      generation_failed_at: null,
      error: null
    })
    this.deps.emitPanel(reset)
    void this.runEnhance(reset, provider, instructions, finished ? { notes: panel.content, userLines } : undefined)
    return reset
  }

  /** Save the user's edits to finished notes. Refused while the panel is (re)generating, so a late save can't clobber it. */
  saveEdit(panelId: string, contentJson: PMNode): Panel {
    const panel = this.deps.store.getPanel(panelId)
    if (!panel) throw new Error('Panel not found')
    if (this.running.has(panelId) || (!panel.generation_finished_at && !panel.generation_failed_at)) throw new Error('These notes are still being written')
    return this.deps.store.updatePanel(panelId, { content_json: contentJson, content: docToMarkdown(contentJson) })
  }

  private async runEnhance(panel: Panel, provider: LlmProvider, extraInstructions?: string, current?: { notes: string; userLines: string[] }): Promise<void> {
    const { store, settings } = this.deps
    const abort = new AbortController()
    this.running.set(panel.id, abort)
    let content = ''
    let lastFlush = 0
    const flush = (force = false): void => {
      if (!force && Date.now() - lastFlush < PANEL_FLUSH_MS) return
      lastFlush = Date.now()
      this.deps.emitPanel(store.updatePanel(panel.id, { content }))
    }
    try {
      const doc = store.getDocument(panel.document_id)!
      const template = store.getTemplate(panel.template_slug)
      const chunks = store.getTranscript(panel.document_id)
      const vars = buildPromptVariables(doc, chunks, settings.get(), template && template.slug !== AUTO_TEMPLATE_SLUG ? template : null)
      if (!vars.transcript.trim() && !vars.notes.trim()) throw new Error('There is nothing to enhance yet. Record the meeting or write some notes first.')

      const transcript = await this.fitTranscript(panel.document_id, vars.transcript, vars.is_lecture, provider, abort.signal)
      content = ''
      await provider.generate({
        tier: 'quality',
        system: enhanceSystemPrompt(vars, extraInstructions),
        messages: [{ role: 'user', content: enhanceUserMessage(vars, transcript, current?.notes) }],
        signal: abort.signal,
        onText: (delta) => {
          content += delta
          flush()
        },
        onUsage: meter(this.deps.recordUsage, 'enhance', { document_id: panel.document_id })
      })
      content = content.trim()
      const userText = [vars.notes, ...(current?.userLines ?? [])].join('\n')
      const finished = store.updatePanel(panel.id, {
        content,
        content_json: markdownToDoc(content),
        generated_lines: generatedLineTexts(content, computeGeneratedLines(content, userText)),
        generation_finished_at: new Date().toISOString()
      })
      this.deps.emitPanel(finished)
      if (!doc.title.trim()) void this.autoTitle(doc.id, content, provider)
    } catch (e) {
      if (abort.signal.aborted) return
      this.deps.emitPanel(store.updatePanel(panel.id, { content, generation_failed_at: new Date().toISOString(), error: describeLlmError(e) }))
    } finally {
      if (this.running.get(panel.id) === abort) this.running.delete(panel.id)
    }
  }

  /** Condense transcripts that don't fit the provider's context (map step with the fast model). */
  private async fitTranscript(documentId: string, transcript: string, lecture: boolean, provider: LlmProvider, signal: AbortSignal): Promise<string> {
    const budget = Math.floor(provider.maxInputChars * 0.8)
    if (transcript.length <= budget) return transcript
    const parts = splitByLines(transcript, Math.max(4_000, Math.floor(budget / 2)))
    const condensed: string[] = []
    for (const [i, part] of parts.entries()) {
      const notes = await provider.generate({
        tier: 'fast',
        system: condenseSystemPrompt(lecture),
        messages: [{ role: 'user', content: `Transcript part ${i + 1} of ${parts.length}:\n\n${part}` }],
        maxTokens: 2_000,
        signal,
        onUsage: meter(this.deps.recordUsage, 'condense', { document_id: documentId })
      })
      condensed.push(`(Condensed notes for transcript part ${i + 1} of ${parts.length})\n${notes.trim()}`)
    }
    return condensed.join('\n\n')
  }

  private async autoTitle(documentId: string, content: string, provider: LlmProvider): Promise<void> {
    try {
      const title = await provider.generate({
        tier: 'fast',
        system: TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: content.slice(0, 6_000) }],
        maxTokens: 64,
        onUsage: meter(this.deps.recordUsage, 'note-title', { document_id: documentId })
      })
      const clean = title.replace(/^["'#\s]+|["'.\s]+$/g, '').split('\n')[0].slice(0, 80)
      const doc = this.deps.store.getDocument(documentId)
      if (clean && doc && !doc.title.trim()) {
        this.deps.store.updateDocument(documentId, { title: clean })
        this.deps.emitDocumentChanged(documentId)
      }
    } catch {
      // Titles are best-effort.
    }
  }

  cancel(panelId: string): void {
    this.running.get(panelId)?.abort()
  }
}
