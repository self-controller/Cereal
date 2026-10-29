# Cereal

An AI meeting notepad for Linux. You jot down the few things that matter during a meeting. Cereal records your microphone and your speakers through PipeWire, so no bot joins the call, and transcribes both sides live. When the meeting ends, **Enhance notes** turns your notes and the transcript into clean, structured notes.

Cereal is a clean-room reimplementation of the workflow popularised by Granola, built from a reverse-engineering study of how Granola behaves (see [`docs/granola-findings.md`](docs/granola-findings.md)). It contains no Granola code, prompts or assets.

## Features

- **Notepad:** rich-text notes with headings, lists, checklists and links.
- **Live transcript:** "You" comes from the microphone and "Them" from the system audio. Choose either:
  - **Deepgram** streaming (cloud, best quality), or
  - **Whisper** via whisper.cpp (local, private).
- **Speakers:** with Deepgram, Cereal tells voices apart in each audio stream. In a 1:1 calendar meeting the call audio is named after the other attendee; in group calls voices show as Speaker 1, Speaker 2… until you name them with the "Identify speakers" chip under the title or the name above a transcript bubble. Names carry into the enhanced notes and chat. See [`docs/notion-speakers.md`](docs/notion-speakers.md).
- **Lecture mode:** for lectures and talks in the room. Cereal records only your microphone, labels it "Speaker" rather than "You", shows the transcript as timestamped paragraphs and writes study notes with the Lecture template. Start one from the tray, or switch any note with the mode chip under its title.
- **Enhance notes:** your notes are kept in full colour, and what the AI added from the transcript appears in grey.
  - Templates: Auto, 1:1, Stand-up, Customer call, Interview, Lecture, or your own.
  - You can regenerate with another template or rewrite with instructions.
  - The enhanced notes are editable; a line you edit turns full colour.
  - Hover a line and click its button to see the Transcript Summary: where it came from, with quotes that open the transcript at that moment.
- **Transcript in the chat bar:** click the recording widget next to "Ask anything" to show the live transcript, with Find and Copy.
- **Ask Cereal:** an agentic chat, about one meeting or across all your notes.
  - It searches and reads your notes, transcripts and calendar with tools, and cites the meetings it used.
  - In a note, it can edit your notes when you ask (with Undo) or rewrite the enhanced notes.
  - It drafts emails and calendar invites as cards you copy or open. Nothing is ever sent for you.
  - Recipes: saved prompts you run with `/`, such as `/follow-up-email`.
  - The chat bar works like Granola's (see [`docs/granola-chat-bar.md`](docs/granola-chat-bar.md)):
    - `@` points at another note.
    - Selected text in a note goes along as context.
    - **Files:** attach PDFs, images (PNG, JPEG), Word, Excel, Markdown, JSON or text by picker, paste or drag and drop. The chosen model reads them through its provider's own Files API. With Ollama, images go to vision models and other files go as text.
    - **Model picker:** switches any chat to another configured model.
    - **Dictation:** Ctrl+T asks by voice.
    - **Edit and resend:** a sent question can be edited and sent again.
- **Assistant:** a personal agent for multi-step work.
  - The conversation hands work to **tasks** that run in parallel and report back. A task can pause to ask you something or to get your approval.
  - **Routines** run on a schedule, for example "every Monday at 9, summarise last week's meetings".
  - It keeps a **memory** of what matters to you and loads **skills** (`SKILL.md` playbooks) when they apply. Both live in `~/.var/app/dev.cereal.app/config/Cereal/agent/`, the only folder it can read or write.
  - A **Home** briefing groups your open tasks.
