// Domain types shared by main, preload and renderer.
// Field names follow the shapes observed in Granola (see docs/granola-findings.md §3, §5).
import type { AgentOutput, MessageStatus } from './agent'
import type { AttachmentKind, AttachmentStatus } from './attachments'
import type { PMNode } from './markdown'

export type TranscriptSource = 'microphone' | 'system'

/** How a note is recorded: a call (mic + system audio) or an in-person lecture (mic only, the mic hears the speaker). */
export type NoteMode = 'meeting' | 'lecture'

export interface TranscriptChunk {
  id: string
  document_id: string
  source: TranscriptSource
  text: string
  /** ISO timestamps, like Granola's chunk shape. */
  start_timestamp: string
  end_timestamp: string
  is_final: boolean
  /** Raw diarized label from the engine (e.g. "0"), scoped to `speaker_session`; null when the engine doesn't diarize. */
  speaker?: string | null
  /** The transcription session that produced `speaker`: one engine connection (docs/notion-speakers.md §2). */
  speaker_session?: string | null
}

/** A name the user gave a diarized speaker, keyed by `speakerKey()` ("<source>:<session>:<label>"). */
export interface SpeakerAssignment {
  name: string
  email?: string
  /** The note-taker: labelled like the user's own mic ("You" in the app, "<name> (me)" for the model). */
  self?: boolean
}

export interface Attendee {
  name: string
  email: string
  organizer?: boolean
  self?: boolean
}

export interface CalendarEvent {
  id: string
  title: string
  start: string
  end: string
  attendees: Attendee[]
  location?: string
  meetingUrl?: string
  description?: string
  htmlLink?: string
}

export interface DocumentSummary {
  id: string
  title: string
  created_at: string
  updated_at: string
  calendar_event: CalendarEvent | null
  folder_ids: string[]
  mode: NoteMode
  has_transcript: boolean
  has_panels: boolean
  preview: string
}

export interface CerealDocument {
  id: string
  title: string
  created_at: string
  updated_at: string
  deleted_at: string | null
  /** TipTap / ProseMirror JSON of the user's notepad. */
  notes: unknown | null
  notes_plain: string
  notes_markdown: string
  calendar_event: CalendarEvent | null
  people: Attendee[]
  selected_template: string | null
  mode: NoteMode
  folder_ids: string[]
  /** User-identified speakers, by speaker key. */
  speakers: Record<string, SpeakerAssignment>
}

export type DocumentPatch = Partial<
  Pick<CerealDocument, 'title' | 'notes' | 'notes_plain' | 'notes_markdown' | 'calendar_event' | 'people' | 'selected_template' | 'mode'>
> & {
  /** Merged into the note's speakers; null clears that speaker's name. */
  speakers?: Record<string, SpeakerAssignment | null>
}

export interface Panel {
  id: string
  document_id: string
  title: string
  template_slug: string
  /** Markdown: the model's output while generating, then kept in sync with `content_json` as the user edits. */
  content: string
  /** The editable notes (TipTap JSON) once generation has finished; derived from `content` until first edited. */
  content_json: PMNode | null
  /** Trimmed texts of the lines the AI wrote (rather than taken from the user's notes); shown grey. */
  generated_lines: string[]
  created_at: string
  updated_at: string
  generation_started_at: string | null
  generation_finished_at: string | null
  generation_failed_at: string | null
  error: string | null
}

export interface TemplateSection {
  heading: string
  section_description: string
}

export interface Template {
  slug: string
  title: string
  description: string
  sections: TemplateSection[]
  builtin: boolean
  updated_at: string
}

export interface Recipe {
  id: string
  slug: string
  name: string
  prompt: string
  /** One line shown under the name in the recipe menu. */
  description: string
  builtin: boolean
  updated_at: string
  usage_count: number
  last_used_at: string | null
}

export interface Folder {
  id: string
  title: string
  created_at: string
  document_count: number
}

export interface ChatThread {
  id: string
  document_id: string | null
  title: string
  /** The model this thread last answered with: 'auto' or `provider/model` (see shared/models.ts). */
  model: string | null
  created_at: string
  updated_at: string
}

