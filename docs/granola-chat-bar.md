# Granola 7.668.0: chat bar spec → Cereal

This is the third reverse-engineering pass over Granola's renderer, focused on the **chat bar** (Granola's `ChatInput`) and the surfaces that host it: the floating bar and its panel, the docked chat sidebar, and the full-page Chat. It also records what Granola sends when a message goes out.

Nothing here is Granola source code, CSS, prompts, copy decks, icons or images. The spec records observed **behaviour and values**, and Cereal reimplements them in its own code. Copy that is distinctive to Granola is rewritten in Cereal's voice: the sample questions, the "thinking" words and the drop-overlay text.

## Provenance

- **Artifacts:**

  | Build | Installer sha256 | `app.asar` sha256 | Local copy |
  | --- | --- | --- | --- |
  | 7.668.0 | `e3933f0a62444ce0063fce65f0ef21080eb47a79cbb33c1c03f73d4098f6cdcb` | `ae94955a6a908ce1ee86fe5917f2df71fad9275a69f9b5332f5f2d807314fe67` | `~/re/granola/7.668.0/` |
  | 7.663.2 (baseline) | see [granola-findings.md](granola-findings.md#artifact-identity) | | `~/re/granola/7.663.2/` |

- **How 7.668.0 was found:**
  - The "new download", `Granola.dmg` (750 KB), is a stub installer: `com.granola.stub-installer-prototype` v0.1.74.
  - It asks `api.granola.ai/v1/get-versions` which build to install. At the time that was `{"production":"7.663.2","beta":"7.668.0"}`.
  - The updater feed `api.granola.ai/v1/check-for-update` redirects to `https://dr2v7l5emb758.cloudfront.net/<ver>/latest.yml`.
  - The 7.668.0 Windows installer was fetched from there and checked against the sha512 in that manifest.
- **REA evidence:** `analyze_javascript_application` was run over both extracted asars, with the chat chunks selected:
  - 7.668.0: `PortraitPage-D7ruWljI`, `multiChatStore-D0vol-c_`, `api-*`, `constants-*`, `cache-*`, `getEditorMarkdown-*`, `quick-chat-*`. Evidence `ev_b74c06608564ac48124717d31ab191278eebbcffc71ced2cc40f30e6e4aef0f2`.
  - 7.663.2: the same chunks under their old names. Evidence `ev_6a694dba89bf804c2b9c466452f61533afdf772666ce5c5d5cdc9fd8fbbb9280`.
  - `compare_application_versions`: evidence `ev_c03e0c9041e123328b391b1cd6ca011b0c873aa672d5b64345c83b045657910d`.
  - Everything is exported to `~/re/granola/evidence/granola-7.668.0-chatbar-evidence.json`.
  - Chunk names and minified identifiers change between builds, so the graph diff matches few entities. The version delta below therefore comes from a string-literal diff of the chat chunks and from reading the changed regions as inert text.
- **Marks:** **[O]** means observed in shipped bytes, **[I]** means inferred, **[?]** means unknown. Nothing was executed.

## 7.663.2 → 7.668.0 delta (chat bar)

- **[O] The chat bar itself is unchanged.**
  - Every composer string, endpoint and test id checked is present in both builds with the same counts: `chat-input`, `attach-file-button`, "Upload files or images", "Select AI model", "Continue chat", "Chat with selected text", the edit banner, "Say more", the disclosure line, `get-file-upload-url`, `process-attachments`, `chat-with-documents`, `get-chat-models`, `response_style` and `1568`.
- **[O] The floating chat is positioned with CSS anchors.**
  - The floating panel declares `anchor-name: --floating-chat`.
  - Things stacked above the bar position themselves against `anchor(--floating-chat top)`:
    - The meeting's bottom chrome (`data-meeting-bottom-chrome`) sits at `bottom: min(anchor(top, 72px), 100% − 108px)`, with `min-h-[95px] pb-3.5`.
    - The Enhance-notes card sits at `anchor(top) + 14px`.
    - Browsers without anchor support fall back to 72px and 86px.
  - The docked sidebar declares `anchor-name: --multi-chat-sidebar`. The bulk-selection pill centres itself left of the sidebar using `anchor-size(--multi-chat-sidebar width)`.
- **[O] The floating panel element** is `floating-chat-panel`:
  - Position: `absolute left-1/2 min-w-60 px-2 origin-bottom`, `max-h-[calc(100%-4px)]`, at `bottom-4` (or `bottom-0`).
  - Width: `max-width: min(100cqw − 16px, 43rem)`.
  - It has `data-testid="floating-chat-panel"` and carries the file drag-and-drop handlers.
- **[O] Elsewhere in the build.** The other new strings belong to the Assistant's voice-call surface ("Granny", "Assistant call", "Call tasks") and to Assistant tasks. Dictation copy is now shared with a global voice-typing feature ("Your recent dictations", "Input device for voice typing"). None of this changes the chat bar.

## 1. Component and where it is used

- **[O] One shared composer**, `ChatInput`, is used by:
  - the floating bar and panel (notes, Home, folders, search)
  - the docked sidebar `aside#multi-chat-sidebar`
  - the full-page Chat
  - the inline input in folder/space headers
- **[O] Root:** `div#chat-input` with `data-testid="chat-input"`.
- **[O] Props:** `chatContext, chatStatus, onSendMessage, onStopGeneration, disabled, disabledMessage, selectedFiles, onRemoveFile, handleSelectFiles, isEditingMessageIndex, onCancelEdit, isFloatingChat, hasExistingMessages, isInputFocused, floatingChatState, isStreamingText, onFocusChange, compact, hideModelSelect`.
- **[O] Other composers that are not this component:**
  - **Quick-chat window:** behind a flag; Alt+Space; 620×104.
  - **MiniStation:** a textarea.
  - **Assistant:** a textarea, "Message Assistant".

## 2. The input

### Editor
- **[O] A TipTap/ProseMirror contenteditable,** not a textarea, with these extensions:
  - doc, paragraph, text, history
  - placeholder
  - typography
  - paste-as-plain-text
  - `recipe` (an inline atom)
  - `document` mention (an inline atom)
  - a keyboard-shortcut extension
- **[O] Behaviour:**
  - Spellcheck is off.
  - The editor box is `max-h-[240px] overflow-y-auto text-base`.
  - The placeholder is drawn with `::before { content: attr(data-placeholder) }`, and its text is read from a ref so it can change without rebuilding the editor.

### Sizes
- **[O] Non-compact (floating, folder header):**
  - The bar is `min-h-14 rounded-[28px] border`; the inner row is `py-1 pl-5 pr-2`; the action cluster is `min-h-[47px]`.
  - Once the text contains a newline, the editor takes the full width (`pt-2.5`) and the actions wrap onto their own row.
- **[O] Compact (sidebar, Chat page):**
  - The editor row is `pt-2 pl-4`.
  - A toolbar row below it (`pr-2 pb-1.5 pl-1.5`) holds attach and model on the left, and mic/send on the right.

### Shell
- **[O] Focused:** an accent border plus `ring-3` in accent at 20%.
- **[O] At rest:** a 0.5px hairline shadow plus `0 4px 6px -2px rgb(0 0 0 / .05)`.
- **[O] Disabled:** `opacity-50 pointer-events-none cursor-not-allowed`.
- **[O] Clicking the bar:** a mousedown anywhere on the bar that isn't a button or menu focuses the editor, and expands a collapsed floating bar.
- **[O] Hover glow:** on a collapsed, unfocused bar, a 1024px radial gradient (white 5% fading out by 500px) follows the mouse. It fades in over 300 ms.

### Placeholder (first match wins)
1. **[O] Disabled:** the disabled message, else a "transcribe a meeting first" message.
2. **[O] Dictation is transcribing:** "Transcribing...".
3. **[O] Floating bar collapsed:**
   - while text streams: "Replying...";
   - before any output: "Thinking..." first, then every 3 s a different word from a small list. The starting word is chosen by hashing the last send time.
4. **[O] A note is dragged over the bar,** or notes are multi-selected: "Drag & drop note(s)".
5. **[O] Text is selected in the note editor** and the bar is not focused: "Chat with selected text".
6. **[O] The thread has messages** and the bar is collapsed: "Continue chat".
7. **[O] By context:**
   - folder/list: "Ask about folder"
   - view: "Ask about notes in this view"
   - meeting, global and the rest: "Ask anything"

   A caller-supplied override replaces these. The Chat page rotates sample questions; a folder with no notes reads "Add a note to this folder to start chatting".

### Keyboard
- **[O] Enter, default ("send"):** Enter sends. Shift+Enter inserts a newline. Mod+Enter also sends.
- **[O] Enter, "newline" mode:** Enter inserts a newline; Mod+Enter or Shift+Enter sends. The setting is "Chat Enter key behavior", with options "Send message" / "New line (⌘⏎ to send)". The send tooltip shows `↵` or `⌘ ↵` to match.
- **[O] Enter while a response streams:** stops the response.
- **[O] Menus:** ↑/↓ or Ctrl+P/Ctrl+N move; Tab or Enter selects; Esc closes (capture phase).
- **[O] Esc on the bar:** collapses the floating panel and blurs; closes the docked sidebar; goes back from full-page Chat.
- **[O] Mod+J:** toggles or focuses the floating chat. In a meeting with chat open it switches the panel to the transcript.
- **[O] Mod+N:** new chat.
- **[O] Mod+T:** starts dictation, or submits a recording in progress.
- **[O] No ↑ history recall.**

### Send / stop / mic button
- **[O] Shape:** one size-8 round icon button.
- **[O] States:**
  - **Sendable:** accent, labelled "Send message".
  - **Generating:** soft, with a stop icon (stops the response).
  - **Nothing typed, no files, not generating:** a soft microphone, with tooltip "Ask anything" plus the Mod+T hint.
  - **Disabled:** when there is no text and no files, or a file is still processing.
- **[O] Motion:** icons swap with `AnimatePresence mode="wait"`, scale 0.5→1 plus a fade, over 0.1 s.

### Dictation
- **[O] While recording:** the editor is replaced by a scrolling waveform and an mm:ss timer in accent colour, with "Cancel dictation" (Esc) and "Send dictation" (⏎ or Mod+T) buttons.
- **[O] Limits:** recordings auto-send at 10 minutes, with a warning at 9 minutes.
- **[O] Result:** if the editor is empty the text is sent immediately; otherwise it is appended after a space.
- **[O] How Granola does it:** it uploads the audio and calls `transcribe-audio`.
- **Cereal:** transcribes locally with whisper.cpp, or with Deepgram prerecorded.

### Edit mode
- **[O]** Editing a sent message shows a banner "Everything after the edited message will be overwritten" with an X to cancel. On send, the history is cut at that message and its id is reused.

### Error states
- **[O] Error banner:** red, with "Retry" and "Start new chat".
- **[O] Messages:** a separate one for a model refusal, and one for no response.
- **[O] Stopping:** the partial answer is kept and marked as stopped.

## 3. Chips (context and files)

- **[O] Where they show:** in a chip row above the editor, which animates height 0→auto over 0.1 s. Chips appear for:
  - mentioned notes
  - notes dragged in
  - multi-selected notes
  - "Selected text" from the note editor (with a pulsing skeleton while the selection is being made)
  - uploaded files
- **[O] Chip:**
  - `h-7 rounded-full ring ring-inset gap-1 pl-2 text-sm`.
  - Icon: a 16px thumbnail for images, or a file glyph with the extension in 8px text.
  - Label: middle-truncated (the head plus the last 8 characters when over 16 characters), `max-w-40`.
  - Remove: a size-5 round X, with tooltip "Remove".
  - A spinner shows while the file is processing. Clicking opens a preview lightbox.
- **[O] Overflow:** chips that don't fit collapse into a "+N" pill that opens a menu.
- **[O] Sent messages:** show their context chips right-aligned, at 70% width.

## 4. Recipes (`/`)

- **[O] Trigger:**
  - `/` works only at the start of a line.
  - Spaces are allowed in the query, but the menu aborts if the query starts with a space or contains a double space.
  - The first character typed after `/` is capitalised.
- **[O] Choosing a recipe** inserts an inline atom `recipe {id, slug}` plus a space. It renders as an icon plus the title-cased slug.
- **[O] Backspace on a recipe node** turns it back into editable text.
- **[O] Closing the menu without choosing:** the typed text is matched against slugs and converted to a node if one matches.
- **[O] Serialisation:** the node serialises to `/slug`, and to the recipe id at send time.
- **[O] Menu sections:** "Recent" (the top 3 for this context, only when the query is empty), "My recipes" and "All recipes".
- **[O] Search:** fuzzy matching on slug and description.
- **[O] Header:** "Recipes", plus "Create" (pre-filled from the query) and "Browse".
- **[O] Rows:** `rounded-2xl p-1.5 pr-3`, each with:
  - a 28px icon tile on a gradient chosen by hashing the id
  - the title-cased slug
  - a one-line description
  - "Used N times" (shown at 5 or more)
- **[O] Empty:** "No recipes found matching “q”".
- **[O] Sidebar/inline variant:** height 0→auto and opacity over 0.2 s easeInOut. The panel is `rounded-[20px] border-black/15 bg-white/60 backdrop-blur-xl`.
- **[O] Suggestions:**
  - **Collapsed bar:** a random high-priority recipe as an inline chip (`h-9 rounded-full`, hidden below `sm`).
  - **After an answer:** "Say more" (more detail, `response_style: detailed`).
  - **Under the floating panel:** up to 5 recipe ghost buttons (only those that fit), plus "All recipes", which types `/`.
  - **Chat page:** a "Recipes" label, chips, and "See all".

## 5. @-mentions

- **[O] What can be mentioned:** notes only.
- **[O] Trigger:** `@` anywhere in the text; spaces are allowed.
- **[O] Search:** local note titles LIKE `%q%`, newest first, limit 50, skipping notes already mentioned. It is debounced at 200 ms.
- **[O] Menu:** header "Notes"; rows show a doc icon, the title with the match in bold, and a relative date. A spinner shows while loading. Empty states: "No notes found matching “q”" / "No notes yet".
- **[O] Node:** `document {id, title}`, rendered as a tertiary "@" plus the title. It serialises to `@<uuid>`, and sent messages show `@Title`.

## 6. Model picker

- **[O] Data:** `get-chat-models` returns `{groups, models[{api_id, label, provider, groupId, disabled, default, is_new, info_text}], defaults{single, multi}}`.
- **[O] Trigger:** a ghost button (`px-2 py-2`) with the current label (or "Auto") and a chevron. Tooltip: "Select AI model".
- **[O] Menu:** `w-58`, with "Auto" first and then the models grouped. Each row has a provider icon, a "NEW" badge and an info tooltip.
- **[O] Locked by the workspace:** the trigger is disabled and reads "Model set by your workspace".
- **[O] Selection:** stored separately for single-meeting chats and multi-note chats; defaults to `auto`.
- **[O] No web-search toggle.** Recipes can turn web search on.

## 7. Files

- **[O] Button:** "Upload files or images" (`data-testid="attach-file-button"`), size-8 round, with a paperclip icon. A hidden `input type=file multiple` sits behind it.
- **[O] Accepted:** .doc, .docx, .xls, .xlsx, PDF, JSON, PNG, JPEG, `text/*`, Markdown.
- **[O] Limits:**

  | Limit | Value |
  | --- | --- |
  | Files per batch | 200 |
  | Size per file | 30 MB |
  | Size per chat thread | 30 MB |
  | PDF pages per file | 100 |
  | PDF pages per thread | 100 |

- **[O] Images:**
  - Larger than 1568px on a side, or in a mismatched format → re-encoded with the longest side at most 1568px.
  - A file whose real format doesn't match its type is rejected.
- **[O] Paste:** clipboard files are attached. Plain text over 5,000 characters becomes a `.txt` file.
- **[O] Drag and drop:** an overlay with three fanned file illustrations (rotated −6°, 0°, +6°). It shows an "unsupported" state for invalid drags.
- **[O] Lifecycle:** upload URL → PUT → `process-attachments`, which returns markdown and a token size, or a rejection.
  - A rejection is toasted and the file is cleaned up.
  - Removing a chip deletes the attachment.
  - Sending is blocked while any file is still processing.

## 8. Surfaces and layout

### Floating bar and panel
- **[O] Bar position:** centred, `bottom-4`, `max-width: min(100cqw − 16px, 43rem)`, `min-w-60`.
- **[O] Bar shape:** `rounded-[28px] bg-surface-elevated`, with a hairline ring when idle.
- **[O] Panel states:** `floatingChatState` is `idle | chat | transcript`.
- **[O] Expanded panel:**
  - Card: `rounded-[32px] ring-0.5`.
  - Motion: spring 0.2 s, bounce 0.2 opening and 0 closing; opacity and scale 0.98→1.
  - Height: 400px by default, minimum 160px, resized from a top handle (an `h-4 w-48` hit area).
- **[O] Backdrop:** a full-screen layer collapses the panel when clicked, and forwards wheel scrolling to the page underneath.
  - **Cereal differs (user decision, 2026-10-21):** there is no layer. A press anywhere outside the open panel collapses it and still reaches what was pressed. The layer had also covered the toolbar, so every button there took two clicks.
- **[O] Disclosure:** an 11px line about AI mistakes.
- **[O] Things that sit above the bar** (Enhance notes, meeting chrome) use the anchor positioning described in the delta.

### Docked sidebar
- **[O] Element:** `aside#multi-chat-sidebar`.
- **[O] Width:** 330px, growing to 440px once there are messages, maximum 720px. It is resized from the left edge (a `w-2 cursor-ew-resize` handle).
- **[O] Docking:** at `@5xl/view` (64rem) it is `relative` with no shadow. Below that it floats as `absolute w-80 rounded-[20px] shadow-lg`.
- **[O] Closing:** outside clicks close it.
- **[O] Header:** "Recent chats" (history dropdown), "New chat" (⌘N) and "Maximize" (opens the thread in full-page Chat).
- **[I] Which pages use it:** list pages (Home, folders, views) render both the floating bar and the sidebar. The sidebar appears once chat is open, and the conversation lives there. Note pages render only the floating chat, whose panel expands upward.

### Full-page Chat
- **[O] Empty state:** "Hi {first name}, ask anything" (`text-h3`, `pt-[120px]`), the compact input, recent threads and recipe chips.
- **[O] Conversation:** the composer sits at the bottom (`max-w-2xl px-2 pb-4`).

## 9. Sending

- **[O] Request:** a POST to `chat-with-documents`, streamed. The body carries:
  - `thread_id`, `assistant_message_id`
  - `chat_history`:
    - USER entries: `{text, file_attachments, messageContext}`
    - ASSISTANT entries: `{text, outputs, toolCalls}`
  - `document_ids`, `chat_context`
  - `prompt_config {response_style, input_values, model}`
  - `attachment_ids`, `edit_with_ai`, `web_search`, `user_timezone`
- **[O] Before sending:** pending tool approvals are automatically denied.
- **[O] After the first reply:** the thread title is generated.

## Cereal mapping and deviations

| Granola | Cereal |
| --- | --- |
| Server `process-attachments` | Local processing in `src/main/attachments/`. Text is extracted from PDF, docx and xlsx; images are resized in the renderer. Files are uploaded to the **selected model provider's own Files API** the first time they are needed (Anthropic Files API, OpenAI Files + Responses `input_file`/`input_image`, Gemini Files API); Ollama gets images inline and text otherwise. |
| `get-chat-models` (server catalogue) | `src/shared/models.ts`, a curated list merged at runtime with configured keys and Ollama's installed models. Providers without a key are shown disabled. |
| Workspace model lock | Not applicable (single user). |
| `.doc` / `.xls` (legacy binary) | Rejected with a hint to save as `.docx` / `.xlsx`. |
| `transcribe-audio` (dictation) | Cereal's configured engine: whisper.cpp or Deepgram prerecorded. |
| Provider logos in the model picker | Monochrome letter-marks. |
| Folder-scoped chat ("Ask about folder") | Folder pages use the all-meetings chat for now; Cereal's chat has no folder scope yet. |
| Thinking words, sample questions, drop-overlay text | Behaviour as observed; Cereal's own wording. |
| Quick-chat window, list multi-select, web search | Deferred. |