- **AI providers:** Claude (default), OpenAI (Responses API), Google Gemini, or a local model through Ollama. Chat and the Assistant need a model that can use tools.
- **Search:** full-text search (Ctrl+K) over titles, notes, transcripts and enhanced notes.
- **Organisation:** folders.
- **Calendar:** Google Calendar shows upcoming meetings and sends a reminder before each one starts.
- **Meeting detection:** when Zoom, Meet, Teams, Slack or Discord starts using the mic, the floating widget asks whether to take notes, and Cereal stops when the call ends.
- **Floating widget:** a small pill at the edge of the screen while Cereal transcribes in the background.
- **Interface:** follows Granola's layout and motion closely (frameless window, resizable sidebar, note tabs, floating chat), with a navy accent. See [`docs/granola-ui.md`](docs/granola-ui.md).
- **Usage and cost:** Settings → Usage estimates what Cereal's API use costs. It counts the tokens each model request reports and the minutes of audio sent to Deepgram, then prices them with a built-in table (regular list prices; Ollama and Whisper are free). It shows totals by range, this month's pace, a daily chart, breakdowns by model and by feature, and what the same usage would cost on each other model. To change a price, click **Edit prices**, which opens `pricing.json` in the config folder; it overrides the table, field by field.
- **Local-first storage:** everything is kept in SQLite in `~/.var/app/dev.cereal.app/config/Cereal`. API keys are read from the `.env` file there, which you edit yourself.

## Requirements