/** A file added in the chat bar. Drafts have no thread until the message that carries them is sent. */
export interface ChatAttachment {
  id: string
  thread_id: string | null
  message_id: string | null
  name: string
  mime: string
  kind: AttachmentKind
  size: number
  /** PDF page count. */
  pages: number | null
  status: AttachmentStatus
  error: string | null
  /** Length of the extracted text, used to budget the model's context. */
  text_chars: number
  created_at: string
}

/** What a user message referred to besides its text (shown as chips under it). */
export interface ChatMessageContext {
  mentions: { id: string; title: string }[]
  selectedText: string | null
  responseStyle?: 'detailed' | null
}

export interface ChatCitation {
  /** The [n] marker used in the answer. */
  n: number
  document_id: string
  title: string
}

export interface ChatMessage {
  id: string
  thread_id: string
  role: 'user' | 'assistant'
  /** The answer text (the text outputs joined), kept for search, history and copying. */
  content: string
  citations: ChatCitation[]
  /** What the agent did while answering: reasoning, tool calls and text, in order (Granola's chat_message.outputs). */
  outputs: AgentOutput[]
  status: MessageStatus
  created_at: string
  error: string | null
  attachments: ChatAttachment[]
  context: ChatMessageContext | null
}

export interface SearchHit {
  document_id: string
  title: string
  snippet: string
  created_at: string
}

export type RecordingStatus = 'idle' | 'starting' | 'recording' | 'stopping'

export interface RecordingState {
  status: RecordingStatus
  document_id: string | null
  started_at: string | null
  engine: TranscriptionEngineId | null
  sources: TranscriptSource[]
  error: string | null
  warnings: string[]
}

export type TranscriptionEngineId = 'deepgram' | 'whisper'
export type LlmProviderId = 'anthropic' | 'openai' | 'gemini' | 'ollama'

export interface Settings {
  transcription: {
    engine: TranscriptionEngineId
    /** BCP-47 language code, or 'multi' for Deepgram multilingual. */
    language: string
    deepgramModel: string
    whisperModel: string
    whisperServerPath: string
    whisperThreads: number
    /** Ask the engine to tell voices apart within each audio stream (Deepgram only). */
    diarize: boolean
  }
  llm: {
    provider: LlmProviderId
    anthropicModel: string
    anthropicFastModel: string
    openaiModel: string
    openaiFastModel: string
    geminiModel: string
    geminiFastModel: string
    ollamaModel: string
    ollamaUrl: string
  }
  chat: {
    /** What Enter does in the chat bar: send (Shift+Enter for a new line), or add a new line (Ctrl+Enter sends). */
    enterKey: 'send' | 'newline'
    /** The model picked for single-note chats and for chats across notes: 'auto' or `provider/model`. */
    modelSingle: string
    modelMulti: string
  }
  audio: {
    captureSystem: boolean
    /** PipeWire node name or null for the default device. */
    micTarget: string | null
    systemTarget: string | null
    playSounds: boolean
  }
  profile: {
    name: string
    email: string
    company: string
    jobTitle: string
  }
  dictionary: string[]
  calendar: {
    googleClientId: string
    connected: boolean
    notifyMinutesBefore: number
  }
  detection: {
    enabled: boolean
  }
  enhance: {
    autoEnhanceOnStop: boolean
    defaultTemplate: string
  }
  assistant: {
    enabled: boolean
    /** Standing instructions from the user, added to every Assistant prompt. */
    instructions: string
    /** Tools the user chose to always allow without asking. */
    alwaysAllow: string[]
  }
  theme: 'system' | 'light' | 'dark'
}

export type SecretName =
  | 'anthropicApiKey'
  | 'openaiApiKey'
  | 'geminiApiKey'
  | 'deepgramApiKey'
  | 'googleClientSecret'
  | 'googleRefreshToken'

/** Keys the user supplies in Cereal's .env file; the app never writes them. */
export type EnvSecretName = Exclude<SecretName, 'googleRefreshToken'>

export type SecretStatus = Record<SecretName, boolean>

export interface AudioDevice {
  name: string
  description: string
  kind: 'source' | 'sink'
  isDefault: boolean
}

export interface WhisperModelInfo {
  id: string
  label: string
  sizeMb: number
  downloaded: boolean
  downloading: boolean
  progress: number
}

export interface EnvironmentStatus {
  pwRecord: boolean
  pwDump: boolean
  whisperServer: string | null
  safeStorage: boolean
  envFile: string
}
