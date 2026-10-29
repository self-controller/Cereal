# Granola 7.663.2: reverse-engineering findings → Cereal spec

This document is the behavior spec for Cereal. It was derived from static analysis of the shipped Granola Windows build.
Nothing here is Granola source code, prompts or assets. Cereal reimplements the *behavior* described below.

## Artifact identity

| Item | Value |
| --- | --- |
| Installer | `Granola-7.663.2-win-x64.exe`, sha256 `e5f7e4217bf58753e22fe6deb5534a1c83704eade30af3975268dbb6cdd7a649` |
| `resources/app.asar` | sha256 `321f76e03e3a5bc1ed4d734fb5a40cfde075953659230374dd4618d45f0a2f25` |
| `Granola.exe` | sha256 `c2dd8b4433587a735f908d6915cc3bd388923001269ddd46741e81a891b653dd` |
| Native module | `resources/native/windows/granola.native.windows.win32-x64-msvc.node`, sha256 `7dca2944…` (napi-rs/Rust) |
| Local copy | `~/re/granola/7.663.2/` (never committed) |
| Evidence bundle | `~/re/granola/evidence/granola-7.663.2-evidence.json` |
| Newer build (chat bar pass) | `Granola-7.668.0-win-x64.exe` (beta), sha256 `e3933f0a…`, in `~/re/granola/7.668.0/`; see [granola-chat-bar.md](granola-chat-bar.md) |

**REA Evidence IDs**
- `ev_41084d1d9248ba1959c33598bfc452a45727085773daed93f853053c20e231ff`: Electron fuses.
- `ev_18bd53a1770366dacf2ce2267735e426e173b04035dbf6811c430bb07d6714eb`: Rust native-module metadata. No `.dep-v0` section was found, so the dependencies are unknown.
- `ev_63629a4d6a7e56275f08f3be549800ae14bc6c4d68bb2cec816dcbe2d628f733`: JavaScript application graph, bounded to `package.json`, the preload script and the utility processes.
- `ev_fc1b3c8c4a8b8074db429d02478e304677250789d5b3950c685455c1081a4e04`: summary view of that graph.

**How the facts were gathered.** Facts marked **[O]** were observed in shipped bytes, either through REA or by reading the extracted bundle files as inert text. **[I]** marks an inference. **[?]** marks an open unknown. Nothing was executed, and the Windows build cannot run on this host.

## 1. Process architecture

- **[O] Electron and bundling.** Electron, with the main and preload code bundled by rolldown/Vite (`dist-electron/main/index.js`, 6.9 MB). The renderer is a Vite/React SPA in `dist-app/`.
- **[O] Utility processes.** Heavy or native work runs in Electron `utilityProcess` children, each with its own folder in `dist-electron/`:
  - `audio_process`: native audio capture.
  - `sqlite_process`: SQLite with a 4-worker-thread pool and an encrypted database. The key is posted from main as a `{type:"key"}` message.
  - `local_asr_process`: on-device transcription.
  - `local_diarization_process`: on-device speaker separation.
  - `mic_monitor_v2_process`: tracks which apps are using the mic.
  - Others: `dictation_utils`, `accessibility`, `network_doctor` and macOS-only helpers.
- **[O] Messaging.** The utility processes talk to main through `process.parentPort.postMessage` with `{event|type: …}` messages.
- **[O] Preload.** The preload script exposes 362 members across 2 `contextBridge` APIs. Its IPC channel names are mostly dynamic and follow a `domain:action` naming style, for example `local-asr:start-download`, `transcription-input:state-changed`, `nub:visible` and `cache:dispatch`.
- **[O] Fuses.** RunAsNode and `--inspect` are disabled. ASAR integrity and app.asar-only loading are enforced.
- **[O] Dependencies.** The packaged ASAR declares only native and runtime dependencies: `better-sqlite3-multiple-ciphers` (SQLCipher), `keyspy` (global hotkeys), `registry-js` and `win-ca`. Everything else is bundled.

**Cereal decisions.** Use the same split: main, preload, renderer and utility processes, with `domain:action` IPC channels.
- **Audio:** capture runs in a utility process.
- **Local ASR:** transcription runs in a utility process.
- **SQLite:** runs in main for simplicity, because the dataset is single-user and small.
- **Encryption:** SQLCipher encryption is deferred. API keys are read from `.env` in the profile directory. Only the Google refresh token uses Electron `safeStorage`.

## 2. Audio capture

- **[O] Startup.** `audio_process` loads the native library given as `argv[2]`. On win32 it constructs `new AudioCapture()`.
- **[O] Start message.** `start-audio-capture` carries `{useCoreAudio, disableEchoCancellationOnHeadphones, enableAutomaticGainCompensation, sampleRate}`.
- **[O] Audio callback.** The native callback delivers `(microphoneBuffer, systemAudioBuffer, capturedTimestamps?)` as **PCM16 little-endian mono**. Each buffer is forwarded to main as `audio-capture-buffer`.
- **[O] Two separate streams.** Mic and system audio are captured as two separate streams. Echo cancellation happens natively, and it is optionally disabled when headphones are in use.
- **[O] Level meter.** The process computes RMS levels over 10 ms windows and throttles them to 100 ms `audio-volume {system, microphone}` events, which drive the UI meter.
- **[O] Other events.**
  - `input-devices-changed`, `set-input-device`
  - `microphone-permission-response`, `system-audio-permission-response`
  - `audio-capture-source-error`
- **[O] Render-follow on Windows.** `mic_monitor_v2_process` follows the *render* (speaker) device used by the meeting app's process tree. It does this with `startDeviceRenderLoopback(deviceId, sampleRate, cb)` in 50 ms PCM chunks, re-targets when the active device changes, and reopens after 3 s of unexpected silence.

**Cereal decisions.**
- **Capture:** use PipeWire via `pw-record`, run as two child processes from an audio utility process.
  - Mic: the default source, labelled "microphone" / "You".
  - System: the default sink monitor via `stream.capture.sink=true`, labelled "system" / "Them".
- **Format:** both streams use s16le, mono, 16 kHz.
- **Meters and events:** keep the same RMS/100 ms meter and the same event names where they make sense.
- **Echo cancellation:** not implemented in v1. The UI recommends headphones, and the optional PipeWire `echo-cancel` module is an alternative.

## 3. Live transcription (cloud)

