import type { ToolCallOutput } from '@shared/agent'
import type { ChatAttachment, ChatMessage, ChatMessageContext, ChatThread } from '@shared/types'
import { AUTO_MODEL } from '@shared/models'
import { formatTranscript } from '@shared/transcript'
import { promptSpeakers } from '../ai/variables'
import type { Store } from '../db/store'
import type { AgentRun, AgentStore } from '../db/agent-store'
import type { SettingsService } from '../settings'
import { chatProviderConfig, createProviderFromConfig } from '../llm'
import { llmUsageEvent } from '../usage'
import type { AttachmentRef, LlmProvider, ModelMessage, ProviderConfig } from '../llm/provider'
import type { AttachmentService } from '../attachments/service'
import type { AgentBackend, RunKindHandler } from './backend'
import type { AgentFiles } from './files'
import { CHAT_TITLE_SYSTEM_PROMPT, DETAILED_RESPONSE_NOTE, chatSystemPrompt, chatTurnPreamble } from './prompts'
import { toolsFor } from './tools'
import { meetingDate } from './tools/meetings'

export interface ChatAgentDeps {
  store: Store
  agentStore: AgentStore
  backend: AgentBackend
  settings: SettingsService
  files: AgentFiles
  attachments?: AttachmentService | null
  emitMessage(m: ChatMessage): void
  emitThread?(t: ChatThread): void
  /** For thread titles; tests pass a scripted model. */
  createProvider?(config: ProviderConfig): LlmProvider
}

export interface ChatSendInput {
  threadId?: string | null
  documentId?: string | null
  text: string
  /** Draft files from the chat bar (or, when editing, the edited message's own files). */
  attachmentIds?: string[]
  /** 'auto' or `provider/model`; defaults to the thread's last choice. */
  model?: string | null
  mentions?: { id: string; title: string }[]
  selectedText?: string | null
  /** Re-send this user message with new content; everything after it is dropped. */
  editMessageId?: string | null
  responseStyle?: 'detailed' | null
}

function attachmentRef(a: ChatAttachment): AttachmentRef {
  return { id: a.id, name: a.name, mime: a.mime, kind: a.kind, size: a.size, pages: a.pages, textChars: a.text_chars }
}

/**
 * Ask Cereal, per note and across notes: the agentic chat (Granola's chat-with-documents). Each question is a run
 * of the agent loop with the read, draft and (in a note) note-editing tools; the answer, its tool calls and
 * citations stream into the assistant message's outputs. Files, @-mentions and selected text travel with the
 * question (docs/granola-chat-bar.md §9).
 */
export class ChatAgent implements RunKindHandler {
  constructor(private readonly deps: ChatAgentDeps) {
    deps.backend.handlers.chat = this
  }

  /** Expand "/recipe-slug extra text" into the recipe's prompt, counting the use. */
  private expandRecipe(text: string): string {
    const m = text.match(/^\/([a-z0-9-]+)\s*([\s\S]*)$/i)
    if (!m) return text
    const recipe = this.deps.store.listRecipes().find((r) => r.slug === m[1].toLowerCase())
    if (!recipe) return text
    this.deps.store.recordRecipeUse(recipe.id)
    return `${recipe.prompt}${m[2] ? `\n\n${m[2]}` : ''}`
  }

  /** The files a message may carry: drafts, or (when editing) the edited message's own files. All must be ready. */
  private sendableAttachments(ids: string[], editMessageId: string | null): ChatAttachment[] {
    const out: ChatAttachment[] = []
    for (const id of ids) {
      const a = this.deps.store.getAttachment(id)
      if (!a || (a.message_id && a.message_id !== editMessageId)) throw new Error('One of the attached files is no longer available. Remove it and attach it again.')
      if (a.status === 'processing') throw new Error(`Wait for ${a.name} to finish loading.`)
      if (a.status === 'failed') throw new Error(a.error ?? `${a.name} couldn’t be read. Remove it to send.`)
      out.push(a)
    }
    return out
  }

