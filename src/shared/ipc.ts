// Typed IPC contract. Channel names follow the `domain:action` convention observed in Granola.
import type { AgentEventRecord, AgentFileEntry, AgentHome, AgentMessage, AgentRoutine, AgentSkill, AgentThread, AssistantSnapshot } from './agent'
import type { ChatModels } from './models'
import type { PMNode } from './markdown'
import type { UsageRange, UsageSummary } from './usage'
import type {
  AudioDevice,
  CalendarEvent,
  CerealDocument,
  ChatAttachment,
  ChatCitation,
  ChatMessage,
  ChatThread,
  DocumentPatch,
  DocumentSummary,
  EnvironmentStatus,
  Folder,
  NoteMode,
  Panel,
  Recipe,
  RecordingState,
  SearchHit,
  SecretStatus,
  Settings,
  Template,
  TranscriptChunk,
  WhisperModelInfo,
  LlmProviderId
} from './types'

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

/** Request/response channels: renderer → main via ipcRenderer.invoke. */
export interface InvokeMap {
  'documents:list': (query?: { folderId?: string | null; limit?: number }) => DocumentSummary[]
  'documents:get': (id: string) => CerealDocument | null
  'documents:create': (init?: { title?: string; calendar_event?: CalendarEvent | null; folder_id?: string | null; mode?: NoteMode }) => CerealDocument
  'documents:update': (id: string, patch: DocumentPatch) => CerealDocument
  'documents:delete': (id: string) => void
  'documents:for-event': (event: CalendarEvent) => CerealDocument

  'transcript:get': (documentId: string) => TranscriptChunk[]
  'transcript:clear': (documentId: string) => void

  'recording:start': (documentId: string) => RecordingState
  'recording:stop': () => RecordingState
  'recording:state': () => RecordingState

  'panels:list': (documentId: string) => Panel[]
  'panels:enhance': (documentId: string, templateSlug?: string | null) => Panel
  'panels:rewrite': (panelId: string, instructions: string) => Panel
  'panels:delete': (panelId: string) => void
  /** Save the user's edits to finished enhanced notes. */
  'panels:update': (panelId: string, patch: { content_json: PMNode }) => Panel
  /** Explain where one line of the enhanced notes came from ("Transcript Summary"); streams `transcript-summary:update`. */
  'transcript-summary:start': (requestId: string, documentId: string, line: string) => void
  'transcript-summary:cancel': (requestId: string) => void

  'folders:list': () => Folder[]
  'folders:create': (title: string) => Folder
  'folders:rename': (id: string, title: string) => void
  'folders:delete': (id: string) => void
  'folders:add-document': (folderId: string, documentId: string) => void
  'folders:remove-document': (folderId: string, documentId: string) => void

  'templates:list': () => Template[]
  'templates:upsert': (template: Omit<Template, 'builtin' | 'updated_at'>) => Template
  'templates:delete': (slug: string) => void

  'recipes:list': () => Recipe[]
  'recipes:upsert': (recipe: { id?: string; name: string; slug: string; prompt: string; description?: string }) => Recipe
  'recipes:delete': (id: string) => void

  'chat:threads': (documentId: string | null) => ChatThread[]
  'chat:messages': (threadId: string) => ChatMessage[]
  'chat:send': (input: ChatSendRequest) => { threadId: string; messageId: string }
  /** Ask the thread's last question again, replacing the failed or stopped answer. */
  'chat:retry': (threadId: string) => { threadId: string; messageId: string }
  /** Add a file from the chat bar. It starts as a draft (`processing`); `chat:attachment` reports when it's ready. */
  'chat:attach': (input: { documentId: string | null; threadId?: string | null; draftIds?: string[]; name: string; type: string; bytes: Uint8Array }) => ChatAttachment
  'chat:remove-attachment': (id: string) => void
  /** The model picker's list (docs/granola-chat-bar.md §6). */
  'chat:models': () => ChatModels
  /** Notes for the @ menu, by title. */
  'chat:mention-search': (q: string, exclude?: string[]) => { id: string; title: string; created_at: string }[]
  /** Transcribe a dictated question (mono float samples) with the transcription engine from Settings. */
  'dictation:transcribe': (audio: { samples: Float32Array; sampleRate: number }) => { text: string }
  'chat:delete-thread': (threadId: string) => void
  'chat:stop': (messageId: string) => void
  /** The renderer applied or undid a client-side tool call (editMeetingNotes). */
  'chat:tool-applied': (messageId: string, toolCallId: string, patch: { applied?: boolean | null; reverted?: boolean }) => ChatMessage