- **[O] Deepgram endpoint and options.**
  - The socket connects to `wss://api.deepgram.com/v1/listen` with these live options: `model: nova-3`, `channels: 1`, `encoding: linear16`, `sample_rate`, `interim_results: true`, `smart_format: true`, `profanity_filter: false`, `mip_opt_out`, and `keyterms[]` (a custom vocabulary drawn from the user dictionary and attendee names).
  - For `language=multi`, endpointing is set to 100.
  - A fallback dedicated host exists. AssemblyAI universal streaming (`streaming.assemblyai.com`) is an alternative provider.
- **[O] Credentials and connection.** A short-lived Deepgram token comes from Granola's backend (`/v1/get-deepgram-token`) and is cached until near expiry. The socket reconnects on drops, with ping/pong.
- **[O] One stream per source.** There is one transcription stream per audio source. Emitted events carry `isFinal`, `isRevision` and `endUnixMs`. Committed-through watermarks are emitted on final results.
- **[O] Chunk shape and merging.**
  - A transcript chunk is `{id, document_id, start_timestamp (ISO), end_timestamp (ISO), text, source: "microphone"|"system", is_final, transcriber_user_id, detected_speaker_name, transcription_session_id?}`.
  - A store reducer, `mergeTranscriptChunks`, upserts chunks by `id`, so an interim chunk is replaced in place by later interims and its final. The list stays sorted by (start, end, id).
  - `deleteLocalPartialTranscriptChunks(source)` removes a source's non-final chunks.
  - `finalizeLocalTranscriptChunks` marks everything final when recording stops.

**Cereal decisions.** Replicate the chunk shape and merge semantics exactly (`src/shared/transcript.ts`), with these differences:
- **Credentials:** use the user's own Deepgram API key (`Authorization: Token …`) instead of a backend token.
- **Interim handling:** each source keeps one open interim chunk id until Deepgram sends `is_final`.

## 4. Local transcription (on-device ASR)

- **[O] Engines.** There are two engines:
  - `parakeet`: a NeMo transducer via a sherpa-onnx native addon.
  - `whisper`: whisper.cpp **`whisper-server`** spawned on a random localhost port with `-m <model> --host 127.0.0.1 --port N --threads T --suppress-nst`.
- **[O] Startup and requests.** The process polls `GET /` until it is ready (60 s timeout). Each segment is sent to `POST /inference` as multipart form data: a WAV file, `temperature=0.0`, `response_format=json` and an optional `prompt` of keywords.
- **[O] Model files.** Models are downloaded on demand with sha256 verification. IPC: `local-asr:start-download`, `:get-download-state`, `:download-state-changed`, `:delete-download`.
- **[O] Segmentation.** Voice activity detection uses onnxruntime-node 1.21 (Silero-style) at 16 kHz in 512-sample (32 ms) hops:
  - **Pre-roll:** 8 hops (~256 ms).
  - **Segment close:** after 25 silent hops (~800 ms).
  - **Minimum speech:** 6 hops.
  - **Maximum segment:** 25 s.
  - **Partial re-decode:** an open segment is re-decoded every 31 hops (~1 s).
  - **Committed-prefix tracking:** the longest common word prefix between successive partials, so text stays stable.
  - **Buffer trim:** the audio buffer is trimmed past 30 s.
- **[O] Outputs.** The process posts `{type: "segment"|"partial"|"progress"|"error"}` messages.

**Cereal decisions.**
- **Engine:** use whisper.cpp `whisper-server` with the same lifecycle. Its location is configurable, auto-detected on PATH, with an optional download of ggml models from Hugging Face.
- **VAD:** an energy-based VAD with the same hop, pre-roll, close, minimum and maximum constants. This is a deliberate simplification; Silero via onnxruntime is a later enhancement.
- **Partials:** run the same partial-plus-committed-prefix scheme.

## 5. Local data model (SQLite)

- **[O] ORM.** Drizzle/Kysely table definitions appear in the renderer and main bundles.
- **[O] `documents`:** `id`, `created_at`, `updated_at`, `deleted_at`, `title`, `type`, `creation_source`, `transcribe`, `notes` (ProseMirror JSON), `notes_plain`, `notes_markdown`, `google_calendar_event` (JSON), `people` (JSON: creator and attendees), `chapters`, `summary`, `overview`, `selected_template`, `valid_meeting`, `status`, `meeting_end_count`, `ydoc_state`, `ydoc_version`, plus many sharing, CRM and workspace fields.
- **[O] `document_panels`** (the "Enhanced notes" tabs): `id`, `document_id`, `title`, `content` (JSON), `original_content`, `template_slug`, `generated_lines`, `suggested_questions`, `user_feedback`, `generation_started_at`, `generation_failed_at`, `content_updated_at`, `last_viewed_at`, `has_speaker_attribution`, `deleted_at`.
- **[O] Other tables:**
  - `calendar_events`: `id`, `start_time`, `end_time`, `data`.
  - `pre_meeting_briefs`
  - `dictation_attempts`
  - `document_tags`: `document_id`, `category`, `value`.
  - `ydocs`
  - FTS5 table `documents_fts`: `document_id`, title and `notes_plain`, kept up to date by a batched "fts-queue" of 100 rows per drain.
- **[O] Transcripts** are kept in a cache store keyed by document (`transcripts[documentId]`) and synced to the server (`insert-transcriptions`).