  send(input: ChatSendInput): { threadId: string; messageId: string } {
    const { store, agentStore, backend } = this.deps
    const text = input.text.trim()
    const attachmentIds = [...new Set(input.attachmentIds ?? [])]
    if (!text && !attachmentIds.length) throw new Error('Type a question first.')
    let thread = input.threadId ? store.getThread(input.threadId) : null
    const choice = input.model ?? thread?.model ?? AUTO_MODEL
    chatProviderConfig(this.deps.settings, choice) // a friendly configuration error before anything is created
    const editing = input.editMessageId && thread ? store.getMessage(input.editMessageId) : null
    if (input.editMessageId && (!editing || editing.thread_id !== thread?.id || editing.role !== 'user')) throw new Error('That message can no longer be edited.')
    const files = this.sendableAttachments(attachmentIds, editing?.id ?? null)

    if (thread) {
      const active = agentStore.activeRunForThread(thread.id)
      // A new question declines anything still waiting for approval, as in Granola; a streaming answer must finish
      // first, unless the question replaces an earlier one (edit or retry).
      if (active && (active.status === 'waiting' || editing)) backend.cancelRun(active.id)
      else if (active) throw new Error('Wait for the current answer to finish, or stop it.')
    } else {
      thread = store.createThread(input.documentId ?? null, (text || files[0]?.name || 'Chat').slice(0, 80), choice)
    }
    if (thread.model !== choice) thread = store.updateThread(thread.id, { model: choice }) ?? thread

    // Threads from before the agent have no model transcript yet: seed it from their messages.
    if (!agentStore.transcript(thread.id).length && !editing) this.seedTranscript(thread.id, store.listMessages(thread.id))
    if (editing) this.rewind(thread.id, editing, attachmentIds)

    const mentions = (input.mentions ?? []).filter((m, i, all) => m.id && all.findIndex((x) => x.id === m.id) === i)
    const context: ChatMessageContext | null =
      mentions.length || input.selectedText || input.responseStyle ? { mentions, selectedText: input.selectedText?.trim() || null, responseStyle: input.responseStyle ?? null } : null
    const userMsg = store.addMessage(thread.id, 'user', text, 'completed', { id: editing?.id, context })
    if (files.length) store.bindAttachments(files.map((f) => f.id), thread.id, userMsg.id)
    this.deps.emitMessage(store.getMessage(userMsg.id)!)
    const reply = store.addMessage(thread.id, 'assistant', '', 'in_progress')
    this.deps.emitMessage(reply)

    const numbered = mentions.map((m) => ({ ...m, n: agentStore.sourceNumber(thread.id, m.id, m.title) }))
    const preamble = chatTurnPreamble({ mentions: numbered, selectedText: context?.selectedText ?? null })
    const question = this.expandRecipe(text) || 'Look at the attached files.'
    const content = [preamble, question, input.responseStyle === 'detailed' && DETAILED_RESPONSE_NOTE].filter(Boolean).join('\n\n')
    const turn: ModelMessage = { role: 'user', content, messageId: userMsg.id, ...(files.length ? { attachments: files.map(attachmentRef) } : {}) }
    agentStore.appendTranscript(thread.id, [turn])
    backend.createRun({ kind: 'chat', threadId: thread.id, messageId: reply.id, context: thread.document_id ? 'note-chat' : 'global-chat', llm: choice })
    return { threadId: thread.id, messageId: reply.id }
  }

  /** Ask the last question again (after an error), replacing the failed answer. */
  retry(threadId: string): { threadId: string; messageId: string } {
    const messages = this.deps.store.listMessages(threadId)
    const last = [...messages].reverse().find((m) => m.role === 'user')
    if (!last) throw new Error('There is nothing to retry in this chat.')
    return this.send({
      threadId,
      editMessageId: last.id,
      text: last.content,
      attachmentIds: last.attachments.map((a) => a.id),
      mentions: last.context?.mentions,
      selectedText: last.context?.selectedText,
      responseStyle: last.context?.responseStyle
    })
  }

  private seedTranscript(threadId: string, history: ChatMessage[]): void {
    const turns: ModelMessage[] = history
      .filter((m) => m.content && !m.error)
      .map((m) => (m.role === 'user' ? { role: 'user' as const, content: m.content, messageId: m.id } : { role: 'assistant' as const, blocks: [{ type: 'text' as const, text: m.content }] }))
    this.deps.agentStore.appendTranscript(threadId, turns)
  }

  /**
   * Editing a sent message: drop it and everything after it, in the chat and in the model transcript. The
   * transcript restarts (a new epoch) from the turns before the edited one, unchanged so the model's replayed
   * reasoning stays valid; if those turns were compacted away, it is rebuilt from the earlier messages.
   */
  private rewind(threadId: string, editing: ChatMessage, keepAttachmentIds: string[]): void {
    const { store, agentStore } = this.deps
    const transcript = agentStore.transcript(threadId)
    const at = transcript.findIndex((m) => m.role === 'user' && m.messageId === editing.id)
    const messages = store.listMessages(threadId)
    if (at >= 0) {
      agentStore.startEpoch(threadId, transcript.slice(0, at))
    } else {
      agentStore.startEpoch(threadId, [])
      this.seedTranscript(threadId, messages.slice(0, messages.findIndex((m) => m.id === editing.id)))
    }
    // The edited message's id is reused, so the files it keeps stay bound to it; every other file goes.
    const keep = new Set(keepAttachmentIds)
    const dropped = store.truncateThreadFrom(threadId, editing.id).flatMap((id) => store.messageAttachments(id)).filter((a) => !keep.has(a.id))
    for (const a of dropped) {
      if (this.deps.attachments) this.deps.attachments.remove(a.id)
      else store.deleteAttachment(a.id)
    }
  }