  'agent:decide': (approvalId: string, decision: 'approved' | 'denied', always?: boolean) => void
  /** A run's events after a sequence number, to catch up on a stream (Keto's keto-socket `afterSequence`). */
  'agent:events': (runId: string, afterSequence: number) => AgentEventRecord[]
  /** The meetings a thread's answers cite, by their [n] numbers. */
  'agent:sources': (threadId: string) => ChatCitation[]

  'assistant:open': () => AssistantSnapshot
  'assistant:thread': (threadId: string) => { thread: AgentThread; messages: AgentMessage[] }
  'assistant:send': (input: { threadId?: string | null; text: string; clientMessageId?: string }) => AgentMessage
  'assistant:stop': (threadId: string) => void
  'assistant:task-stop': (taskId: string) => AgentThread
  'assistant:routines': () => AgentRoutine[]
  'assistant:routine-update': (id: string, patch: { enabled: boolean }) => AgentRoutine
  'assistant:routine-delete': (id: string) => void
  'assistant:skills': () => { skills: AgentSkill[]; errors: { path: string; message: string }[] }
  'assistant:files': (path: string) => AgentFileEntry[]
  'assistant:file-read': (path: string) => { content: string; truncated: boolean; size: number }
  'assistant:open-folder': (path?: string) => void
  'assistant:reset': () => AssistantSnapshot

  'search:query': (q: string) => SearchHit[]

  'settings:get': () => Settings
  'settings:update': (patch: DeepPartial<Settings>) => Settings
  'secrets:status': () => SecretStatus
  'secrets:open-env': () => void

  'llm:test': (provider: LlmProviderId) => { ok: boolean; message: string }
  'llm:models': (provider: LlmProviderId) => string[]

  'asr:models': () => WhisperModelInfo[]
  'asr:download': (modelId: string) => void
  'asr:delete': (modelId: string) => void
  'asr:test-deepgram': () => { ok: boolean; message: string }

  'audio:devices': () => AudioDevice[]
  'env:status': () => EnvironmentStatus

  /** API usage and its estimated cost (Settings → Usage). */
  'usage:summary': (range: UsageRange) => UsageSummary
  /** Open pricing.json (created if missing), where prices can be overridden. */
  'usage:open-pricing': () => void

  'calendar:connect': () => { ok: boolean; message: string }
  'calendar:disconnect': () => void
  'calendar:upcoming': () => CalendarEvent[]
  'calendar:sync': () => CalendarEvent[]

  'app:open-external': (url: string) => void
  'app:focus-main': (route?: string) => void
  'app:quit': () => void
  /** Match the window background and title bar controls to the renderer's theme. */
  'window:chrome': (theme: { dark: boolean }) => void
  /** The floating widget reports its content size so its window can fit it. */
  'widget:resize': (size: { width: number; height: number }) => void
  'widget:action': (action: 'start' | 'dismiss' | 'open') => void
  'widget:state': () => WidgetState
}

/** What the chat bar sends (docs/granola-chat-bar.md §9). */
export interface ChatSendRequest {
  threadId?: string | null
  documentId?: string | null
  text: string
  attachmentIds?: string[]
  /** 'auto' or `provider/model`. */
  model?: string | null
  mentions?: { id: string; title: string }[]
  selectedText?: string | null
  editMessageId?: string | null
  responseStyle?: 'detailed' | null
}

/** What the floating widget ("nub") shows: the live recording pill, or a prompt for a detected meeting. */
export type WidgetState = { mode: 'recording'; documentId: string | null } | { mode: 'prompt'; title: string | null; app: string }