**Cereal decisions.** Use the trimmed schema from the plan:
- `documents`, `document_panels`, `transcript_chunks`, `folders`/`folder_documents` (Granola's "document lists"), `templates`, `recipes`, `chat_threads`/`chat_messages`, `calendar_events`, `settings`, and `documents_fts` (FTS5).
- The FTS index also covers transcript and panel text.

## 6. Enhance notes (summary generation)

- **[O] Default template.** Generation creates a `document_panel` with `title = template.title || "Summary"`, `template_slug` and `generation_started_at`. With no template chosen, the slug defaults to `meeting-summary-consolidated` (auto-chosen headings).
- **[O] Templates.** A template is `{id, title, description, sections: [{heading, section_description}], is_granola, owner_id, shared_with}`. Built-in templates are flagged `is_granola`, and the user's own templates sort first. A user can favorite templates.
- **[O] Prompts are server-side.** The client sends only a `prompt_slug` plus a **variables dictionary** to Granola's streaming backend (`stream.api.granola.ai`). The output is streamed into the panel's Yjs doc. No prompt text ships in the client.
- **[O] Prompt variables built on the client:**
  - **Content:** `transcript`, `notes` (the user's notepad markdown), `headers` (the user's `#` headings), `urls` (links found in the notes).
  - **Meeting and people:** `calendar_event_title`, `participants` ("Name <email>" list), `my_name`, `their_name`, `my_bio`, `their_bio`, `my_company`, `my_colleagues` (same email domain), `external_attendees`, `external_companies`.
  - **Time:** `date`, `time`, `todays_date`.
  - **Flags:** `user_dictionary`, `is_short_transcript` (transcript under 200 characters), `has_long_user_notes` (20 or more non-empty lines), `is_multi_language`, `english_only_summary`, `has_speaker_attribution`, `latest_meeting_summary`.
  - **Template variables:** `summary_headings` (`#Heading: description` per section), `first_heading`, `meeting_description`, `template_title`, `max_num_headings`.
- **[O] Heading budget.** `max_num_headings` depends on transcript length:
  - under 8k characters: 4
  - under 20k characters: 5
  - under 80k characters: floor(length / 10k) + 1
  - otherwise: 8
- **[O] Automatic generation.** Generation can start automatically at the end of a meeting (`auto: true`). It can be resumed or restarted. A panel can be "rewritten" with user instructions, which sends `rewrite_instructions` and `latest_meeting_summary`.
- **[O] AI vs user lines.** `generated_lines` and `original_content` are stored per panel. `generated_lines` is a set of trimmed line texts, sent by the server during the stream.
  - A ProseMirror plugin (`generatedLines`) sets `data-generated="true"` on each paragraph or heading whose trimmed text is in the set. CSS turns those grey (`--color-secondary`, 0.1s colour transition).
  - Because it matches text, not position, a line the user edits stops matching and turns black. **(7.668.0)**
- **[O] Enhanced notes are editable.** The enhanced panel is a TipTap editor, not a rendered view.
  - **Saving:** edits are saved as ProseMirror JSON with `content_updated_at`, on a 1000 ms throttle that fires on both the first and last change. The editor also binds to Yjs (`contentType: 'summary'`).
  - **While generating:** the streamed Markdown shows in a separate `#summary-generating` block without its unfinished last line, and the editor takes over when the stream ends. **(7.668.0, `primary-*.js`)**
- **[O] Transcript Summary ("view source").** Each paragraph of the enhanced editor is a node view (not headings; paragraphs inside list items too). Hovering a row shows a small button at its right end.
  - **When it's hidden:** when the text is 1 character or less, only punctuation, or there is no transcript.
  - **The popover:**
    - aligned to the end, 5px offset, `max-w-xs sm:max-w-sm lg:max-w-lg`, max height 28rem;
    - the header is "Transcript Summary" (`transcript-summary-header`);
    - a 3-line skeleton shows until text streams in;
    - then summary paragraphs, with quote cards between them: an accent bar, the quote, and "Speaker • time".
  - **Clicking a quote:** scrolls the transcript to that segment.
  - **Notices:** a footer warns while transcription is still active, and a sentinel reply shows "No relevant context found".
  - **Where the data comes from:** it is generated on demand, every time the popover opens, and never stored. The request is POST `llm-proxy-stream` with `prompt_slug: 'view-source-summary'`, the note line, and transcript windows around the note's timestamp. Enhanced lines have no timestamp, so in effect the whole transcript is sent.
  - **How quotes are matched:** the reply is free text. Quoted spans of more than about 35 characters on their own line are fuzzy-matched to transcript segment ids on the client (Fuse.js). Neither the enhance output nor the nodes carry citation ids. **(7.668.0, `primary-*.js` ≈ offset 3851185 and the PortraitPage chunk)**
- **[O] UX copy from the onboarding demo.**
  - Green "dancing bars" at the bottom of the note open the transcript.
  - A stop button ends recording.
  - A bright green **Enhance notes** button then appears.
  - The AI writes notes that mix the transcript with the user's notepad.
  - Granola normally detects the end of a meeting automatically.

**Cereal decisions.**
- **Variables:** build the same variable set on the client.
- **Prompts:** render them into *our own* prompt templates (`src/main/ai/prompts/`), so no backend is involved.
- **Streaming:** stream markdown from the selected LLM provider into the panel.
- **Heading budget:** implement the `max_num_headings` thresholds.
- **AI vs user lines:**
  - `computeGeneratedLines` fuzzy-matches output lines against the user's notes.
  - `generatedLineTexts` stores the matching lines' editor texts, as Granola does.
  - Migration 5 converted the older line indices.
- **Editable enhanced notes:**
  - **Generation:** the panel streams Markdown. When the stream finishes, it is converted once with `markdownToDoc` (`src/shared/markdown.ts`, line-oriented, one text block per line) into `content_json`.
  - **Editor:** `views/note/EnhancedEditor.tsx` (the note editor's extensions + `GeneratedLines`) saves on a 1000 ms throttle through `panels:update`. Main stores the JSON and re-derives `content` Markdown, so search, copy and the agent see edits.
  - **Races:** saves are refused while the panel is generating.
  - **Rewrite:** a rewrite sends the edited notes as `<current_notes>` (Granola's `latest_meeting_summary`). Lines the user wrote stay black afterwards.
- **Transcript Summary** (`src/main/ai/transcriptSummary.ts`, `src/shared/transcriptSummary.ts`):
  - **Request:** on demand and never stored, using our own prompt on the fast model. The reply has 1–3 sentences, plus verbatim quotes on `> ` lines, or `NO_CONTEXT`.
  - **Transcript sent:** the whole transcript when it fits. Otherwise the turns sharing the most words with the line, ±2 turns of context, because enhanced lines carry no timestamp.
  - **Quote matching:** quotes are matched to chunk ids with a dependency-free sliding word window (`matchQuote`, score ≥ 0.6) instead of Fuse.js. Clicking one opens the transcript panel at that chunk.

## 7. Chat, recipes and search

- **[O] Endpoints.** `chat-with-documents`, `get-chat-models`, `get-chat-citation`, `get-recipes`/`upsert-recipe` (saved prompts with "views" scope), and `search-meetings-turbopuffer` (vector search). The chat history is attached to enhance requests.
- **[I] Scope.** Chat is scoped either to one note (transcript and notes as context) or to many notes (retrieval).

**Cereal decisions.** These were superseded by the agentic chat in §11.
- **Per-note chat:** puts the note, its enhanced notes and (when it fits) its transcript in the prompt.
- **Global chat:** looks meetings up with tools (FTS5 BM25 `searchMeetings`, `listMeetings`, `readMeetings`, `readTranscript`). Citations are `[n]` numbers, stable per thread, that link back to the notes.
- **Recipes:** saved prompts that can be invoked with `/` in the Ask bar.

## 8. Meeting detection, calendar and floating widget

- **[O] Mic monitoring.** A native `MicActivityTracker` emits `session_active`/`session_inactive` events per `(sessionId, processId, processName)`. Main uses them to detect meetings and their ends ("active listening notification").
- **[O] Calendar.** Google and Outlook calendar sync (`get-google-events`, `refresh-calendar-events`) runs through Granola's backend. Events are cached in `calendar_events`. Notes link to an event through `google_calendar_event`.
- **[O] Floating widget.** A floating "nub" window (`nub:visible`, `nub:docked`, `nub:start-drag`, `nub:document`) shows the active recording when the main window is not focused.
- **[O] Sounds.** `desktop-start-a/b.wav`, `desktop-pause.wav` and `desktop-resume.wav` play on start, pause and resume.

**Cereal decisions.**
- **Meeting detection:** poll `pw-dump` every 3 s for PipeWire capture streams (`media.class = Stream/Input/Audio`) from known meeting apps: zoom, chrome/chromium/firefox (Meet), teams, slack, discord. Detection raises "Meeting detected → Start notes?", and a meeting ends once the stream has been gone for 10 s or more.
- **Google Calendar:** direct OAuth (loopback redirect plus PKCE) with a user-supplied client ID, using the read-only events scope.
- **Widget:** an always-on-top frameless widget window.

## 9. Out of scope for Cereal v1 (deliberate deviations)

Sharing, workspaces and permissions, CRM integrations (HubSpot, Attio, Affinity, Salesforce), Slack, Notion and Zapier, mobile, phone and the iOS app, the virtual webcam, voice fingerprinting and local diarization, pre-meeting briefs, the Assistant's voice mode, iMessage and integrations (§11.3), Yjs collaboration (Cereal stores TipTap JSON directly), SQLCipher database encryption, and auto-update.

## 10. Visual design system

[`docs/granola-ui.md`](granola-ui.md) is the full UI, UX and motion spec from a second REA pass (Evidence `ev_1e8338e0a761a6c7c2bdae2b874f5e64b33ba6692d0b62fa08a2858c837517ce`). It covers the primitives, shell, pages, nub and animations. This section keeps the original token findings.

These values were read as inert text from `dist-app/assets/index-BHcQlGrl.css` (tokens), `Button-CDyCaYc0.js` (button variants), `primary-CXVdv0fU.js` and `Toolbar-DB9R0opk.js` (layout class strings), and `useDocumentEditorSession-*.css` (editor). Only values were taken. No Granola CSS, code, fonts or images are used.

- **[O] Design system.** The design system is called "oats". It is built on Tailwind v4: semantic `--oats-*` tokens over an `--color-oats-*` palette, with `html.dark` overrides.
- **[O] Neutrals.** The neutrals are warm off-whites and greys:
  - **Light:** window surface `#f7f7f2`, sunken `#f2f2ec`, elevated `#ffffff`.
  - **Dark:** surface `#292929`, sunken `#212121`, elevated `#363635`.
  - **Ink (light):** `#292929` primary, `#4e4d4b` secondary-strong, `#72726e` secondary, `#acada8` tertiary.
  - **Hover/active tints and hairlines** are translucent olive-black: `#625a220f` highlight, `#56512e1f` strong, `#47432a33` hairline.
- **[O] Brand colour.** The brand colour is olive green:
  - fill `#5b6f00` (hover `#4c5616`)
  - ink `#788c15`
  - tint surface `#e5eacd`
  - "dancing bars" `#74bd00`
- **[O] Fonts.**
  - **Body:** `--font-sans`/`--font-body` is "KMR Melange Grotesk", falling back to "Inter Variable" (opsz 28).
  - **Display:** `--font-display` is "Quadrant Notepad", falling back to "IBM Plex Serif".
  - **Mono:** JetBrains Mono.
  - **Weights:** "book" is 430.
- **[O] Type scale.**
  - **Text:** xs 12/16, sm 13/16, base 14/18, lg 16/20.
  - **Headings:** `text-h1` 36/40 (−0.01em), `text-h2` 28/32 and `text-h3` 24/28, all in the display font at weight 400.
  - **Editor:** 15px, or 16px when the container is at least 32rem.
- **[O] Buttons.**
  - **Shape:** `rounded-full` pills in book weight.
  - **Sizes:** md `h-7 px-3 text-sm`, lg `py-[9px] px-4 text-base`.
  - **`primary`** is the near-black ink fill.
  - **`accent`** (brand colour) is kept for the key call to action: the "Generate notes"/"Enhance notes" `lg` pill, which animates in with opacity 0→1 and y 6→0 over 200 ms.
- **[O] Layout.**
  - **Sidebar:** the sunken surface with a right border. Its default width is 192px and it is resizable. Nav items show `fill-highlight` when active or hovered.
  - **Toolbar:** 44px tall, with a fade from the surface colour.
  - **Content:** in a `max-w-2xl` column. Cards are `rounded-2xl` with a hairline ring.
  - **Note rows:** `rounded-xl py-[5px] px-2`, with a 28px icon tile and the time in tertiary small-caps on the right.
  - **Chat sidebar:** about 420px wide, with a 44px header.
- **[O] Editor details.**
  - Headings are semibold at body size. `h1` gets a "#" marker at 60% opacity hanging 20px into the left margin.
  - `li::marker` uses secondary ink.
  - Blockquotes have a 2px accent rule and curly quotes.
  - Links use accent ink.

**Cereal decisions.**
- **Neutrals, scale, shapes and layout:** keep Granola's.
- **Brand colour:** replace the green with **deep navy**: fill `#1E3A8A` (hover `#172E6E`), ink `#3558C8`, tint `#E4EAF7`. In dark mode the fill is `#2C4DB0` and the ink is `#8FA8F5`/`#A9BEFF`.
- **Dancing bars:** bright blue `#3D7BFF`.
- **Fonts:** Granola's licensed fonts are not shipped. Cereal bundles Granola's own declared OFL fallbacks, Inter Variable (opsz 28) and IBM Plex Serif, via `@fontsource`.
- **Code locations:** the tokens are in `src/renderer/src/styles.css`, and the primitives are in `src/renderer/src/components/oats/`.
- **Enhanced-notes headings:** they carry the "#" marker too, because the enhance prompt emits `###` headings.

## 11. The agent: agentic chat and the Assistant ("Keto")

[`docs/granola-agents.md`](granola-agents.md) is the full, authoritative spec of Granola's agents. It comes from a later REA pass (parent Evidence `ev_82a83c73f99bf9860d57f56c7491fa53d5ce3346d566197226b1bbd9631a43c5`, exported to `~/re/granola/evidence/granola-7.663.2-agents-evidence.json`). This section summarises the two surfaces Cereal rebuilds. Granola has six:
- Ask chat
- Keto (the "Assistant")
- Hermes ("Buddy"), a separate backend reached through `raisin`; it is not Keto
- Granny (voice)
- Dispatch
- the Reminder agent

These facts were read as inert text from the 7.663.2 bundle. The main sources are:
- `dist-app/assets/api-C8TM1NqZ.js`: the stream client.
- `entity-schemas-CSi0NuU1.js`: the chat message and tool-call schemas.
- `PortraitPage-B-E4VK2f.js`: the chat UI and client-applied tools.
- `namespace-B6iZFaY8.js`: the Assistant protocol.
- `primary-CXVdv0fU.js`: the Keto worker, task, skill and schedule schemas.
- `AssistantPage-BbBsnVH-.js`: the Assistant UI. `HermesRoute-*.js`, `api-D06Xbt1r.js`, `bot-chat-*.js` and `setup-*.js` belong to Hermes ("Buddy"), a different agent.
- `reminderAgent-Dd0yVAEp.js`: the reminder agent.
- `dist-electron/main/index.js`: the `hermes-notification` card window, which Hermes and the Assistant share.

No REA Evidence records were produced for this section. Nothing was executed.

Both surfaces below run their model loop on Granola's servers, and the desktop app is a thin client.

### 11.1 Agentic chat (`chat-with-documents`)

- **[O] Request.** `POST stream.api.granola.ai/v1/chat-with-documents` carries:
  - `thread_id`, `assistant_message_id` and `chat_history`
  - `chat_context`: one of `meeting`, `live-meeting`, `global`, `list`, `search`, `view` or `shared-with-me`
  - `document_ids`, `list_id`, `web_search`, `edit_with_ai`, `user_timezone` and `prompt_config`
  - `developer_overrides.dispatcher_backend`
- **[O] View context.** User messages carry a `currentViewContext`. For a meeting it is `{view:"meeting", meetingId, userSelectedText, relatedMeetings, preMeetingBrief}`. For global it is `{view:"global", numTotalDocuments, upcomingMeetings, recentMeetings}`.
- **[O] Response chunks.** JSON chunks are separated by a delimiter. The chunk types are:
  - `text_delta`
  - `output_delta {index, output}` and `outputs`
  - `context_sources_delta {numTotalSources, scannedDocuments, citationIds, webSearch}`
  - `context_limit_reached`
  - `stream_completed {reasoning{text, durationSeconds}, contentType text|chat_with_citations, response|responseText, outputs, changedBlocks, metadata, braintrustSpanId}`
  - `error`
- **[O] Message outputs.** Each assistant `chat_message` stores `outputs[]`: `reasoning {text, durationSeconds}`, `text`, `text_with_citations {response_lines[{answer_text, citations[{meeting_id, citation_source_type, citation_source_quote}]}]}`, `tool_call` and `draft_preview`.
- **[O] Tool call shape.** A tool call has these fields:
  - `id`, `name`, `args` and `argsDelta` (the streamed argument text)
  - `result`, `error`, `completed`, `startedAtMs`, `completedAtMs` and `reverted`
  - `renderInline` and `isVisibleInChat`
  - `providerExecuted`, `providerReplayKey`, `providerCallMetadata` and `providerResultMetadata`
  - `approval{id, status pending|approved|denied, reason, proposedArgs}`
  - a separate `confirmationRequired` with `confirmationStatus pending|confirmed|cancelled`
- **[O] Tools.** There are 82 literal tool names (listed in `granola-agents.md`), plus MCP tools (`mcpConnectionId`, `mcpServerUrl`, `mcpToolTitle`) and connector tools (`connectorActionId`, `connectorKey`). Execution is server-side; `web_search`, `web_fetch`, `code_execution` and `toolSearch` are executed by the provider. They include:
  - Meetings: `searchMeetingsByKeywords`, `searchMeetingsByPeople`, `searchMeetingsByPeopleAndCompanies`, `queryMeetingContext {time_range, limit, include_shared}`, `readMeetings`, `readTranscript`, `exploreMeetings`
  - Calendar: `getUpcomingCalendarEvents`, `searchCalendar`, `readCalendarEvent`, `draftCalendarEvent`, plus calendar write tools
  - Email: `searchEmailThreads*`, `readEmailThread`, `getEmailWritingStyle`
  - Follow-ups: `writeFollowUpEmail`, `writeFollowUpSlackMessage`
  - CRM tools
  - Web: `web_search` and `web_fetch`
  - Skills and questions: `readChatSkill {skillName}` returns `{skillName, instructions} | false`. `askUserQuestion {questions[1–3]{id, question, options[2–4]{label, description}, multiSelect}}` returns `{answers: Record<id, string[]>}`.
  - Cross-source search: `search {connectors: 1–4 of slack|granola|gmail|calendar, queries: 1–5}`
  - Memory: `memory_bash {command, change_note}`, `update_personal_instructions {revision, add[], remove[]}`
  - User-added MCP servers: the `mcp_server_connection` entity, with bearer or OAuth auth and http or sse transport
- **[O] Note edits applied by the client.**
  - `editMeetingNotes {textToReplace, newText}` is applied by the renderer to the open editor, with a highlight. Undo and reapply flip `reverted`. Granola refuses ("Cannot undo edits to changed notes") when the text has moved.
  - `rewriteMeetingNotes {rewriteInstructions}` starts a new summary panel and stores `{newPanelId}` as the tool result.
- **[O] Approvals.** Approval-gated calls render Approve or Deny. The decision goes back as `toolApprovalDecision` on the next request. Sending a new message marks any pending approval `denied`.
- **[O] Drafts (Dispatch).** `draft_preview` artifacts are `email`, `slack_message`, `linear_ticket_batch`, `calendar_event` or `cursor_plan`. Each has the status `ready_for_approval`, `needs_input` or `blocked`.

### 11.2 The Assistant ("Keto": `keto-gateway` + `keto-socket`)

- **[O] Runtime.** It is a persistent per-user agent instance running in a cloud worker: an ECS task with an EFS filesystem, an OpenAI secret and Braintrust tracing. The worker harness reports a `piVersion`.
- **[O] Worker ↔ backend actions:**
  - `worker.next` returns `{shutdown, run: {runId, runtimeToken} | null}`
  - `claim` returns `{instanceId, message, inboxEnabled, resetContext, inputs, threadId}`
  - `heartbeat`
  - `inbox.next/ack`
  - `context.seed`, `prompt.resolve`, `skills.resolve`
  - `mcp.credentials`, which only allows `https://mcp.slack.com`
  - `assistant.transcript` and `assistant.model.append`: an append-only, sequenced store of model messages
  - `events`, which accepts 1–20 events per call
  - `finish {completed|failed}`
- **[O] Threads.** A `conversation` thread delegates to **task** threads through `assistant.child.start {title, handoff, followsTaskId}`. There are matching `child.message`, `child.stop` and `child.approve` actions, plus `result.read`.
  - **Tasks:** `{lifetime once|ongoing, status active|needs_input|done|failed|cancelled, revision, pendingApproval{id,label,detail}, resultMessageId}`.
  - **Results:** a task reports back with `assistant.result.publish {status done|needs_input|failed, summary, text}`.
- **[O] Messages.** A message is `{id, threadId, sequence, author user|agent|voice_model|parent, text, outputs[text|reasoning|tool_activity{label, state running|done|failed|awaiting_approval, affects blocks|notes|memory}|task{taskThreadId}], status in_progress|completed|error|cancelled, clientMessageId}`.
  - Inputs from `child`, `scheduler` and `event` sources reach the model but are never shown as messages.
- **[O] Runs and events.**
  - **Run states:** `starting`, `running`, `completed`, `failed` and `cancelled`, plus `recovery {attempt, previousRunId, resumeInputId}`.
  - **Events, each with a per-run `sequence`:** `input.received`, `message.delta/completed`, `reasoning.started/delta/completed`, `model.started/usage`, `tool.started/output/completed`, `file.written`, `run.status`, `message.published` and `home.published`.
  - **Streaming:** `keto-socket` is SSE over a POST fetch.
    - **Per-run stream:** the body is `{runId, afterSequence, includeReasoning}`, with `run.snapshot`, `error` and `reconnect` events. The client retries after 1 s and stops once the run leaves starting|running.
    - **Assistant page:** it opens the conversation stream with `{threadId, afterSequence}` and reconnects with exponential backoff up to 30 s.
- **[O] Approvals.** `assistant.approval.request {toolCallId, toolName, arguments, detail}` returns `allow`, `approval_required {approvalId}` or `denied {reason}`. ("Allow once" / "Always" is Hermes UI copy, not Keto's.)
- **[O] Inbox.** Inputs have `source user|event`, `delivery immediate|batch|idle` and `delaySeconds` (default 60). They are enqueued with `enqueue {message, taskId, delivery}`.
- **[O] Routines.** `schedule.create {message, expression at(…)|rate(…)|cron(…), timezone, delivery idle|immediate, taskId}`, plus `list` and `delete`.
- **[O] Skills.** A library of `<name>/SKILL.md` files.
  - **Frontmatter:** `name` must be kebab-case, at most 64 characters and match its folder. `description` is 1–1024 characters. `license`, `compatibility`, `metadata` and `allowed-tools` are optional.
  - **Limits:** at most 1,000 files and 1 MB. Skills are personal or shared with the workspace.
- **[O] Prompts.** The prompt bundle has `main`, `conversation`, `task` and `voice` sections and is versioned (personal vs production). Granola's prompt text ships server-side and was not seen.
- **[O] Worker filesystem tools.** `bash` (streaming `tool.output` stdout/stderr), `read_file`, `write_file` and `edit_file`. Memory lives as `context/*.md|json` files. A `memory_changed` stream event is sent when they change.
- **[O] Home.** `task.home {briefing ≤ 8000 chars, groups[{title, taskIds}] ≤ 20 groups, ≤ 100 tasks}`.
- **[O] Client actions.**
  - `assistant.conversation.open {clientCapabilities}` returns `{conversation, tasks, messages, enabledCapabilities, worker ready|starting}`.
  - Also `assistant.send {threadId, clientMessageId, text}`, `assistant.stop`, `assistant.task.stop`, `assistant.task.approve {approvalId, expectedRevision}`, `assistant.task.read {afterSequence}` and `assistant.viewing`.
- **[O] Voice ("Granny").**
  - **Session:** a WebRTC SDP POST to Granola's own `granny-live.<domain>/v1/granny/session`, obtained through `create-granny-live-session`. The voice is "marin". The client never talks to OpenAI Realtime directly.
  - **Events:** NDJSON events carry `delegation.*`, which hands work to the text agent.
  - **iMessage:** connected through "Photon".
- **[O] Notifications.** Hermes and the Assistant share one card window, `hermes-notification`, with cards keyed by kind `hermes|assistant`. It is frameless, always on top, non-focusable and sits top right. It auto-hides after 8 s and opens the conversation when clicked. While the main window is focused it is suppressed, except for `assistant` cards.
- **[O] Reminder agent.** Local reminder records with kinds `follow_up_emails`, `running_late`, `no_show`, `calendar_invite`, `missing_details` and `focus_time`. Their actions are `draft_block`, `open_chat`, `chat_action {mode background|open, instruction, expectedTool}` and `review_follow_ups`. Commitments are extracted per document (`email|slack|calendar|todo` items).

### 11.3 Cereal decisions

- **Same split, locally.**
  - **Runtime:** the model/tool loop (`src/main/agent/runtime.ts`) runs in an Electron **utility process** (`out/main/agent.js`, `src/main/agent/worker-host.ts`). It plays Keto's cloud worker.
  - **Backend:** main (`src/main/agent/backend.ts`) plays Granola's servers. It owns SQLite and the tools.
  - **Protocol:** the RPC (`src/main/agent/protocol.ts`) is `claim`, `appendTranscript`, `startEpoch`, `callTool`, `events`, `suspend`, `finish`.
  - **Tests:** the same runtime runs in-process (`InProcessHost`).
- **Pluggable models.** Tool calling is provider-neutral across Claude, OpenAI and Ollama (`LlmProvider.step`).
  - **Claude:** adaptive thinking with summaries, `effort`, eager input streaming, automatic prompt caching and refusal fallbacks.
  - **Replay:** provider-native assistant content is replayed verbatim (Granola's `providerReplayKey`), so thinking blocks round-trip.
  - **Transcript:** append-only per thread. When it outgrows the budget, a summary starts a new epoch and the kept turns drop their replay.
- **Chat shapes.** The chat keeps Granola's shapes: `chat_messages.outputs` with tool calls, approvals, `applied`/`reverted` for note edits, and citations as `[n]` numbers that are stable per thread (`agent_sources`).
  - **Tools:** chat gets the meeting, calendar, draft and skill tools. Note chat also gets `editMeetingNotes` (applied in the renderer, with Undo and Reapply) and `rewriteMeetingNotes`.
  - **Drafts:** cards with Copy, `mailto:` and a prefilled Google Calendar page. Nothing is sent.
- **Assistant model.** It keeps Keto's model:
  - one conversation plus task threads, with `parent` messages carrying handoffs
  - an inbox with immediate, batch and idle delivery
  - routines (`src/main/agent/schedule.ts`: `at`/`rate`/5-field `cron` with timezones, catching up once after downtime)
  - sequenced per-run events (`agent_events`), replayed by the UI with `agent:events(runId, afterSequence)`
  - published Home, and task approvals that set `needs_input`
  - native notifications instead of the custom card window
- **Approvals.** Every Assistant tool is allowed except writing outside `memory/` and `createRoutine`. "Always allow" is stored in `settings.assistant.alwaysAllow`.
- **Files (deliberate deviation).** Keto's workers have `bash`. Cereal's agent has no shell: it gets `list_files`, `read_file`, `write_file` and `edit_file` confined to `<userData>/agent/{memory,skills,files}`. The check is lexical plus realpath, with a 1 MB cap. Memory is `memory/MEMORY.md`, injected into the prompt. A starter skill is seeded on first run.
- **Deferred.** These are not built:
  - Hermes/Buddy (the `raisin` backend)
  - Granny voice and iMessage
  - Dispatch artifacts beyond email and calendar drafts
  - the Reminder agent and its proactive event triggers (the inbox already has an `event` source)
  - the Quick-chat window
  - the MCP client and connector tools
  - Gmail, Slack and CRM tools
  - web search
  - `askUserQuestion`, `memory_bash` and personal instructions
  - the confirmation flow, separate from approvals
  - the shared notification card window

## Open unknowns

- [?] Granola's exact capture sample rate. It is a runtime parameter (`sampleRate: e`). Cereal uses 16 kHz.
- [?] The server-side prompt text. It is intentionally not needed, because Cereal writes its own prompts.
- [?] How the Rust native module implements echo cancellation and WASAPI loopback internally. The module was not decompiled, because the JavaScript evidence was sufficient for a PipeWire re-design.

## Reconstruction checklist (Granola behavior → Cereal → verification)

Cereal's packaged `app.asar` was analyzed with the same REA analyzer (Evidence `ev_77ecd4fee108eb4d24a15365c40c2386304d6d3651d8882b60a56d34c9321705`, app.asar sha256 `a03c7b1b…`). It shows the same overall shape:
- one `contextBridge` API (`invoke`, `on`, `platform`)
- 51 literal `domain:action` main-process IPC handlers
- two BrowserWindows: the main window and the recording widget ("nub")
- child processes for `pw-record`, `pw-dump` and `whisper-server`

| # | Observed Granola behavior (§) | Cereal implementation | Verified by |
| --- | --- | --- | --- |
| 1 | Mic and system audio as two PCM16 streams; 100 ms RMS level meter (§2) | `src/main/audio/pipewire.ts` | E2E smoke test: real PipeWire capture, both sources transcribed |
| 2 | Deepgram nova-3 live stream: linear16, interim results, smart_format, keyterms (§3) | `src/main/transcription/deepgram.ts` | `tests/transcription.test.ts` (URL params, mock WebSocket server, auth failure); E2E |
| 3 | Chunk shape and `mergeTranscriptChunks` upsert-by-id semantics (§3) | `src/shared/transcript.ts`, `src/main/recorder.ts` | `tests/shared.test.ts`, `tests/services.test.ts` (Recorder) |
| 4 | Finalize leftover interims on stop (§3) | `Recorder.stop` | `tests/services.test.ts` |
| 5 | whisper-server on a random localhost port, `/inference`; VAD timing constants; committed-prefix partials (§4) | `src/main/transcription/whisper.ts`, `segmenter.ts` | `tests/transcription.test.ts` (segmenter, stabilizer, WAV). Not exercised end to end: `whisper-server` is not installed on this host |
| 6 | On-demand model download (`local-asr:*`) (§4) | `src/main/transcription/models.ts` | Manual: Settings → Transcription |
| 7 | Local SQLite: documents, panels, calendar events, FTS5 (§5) | `src/main/db/*` | `tests/store.test.ts` |
| 8 | Enhance: template sections, prompt variable set, `max_num_headings`, panel per template (§6) | `src/main/ai/variables.ts`, `service.ts`, `prompts.ts` (own prompts) | `tests/services.test.ts`; E2E (fake Ollama) |
| 9 | `generated_lines` attribution: user lines in full colour, AI lines grey, kept as line texts (§6) | `src/shared/attribution.ts`, `src/shared/generatedLines.ts`, `components/editor/generatedLines.ts` | `tests/shared.test.ts`, `tests/enhanced-notes.test.ts`; E2E checks `data-generated` |
| 10 | Rewrite a panel with instructions (§6) | `AiService.rewrite` | Manual |
| 11 | Auto-title untitled notes (§6) | `AiService.autoTitle` | `tests/services.test.ts` |
| 12 | Chat per note and across notes, citations, recipes (§7) | `src/main/agent/chat.ts` (`ChatAgent`), FTS5 retrieval through the agent's tools | `tests/agent.test.ts`; E2E (note chat, global chat with citation) |
| 13 | Meeting detection from apps using the mic; meeting-end detection (§8) | `src/main/detector.ts`, `pipewire.ts#activeMeetingApps` | `tests/services.test.ts` (detector state machine) |
| 14 | Calendar events and reminder notifications (§8) | `src/main/calendar.ts` | `tests/services.test.ts` (event mapping). OAuth needs the user's own client ID |
| 15 | Floating recording widget when the main window is unfocused (§8) | `src/main/app.ts#updateWidget`, `src/main/widget/*` (XWayland host on Wayland), `widget.tsx` | E2E: widget appears on minimize |
| 16 | Provider-neutral tool calling, thinking replay (§11.1, §11.2) | `src/main/llm/*.ts` (`step`) | `tests/agent-llm.test.ts` (mock Anthropic SSE incl. thinking signature replay, OpenAI fragments, Ollama tool calls). Real Claude not exercised: no API key on this host |
| 17 | Agentic chat: tool loop, outputs, citations, approvals on new message, stop (§11.1) | `src/main/agent/{runtime,backend,chat}.ts`, `tools/` | `tests/agent.test.ts`; E2E: global chat runs `searchMeetings` and cites [1] |
| 18 | `editMeetingNotes` applied in the editor with Undo; `rewriteMeetingNotes` new panel (§11.1) | `NoteView.tsx`, `lib/noteEdits.ts`, `tools/notes.ts` | `tests/agent.test.ts`; E2E: edit applied, undone |
| 19 | Keto worker ↔ backend split, append-only transcript, resumable approvals (§11.2) | `worker/entry.ts`, `worker-host.ts`, `protocol.ts`, `db/agent-store.ts` | `tests/agent.test.ts` (suspend → approve → resume, decline, restart recovery); E2E runs the utility process |
| 20 | Conversation → task delegation, publishResult, Home, sequenced events + `afterSequence` (§11.2) | `src/main/agent/assistant.ts`, `AssistantView.tsx` | `tests/agent.test.ts`; E2E: task drafts an email and reports back |
| 21 | Inbox delivery modes and routines `at`/`rate`/`cron` + timezone (§11.2) | `db/agent-store.ts`, `agent/schedule.ts` | `tests/agent.test.ts`, `tests/agent-fs.test.ts` (DST, weekdays, names) |
| 22 | Skills library rules, sandboxed memory/files with approval outside memory (§11.2) | `agent/files.ts`, `tools/files.ts` | `tests/agent-fs.test.ts` (`..`, absolute, symlink escapes; unique edits; frontmatter validation) |
| 23 | oats primitives on Base UI + motion + sonner: buttons, MorphButton, menus, tooltips, dialogs, switch, toasts ([UI spec](granola-ui.md#primitives)) | `src/renderer/src/components/oats/*` | Typecheck; screenshots of menus, tooltip, dialog and palette (scratch run) |
| 24 | Frameless window, 44px floating toolbar, resizable or overlay sidebar that closes on notes ([UI spec](granola-ui.md#shell)) | `src/main/app.ts` (`titleBarOverlay`), `components/shell/*` | E2E (sidebar opened with Ctrl+S on a note page); screenshots at 1240px and 700px |
| 25 | Note page: options row under the title, recording widget beside the chat input, transcript in the bar panel (no tab), chrome-zone Generate pill, docked or floating chat ([UI spec](granola-ui.md#pages)) | `views/note/*`, `components/FloatingChat.tsx` | E2E: layout checks → widget opens the live transcript → scroll follow → stop → Generate notes → chat edit + undo |
| 25a | Editable enhanced notes, grey AI lines by text set (§6) | `views/note/EnhancedEditor.tsx`, `src/shared/markdown.ts`, `panels:update` | Unit: `tests/enhanced-notes.test.ts`; E2E: edit an AI line → black → saved |
| 25b | Transcript Summary per paragraph (§6) | `views/note/TranscriptSummaryPopover.tsx`, `src/main/ai/transcriptSummary.ts` | Unit: parse, match, window, stream and cancel; E2E: hover → popover → quote → transcript highlights it |
| 26 | Nub pill and meeting prompt ([UI spec](granola-ui.md#nub-floating-widget)) | `src/renderer/src/widget.tsx`, `index.ts#updateWidget` | E2E: widget appears on minimize |
| 27 | Chat bar: TipTap composer, placeholder states, "/" recipes, "@" notes, chips, Enter-key setting, send/stop/mic ([chat bar spec](granola-chat-bar.md)) | `components/chat/*`, `src/shared/chatbar.ts` | `tests/chatbar.test.ts`; E2E: recipe chip, @-mention chip and citation, edit and resend, Ctrl+J |
| 28 | Floating panel (notes), docked sidebar (Home, folders), full-page Chat ([chat bar spec](granola-chat-bar.md#8-surfaces-and-layout)) | `components/FloatingChat.tsx`, `views/ChatView.tsx` | E2E screenshots (panel, sidebar, Chat page) |
| 29 | File attachments: types, limits, processing, upload per provider ([chat bar spec](granola-chat-bar.md#7-files)) | `src/main/attachments/*`, `src/main/llm/files.ts`, providers | `tests/attachments.test.ts`, `tests/agent-llm.test.ts` (Anthropic Files, OpenAI Files + Responses, Gemini Files API, Ollama images); E2E: PNG + text reach the model |
| 30 | Model picker with per-chat model (`get-chat-models`, `prompt_config.model`) ([chat bar spec](granola-chat-bar.md#6-model-picker)) | `src/shared/models.ts`, `llm/index.ts#chatModels`, `ModelPicker.tsx` | `tests/agent.test.ts` (per-thread override); E2E (providers without keys disabled) |
| 31 | Dictation (Ctrl+T, waveform, 10-minute auto-send) | `components/chat/Dictation.tsx`, `src/main/transcription/dictation.ts` | Manual (needs a microphone and a transcription engine) |

**Deliberate deviations from the plan**
- **SQLite runs in the main process** through plain better-sqlite3 prepared statements. There is no utility process and no Kysely.
- **Audio capture uses `pw-record` child processes** owned by main, instead of an in-process native module in a utility process.
- **The VAD is energy-based**, not Silero.
- **The REA obligation ledger was not generated.** `build_reconstruction_obligation_ledger` and `verify_reconstruction` need per-obligation owner bindings and verifier Evidence records. The table above is the human-readable equivalent.