  prepare(run: AgentRun, maxInputChars: number): ReturnType<RunKindHandler['prepare']> {
    const { store, settings, files } = this.deps
    const thread = store.getThread(run.thread_id)
    const doc = thread?.document_id ? store.getDocument(thread.document_id) : null
    let note = null
    if (doc) {
      const chunks = store.getTranscript(doc.id)
      const transcript = formatTranscript(chunks, { speakers: promptSpeakers(doc, chunks, settings.get()) })
      const panels = store.listPanels(doc.id).filter((p) => p.content)
      note = {
        id: doc.id,
        title: doc.title || 'Untitled',
        date: new Date(meetingDate(doc)).toDateString(),
        mode: doc.mode,
        notes: doc.notes_markdown,
        enhanced: panels[panels.length - 1]?.content ?? '',
        // Small transcripts go straight into the prompt; long ones are paged in with readTranscript.
        transcript: transcript.length <= maxInputChars * 0.4 ? transcript : null,
        transcriptLines: transcript ? transcript.split('\n').length : 0
      }
      // The open note is always source [1] of its chat.
      this.deps.agentStore.sourceNumber(run.thread_id, doc.id, note.title)
    }
    const docs = store.listDocuments({ limit: 1000 })
    const system = chatSystemPrompt({
      note,
      settings: settings.get(),
      meetingCount: docs.length,
      recent: doc ? [] : docs.slice(0, 8).map((d) => ({ id: d.id, title: d.title || 'Untitled', date: new Date(meetingDate(d)).toDateString() })),
      skills: files.skills().skills
    })
    return { system, tools: toolsFor(run.context), maxSteps: 12 }
  }

  /** After the first answer of a thread, give the thread a title (Granola titles threads after the first reply). */
  finished(run: AgentRun): void {
    if (run.status !== 'completed') return
    const messages = this.deps.store.listMessages(run.thread_id)
    if (messages.length !== 2 || messages[1].role !== 'assistant' || !messages[1].content) return
    void this.titleThread(run.thread_id, messages[0], messages[1])
  }

  private async titleThread(threadId: string, question: ChatMessage, answer: ChatMessage): Promise<void> {
    const { store, settings } = this.deps
    try {
      const thread = store.getThread(threadId)
      if (!thread) return
      const provider = (this.deps.createProvider ?? createProviderFromConfig)(chatProviderConfig(settings, thread.model))
      const asked = question.content || question.attachments.map((a) => a.name).join(', ')
      const raw = await provider.generate({
        tier: 'fast',
        system: CHAT_TITLE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Question: ${asked}\n\nAnswer (start): ${answer.content.slice(0, 1500)}` }],
        maxTokens: 64,
        onUsage: (r) => this.deps.backend.recordUsage(llmUsageEvent(r, 'chat-title', { thread_id: threadId }))
      })
      // Models sometimes add quotes, a heading or a list marker.
      const title = raw.trim().split('\n')[0].replace(/^(?:[-*•]\s+|#+\s*|["'“”]+)+|["'“”.\s]+$/g, '').slice(0, 80)
      if (!title) return
      const updated = store.updateThread(threadId, { title })
      if (updated) this.deps.emitThread?.(updated)
    } catch {
      // The thread keeps its first-question title.
    }
  }

  /** Stop the answer a message is waiting on. */
  stop(messageId: string): void {
    const message = this.deps.store.getMessage(messageId)
    if (!message) return
    const run = this.deps.agentStore.activeRunForThread(message.thread_id)
    if (run && run.message_id === messageId) this.deps.backend.cancelRun(run.id)
  }

  /** The renderer applied (or undid) a client-side tool like editMeetingNotes. */
  toolApplied(messageId: string, toolCallId: string, patch: Pick<ToolCallOutput, 'applied' | 'reverted'>): ChatMessage {
    const message = this.deps.store.getMessage(messageId)
    if (!message) throw new Error('Message not found')
    const outputs = message.outputs.map((o) => (o.type === 'tool_call' && o.id === toolCallId ? { ...o, ...patch } : o))
    const updated = this.deps.store.updateMessage(messageId, { outputs })
    this.deps.emitMessage(updated)
    return updated
  }

  deleteThread(threadId: string): void {
    const run = this.deps.agentStore.activeRunForThread(threadId)
    if (run) this.deps.backend.cancelRun(run.id)
    const cleanup = this.deps.attachments?.forThreadDeletion(threadId)
    this.deps.store.deleteThread(threadId)
    this.deps.agentStore.deleteThreadData(threadId)
    cleanup?.()
  }
}