/** Push channels: main → renderer via webContents.send. */
export interface EventMap {
  'transcript:chunks': { documentId: string; chunks: TranscriptChunk[] }
  'recording:state': RecordingState
  'audio:levels': { microphone: number; system: number }
  'panel:updated': Panel
  'transcript-summary:update': TranscriptSummaryUpdate
  'chat:message': ChatMessage
  'chat:attachment': ChatAttachment
  'chat:thread': ChatThread
  'documents:changed': { id: string | null }
  'folders:changed': null
  'navigate': { route: string }
  'asr:models-changed': WhisperModelInfo[]
  'calendar:changed': CalendarEvent[]
  'meeting:detected': { app: string }
  'settings:changed': Settings
  'agent:event': AgentEventRecord
  'assistant:message': AgentMessage
  'assistant:thread': AgentThread
  'assistant:home': AgentHome | null
  'assistant:routines-changed': null
  'widget:state': WidgetState
}

/** The text so far (not a delta) of a Transcript Summary request. */
export interface TranscriptSummaryUpdate {
  requestId: string
  text: string
  done: boolean
  error: string | null
}

export type InvokeChannel = keyof InvokeMap
export type EventChannel = keyof EventMap

export const INVOKE_CHANNELS = [
  'documents:list', 'documents:get', 'documents:create', 'documents:update', 'documents:delete', 'documents:for-event',
  'transcript:get', 'transcript:clear',
  'recording:start', 'recording:stop', 'recording:state',
  'panels:list', 'panels:enhance', 'panels:rewrite', 'panels:delete', 'panels:update',
  'transcript-summary:start', 'transcript-summary:cancel',
  'folders:list', 'folders:create', 'folders:rename', 'folders:delete', 'folders:add-document', 'folders:remove-document',
  'templates:list', 'templates:upsert', 'templates:delete',
  'recipes:list', 'recipes:upsert', 'recipes:delete',
  'chat:threads', 'chat:messages', 'chat:send', 'chat:delete-thread', 'chat:stop', 'chat:tool-applied',
  'chat:retry', 'chat:attach', 'chat:remove-attachment', 'chat:models', 'chat:mention-search', 'dictation:transcribe',
  'agent:decide', 'agent:events', 'agent:sources',
  'assistant:open', 'assistant:thread', 'assistant:send', 'assistant:stop', 'assistant:task-stop',
  'assistant:routines', 'assistant:routine-update', 'assistant:routine-delete', 'assistant:skills',
  'assistant:files', 'assistant:file-read', 'assistant:open-folder', 'assistant:reset',
  'search:query',
  'settings:get', 'settings:update', 'secrets:status', 'secrets:open-env',
  'llm:test', 'llm:models',
  'asr:models', 'asr:download', 'asr:delete', 'asr:test-deepgram',
  'audio:devices', 'env:status', 'usage:summary', 'usage:open-pricing',
  'calendar:connect', 'calendar:disconnect', 'calendar:upcoming', 'calendar:sync',
  'app:open-external', 'app:focus-main', 'app:quit', 'window:chrome', 'widget:resize', 'widget:action', 'widget:state'
] as const satisfies readonly InvokeChannel[]

export const EVENT_CHANNELS = [
  'transcript:chunks', 'recording:state', 'audio:levels', 'panel:updated', 'transcript-summary:update', 'chat:message', 'chat:attachment', 'chat:thread', 'documents:changed',
  'folders:changed', 'navigate', 'asr:models-changed', 'calendar:changed', 'meeting:detected', 'settings:changed',
  'agent:event', 'assistant:message', 'assistant:thread', 'assistant:home', 'assistant:routines-changed', 'widget:state'
] as const satisfies readonly EventChannel[]

export interface CerealBridge {
  invoke<K extends InvokeChannel>(channel: K, ...args: Parameters<InvokeMap[K]>): Promise<Awaited<ReturnType<InvokeMap[K]>>>
  on<K extends EventChannel>(channel: K, listener: (payload: EventMap[K]) => void): () => void
  platform: string
}