- Linux with PipeWire and Flatpak.
- For cloud transcription: a [Deepgram](https://console.deepgram.com) API key.
- For local transcription: nothing to install, `whisper-server` is bundled. Download a model from Settings.
- For AI: an Anthropic, OpenAI or Gemini API key, or a running [Ollama](https://ollama.com).
- API keys go in `~/.var/app/dev.cereal.app/config/Cereal/.env`:
  - `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), `CEREAL_GOOGLE_CLIENT_SECRET`.
  - Cereal creates the file on first launch and adds lines for keys a newer version reads. **Open .env** in Settings opens it. Edits apply without a restart.
- Optional, for Google Calendar: your own OAuth client of type **Desktop app**, with the Calendar API enabled.

Use headphones on calls. Cereal does not cancel echo, so without headphones your speakers' audio also reaches the microphone.

## Install

Cereal ships as a Flatpak, which bundles everything it needs. It only needs PipeWire on the host.

```bash
flatpak install --user Cereal-0.1.0.flatpak   # the runtime and Electron base come from Flathub
flatpak run dev.cereal.app
```

**API keys:** edit the `.env` file with any editor, or click **Open .env** in Settings.
- **Who can read it:** the file lives in the Flatpak's own folder, so other Flatpak apps can't read it, even ones with access to your whole home folder. Cereal keeps it readable only by you (mode 600) and resets that if an editor changes it.
- **What it doesn't protect against:** like a password manager that's unlocked, it doesn't protect against programs you run outside Flatpak. On a laptop, use full-disk encryption.
- **Don't use `flatpak override --env=…` for keys.** It stores them in plain text where `flatpak info` shows them, and passes them to every process Cereal starts.

**Google Calendar sign-in:** the token Cereal gets from Google is encrypted with a key from the desktop's Secret portal (GNOME Keyring). Cereal gets no access to the rest of your keyring. If the desktop offers no Secret portal, Settings says the sign-in is stored unencrypted. One cause is a GNOME session started without `XDG_CURRENT_DESKTOP=GNOME`: `xdg-desktop-portal` then skips GNOME's backends.

**Permissions:**
- **Network:** for the AI and transcription APIs.
- **Display:** Wayland, plus X11 for the floating widget. Under GNOME Wayland, the widget can only stay on top at the edge of the screen as an XWayland window.
- **Audio:** PulseAudio and the PipeWire socket, for recording and meeting detection.
- **GPU, notifications and the tray.**
- **No file access:** attachments go through the file chooser.

**Building it:**
- `npm run flatpak` builds and bundles into `dist/Cereal-<version>.flatpak`, with a `.sha256` checksum. Add `-- --install` to install it for your user too, or run `npm run update-app`.
- **Build tools:** the script installs `org.flatpak.Builder`, the Freedesktop 26.08 SDK, Node 22 and the Electron BaseApp from Flathub.
- **Offline build:** it runs offline from `flatpak/generated-sources.json`, which is regenerated when `package-lock.json` changes.
- **App ID:** the app ID `dev.cereal.app` names the data folder. Publishing under another ID, for example on Flathub, would need an `end-of-life-rebase` so users keep their data.

## Develop

```bash
npm install          # also rebuilds better-sqlite3 for Electron
npm run dev          # run with hot reload
npm start            # build and run the production bundle, unpackaged
npm test             # unit tests (run under Electron's Node)
npm run e2e          # build + end-to-end smoke test with fake Deepgram/Ollama servers
npm run typecheck
npm run update-app   # test, rebuild and reinstall your Flatpak (add `-- --e2e` for the smoke test)
npm run flatpak      # test, build the Flatpak and bundle it in dist/ (add `-- --install` to install it)
```

Unpackaged runs (`npm run dev`, `npm start`) don't touch the Flatpak's data. They use their own profile in `~/.config/Cereal`, created empty, with its own `.env`. They need PipeWire's tools from the host (`pipewire-utils`), plus `whisper-server` for local transcription (on Fedora, `sudo dnf install whisper-cpp`).

Environment overrides:
- **Profile:** `CEREAL_USER_DATA` points Cereal at a separate profile directory.
- **Deepgram URL:** `CEREAL_DEEPGRAM_URL` replaces the Deepgram endpoint, for testing.
- **AI URLs:** `CEREAL_ANTHROPIC_URL`, `CEREAL_OPENAI_URL` and `CEREAL_GEMINI_URL` replace the API endpoints, for testing. `CEREAL_DEEPGRAM_LISTEN_URL` replaces Deepgram's prerecorded endpoint (dictation).
- **Agent process:** `CEREAL_AGENT_IN_PROCESS=1` runs the agent loop in the main process instead of its utility process.
- **Keys:** the same variables set in the shell are used when `.env` leaves them empty. The `.env` file wins when both are set.

## Architecture

```
src/main/        Electron main process
  audio/         PipeWire capture (pw-record) + device list + meeting-app detection
  transcription/ Deepgram streaming, whisper.cpp server + VAD segmenter, model downloads
  recorder.ts    capture → transcription → transcript chunks (interim/final merge)
  ai/            prompt variables, Cereal's prompts, enhance/rewrite/title service
  llm/           Claude / OpenAI / Gemini / Ollama streaming providers, with provider-neutral tool calling and
                 per-provider file uploads
  attachments/   chat files: validation, text extraction (PDF, docx, xlsx), the per-provider upload cache
  agent/         the agent: runtime loop (runs in a utility process), backend (runs, tools, approvals,
                 event log), tools, agentic chat, the Assistant (tasks, inbox, routines), sandboxed files
  db/            SQLite schema, migrations, store (FTS5 search), the agent's store and the usage store
  usage.ts       records API usage (each provider reports a request's tokens through `onUsage`) and loads prices
  calendar.ts    Google Calendar (loopback OAuth + PKCE)
  detector.ts    meeting start/end detection
src/preload/     contextBridge exposing a typed invoke/on API
src/renderer/    React + Tailwind + TipTap UI and the floating widget
src/shared/      types, IPC contract, agent types and event reducer, transcript merge, markdown, attribution,
                 the price table and the usage roll-up
```

The agent mirrors how Granola's is built (docs/granola-findings.md §11). The **runtime** runs the model/tool loop in an
Electron utility process. It talks to the **backend** in main over a small action protocol: claim a run, append to the
model transcript, call a tool, report events, suspend for approval, finish. The backend owns SQLite and runs the tools.
Every Assistant run records numbered events that the UI replays to stream and catch up. The model transcript is
append-only, so a run that waits for approval resumes exactly where it stopped, even after a restart.
