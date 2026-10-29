// Schema migrations, applied in order. Trimmed from the tables observed in Granola (docs/granola-findings.md §5).
import type { DB } from './index'
import { generatedLineTexts } from '@shared/attribution'

export const MIGRATIONS: (string | ((db: DB) => void))[] = [
  `
  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    notes TEXT,
    notes_plain TEXT NOT NULL DEFAULT '',
    notes_markdown TEXT NOT NULL DEFAULT '',
    calendar_event TEXT,
    people TEXT NOT NULL DEFAULT '[]',
    selected_template TEXT
  );
  CREATE INDEX documents_created_idx ON documents(created_at);
  CREATE INDEX documents_event_idx ON documents(json_extract(calendar_event, '$.id'));

  CREATE TABLE document_panels (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    template_slug TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    generated_lines TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    generation_started_at TEXT,
    generation_finished_at TEXT,
    generation_failed_at TEXT,
    error TEXT
  );
  CREATE INDEX panels_document_idx ON document_panels(document_id);

  CREATE TABLE transcript_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('microphone', 'system')),
    text TEXT NOT NULL,
    start_timestamp TEXT NOT NULL,
    end_timestamp TEXT NOT NULL,
    is_final INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX chunks_document_idx ON transcript_chunks(document_id, start_timestamp);

  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE folder_documents (
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL,
    PRIMARY KEY (folder_id, document_id)
  );

  CREATE TABLE templates (
    slug TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sections TEXT NOT NULL DEFAULT '[]',
    builtin INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE recipes (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE chat_threads (
    id TEXT PRIMARY KEY,
    document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    citations TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    error TEXT
  );
  CREATE INDEX messages_thread_idx ON chat_messages(thread_id, created_at);

  CREATE TABLE calendar_events (
    id TEXT PRIMARY KEY,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX calendar_start_idx ON calendar_events(start_time);

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE documents_fts USING fts5(
    document_id UNINDEXED,
    title,
    notes,
    transcript,
    panels,
    tokenize = 'porter unicode61'
  );
  `,
  `
  ALTER TABLE documents ADD COLUMN mode TEXT NOT NULL DEFAULT 'meeting' CHECK (mode IN ('meeting', 'lecture'));
  `,
  // The agent (docs/granola-findings.md §11): chat message outputs, the Assistant's threads, runs, sequenced
  // events, inbox, routines and approvals, plus the append-only model transcript every agent thread replays.
  `
  ALTER TABLE chat_messages ADD COLUMN outputs TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE chat_messages ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';

  CREATE TABLE agent_threads (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('conversation', 'task')),
    parent_thread_id TEXT REFERENCES agent_threads(id) ON DELETE CASCADE,
    follows_thread_id TEXT,
    title TEXT,
    summary TEXT,
    status TEXT,
    lifetime TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    result_message_id TEXT,
    pending_approval TEXT,
    archived_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX agent_threads_parent_idx ON agent_threads(parent_thread_id, created_at);

  CREATE TABLE agent_messages (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('user', 'agent', 'parent')),
    text TEXT NOT NULL DEFAULT '',
    outputs TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL,
    error TEXT,
    client_message_id TEXT,
    applied_sequence INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX agent_messages_seq_idx ON agent_messages(thread_id, sequence);

  CREATE TABLE agent_model_messages (
    thread_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, epoch, sequence)
  );

  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('chat', 'assistant')),
    thread_id TEXT NOT NULL,
    message_id TEXT,
    context TEXT NOT NULL,
    status TEXT NOT NULL,
    input TEXT,
    pending TEXT,
    error TEXT,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );
  CREATE INDEX agent_runs_thread_idx ON agent_runs(thread_id, created_at);
  CREATE INDEX agent_runs_status_idx ON agent_runs(status);

  CREATE TABLE agent_events (
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
  );

  CREATE TABLE agent_inbox (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('user', 'parent', 'child', 'scheduler', 'event')),
    message TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('immediate', 'batch', 'idle')),
    available_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX agent_inbox_thread_idx ON agent_inbox(thread_id, available_at);

  CREATE TABLE agent_schedules (
    id TEXT PRIMARY KEY,
    task_thread_id TEXT REFERENCES agent_threads(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    expression TEXT NOT NULL,
    timezone TEXT NOT NULL,
    delivery TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_fire_at TEXT,
    last_fired_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE agent_approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    message_id TEXT,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args TEXT NOT NULL,
    label TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX agent_approvals_run_idx ON agent_approvals(run_id);

  CREATE TABLE agent_sources (
    thread_id TEXT NOT NULL,
    n INTEGER NOT NULL,
    document_id TEXT NOT NULL,
    title TEXT NOT NULL,
    PRIMARY KEY (thread_id, n)
  );
  CREATE UNIQUE INDEX agent_sources_doc_idx ON agent_sources(thread_id, document_id);
  `
  ,
  // The chat bar (docs/granola-chat-bar.md): files added to chat, the per-provider upload cache, what a message
  // referred to, the model each thread and run used, and recipe descriptions and usage for the recipe menu.
  `
  CREATE TABLE chat_attachments (
    id TEXT PRIMARY KEY,
    thread_id TEXT REFERENCES chat_threads(id) ON DELETE CASCADE,
    message_id TEXT,
    document_id TEXT,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'pdf', 'text', 'office')),
    size INTEGER NOT NULL,
    pages INTEGER,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed')),
    error TEXT,
    text_chars INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX chat_attachments_thread_idx ON chat_attachments(thread_id, created_at);
  CREATE INDEX chat_attachments_message_idx ON chat_attachments(message_id);

  CREATE TABLE chat_attachment_uploads (
    attachment_id TEXT NOT NULL REFERENCES chat_attachments(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    remote_id TEXT NOT NULL,
    uri TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (attachment_id, provider)
  );

  ALTER TABLE chat_messages ADD COLUMN context TEXT;
  ALTER TABLE chat_threads ADD COLUMN model TEXT;
  ALTER TABLE agent_runs ADD COLUMN llm TEXT;
  ALTER TABLE recipes ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE recipes ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE recipes ADD COLUMN last_used_at TEXT;
  `
,
  // Editable enhanced notes: the panel's TipTap JSON (null until first edited, derived from the Markdown on read),
  // and `generated_lines` as line texts instead of line indices, so edits don't shift the grey/black colouring.
  (db) => {
    db.exec(`ALTER TABLE document_panels ADD COLUMN content_json TEXT`)
    const rows = db.prepare(`SELECT id, content, generated_lines FROM document_panels`).all() as { id: string; content: string; generated_lines: string }[]
    const update = db.prepare(`UPDATE document_panels SET generated_lines = ? WHERE id = ?`)
    for (const r of rows) {
      let indices: unknown
      try {
        indices = JSON.parse(r.generated_lines)
      } catch {
        indices = []
      }
      const numbers = Array.isArray(indices) ? indices.filter((i): i is number => typeof i === 'number') : []
      update.run(JSON.stringify(generatedLineTexts(r.content, numbers)), r.id)
    }
  },
  // Speaker attribution (docs/notion-speakers.md): the engine's diarized label and the session it is scoped to, per
  // chunk, and the names the user gave those speakers, per note.
  `
  ALTER TABLE transcript_chunks ADD COLUMN speaker TEXT;
  ALTER TABLE transcript_chunks ADD COLUMN speaker_session TEXT;
  ALTER TABLE documents ADD COLUMN speakers TEXT NOT NULL DEFAULT '{}';
  `,
  // API usage for Settings → Usage: one row per model request or stretch of transcribed audio. Costs aren't stored
  // (they're priced on read), and the ids aren't foreign keys, so usage outlives the notes and chats it came from.
  `
  CREATE TABLE usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('llm', 'audio')),
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    purpose TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    audio_seconds REAL NOT NULL DEFAULT 0,
    audio_mode TEXT CHECK (audio_mode IN ('streaming', 'prerecorded')),
    multilingual INTEGER NOT NULL DEFAULT 0,
    diarized INTEGER NOT NULL DEFAULT 0,
    keyterms INTEGER NOT NULL DEFAULT 0,
    document_id TEXT,
    thread_id TEXT,
    run_id TEXT
  );
  CREATE INDEX usage_events_created_idx ON usage_events(created_at);
  `
]
