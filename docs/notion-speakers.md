# Speaker attribution: Notion AI Meeting Notes findings → Cereal spec

This is the behavior spec for how Cereal works out who is speaking when. It comes from static analysis of
Notion's shipped web client (build 23.13.20261020.1417, the code the desktop app loads) and its "Meetings"
Chrome add-on for Google Meet (v1.0.3.0). Nothing here is Notion code, prompts or assets. Cereal reimplements
the behavior below.

| Item | Value |
| --- | --- |
| Web bundle | `~/re/notion/web/23.13.20261020.1417/` (never committed) |
| Meet add-on | CRX `bmfgmiihbljnfndmpdffjfliciaddbfc` v1.0.3.0, `~/re/notion/meet-addon/` |
| Desktop app | `Notion Setup 7.39.0.exe` (Electron), `~/re/notion/7.39.0/` |
| Raw notes | `~/re/notion/evidence/*.md` |

**[O]** marks a fact observed in shipped bytes; **[I]** marks an inference.

## 1. Three layers

Notion attributes speech in three independent layers. Each one can only add information.

1. **Per-source diarization (server).**
   - **[O]** Mic and system audio are captured and sent as separate mono 16 kHz streams. Notion calls this
     "dual source" ingest.
   - **[O]** Each source gets its own speech-to-text provider session. The provider (AssemblyAI streaming
     with speaker labels by default) returns a segment-level speaker label scoped to that session.
   - **[O]** Labels can be revised later, and no word timings reach the client.
   - **[O]** If the provider can't diarize, ingest falls back to a single mixed stream.
2. **Source-aware labels (client).** These turn session-scoped labels into names, using the stream a label
   came from plus the calendar (§2).
3. **Meeting-platform names (client, optional).** Live speaker activity is read from the meeting app and
   matched to transcript segments by overlap voting (§4). **Not built in Cereal** (user decision,
   2026-10-20).

## 2. Source-aware labels (built in Cereal)

**Scope [O].** Labels are computed per *recording session × source × provider session*. Cereal's provider
session is one Deepgram socket, so a reconnect starts a new one and labels never carry across it.

**Dominant label [O].**
- Count transcript characters per diarized label within the scope.
- The dominant label is the unique maximum. A tie means there is no dominant label.
- Its confidence is its share of all characters in the scope.

**Mic [O].**
- The dominant mic label is the note-taker when its share is at least **0.9**, or at least **0.75** in a 1:1
  meeting.
- **[I]** Below that, the mic is hearing several people (an in-person meeting). In Cereal, its labels then
  become numbered speakers.

**System audio [O].**
- In a 1:1 where the dominant system label's share is at least **0.75**, system speech gets the other
  attendee's name.
- Otherwise Notion shows a generic "Others".
- **Cereal deviation (user decision).** It numbers the voices Speaker 1, Speaker 2, … by first appearance,
  and each can be renamed.

**What counts as a 1:1 [O].**
- The calendar event has exactly two attendees, the note-taker is one of them, and the recording has both mic
  and system audio.
- The other attendee's display name is used, falling back to their email.

**User assignments.** Cereal adds these on top of Notion's behavior.
- A name the user gives a label (the speakers chip or a bubble label) overrides everything above.
- Two labels with the same name read as one speaker.

**No diarization (local Whisper).** Each stream is a single label with confidence 1.0, so the mic is the
note-taker and system audio is "Them", or the attendee in a 1:1.

## 3. Echo bleed

**[O]** Notion turns on system-wide echo cancellation for the mic whenever it splits sources.

Cereal captures through PipeWire with no echo cancellation, so remote speech played on speakers reaches the
mic. **Cereal guard (not from Notion, `src/shared/micBleed.ts`).** A final mic chunk is treated as an echo and
hidden (never deleted) when all three hold:
- it has at least 3 words;
- it overlaps a system chunk within ±1 s;
- at least 60% of its words also appear in that system chunk.

The guard ignores diarization, so it also works with local Whisper, where the echo would otherwise be
labelled as the note-taker. Hidden chunks are left out of speaker counts, transcript bubbles, copies and prompts.

## 4. Meeting-platform names (reference only, not built)

**Google Meet add-on [O].**
- **Audio signal.** It wraps the page's peer connection. Every 200 ms it reads the per-source audio levels
  of incoming audio. A source counts as speaking at level ≥ 0.02 when its sample is at most 500 ms old, and
  idle sources are dropped after 60 s.
- **Utterance boundaries.** An utterance ends after 600 ms of quiet. A gap of more than 1.5 s starts a new
  one, and open utterances are re-sent every 5 s.
- **Naming.** A participant is attached only after three consistent samples where exactly one source is loud
  and exactly one participant tile shows Meet's speaking animation. A change of participant splits the
  utterance.
- **Output.** Upsertable intervals `{key, participant?{id, name}, startMs, endMs}` on the wall clock. They go
  to the desktop app over Chrome native messaging and to open Notion tabs.

**Zoom [O].**
- The desktop app samples Zoom's accessibility tree every 500 ms, looking for "is talking" style markers.
- The search goes to depth 20 and visits at most 5000 nodes.
- Timing: 1 s stability, 1 s hangover, 5 s flush, and a 2 s grace period when only one remote participant
  is left.

**Voting [O].** Re-run every 5 s, 1 s after transcript writes, and once more at stop.
- **Segment match.** A segment takes a participant when that participant covers at least 50% of it with a
  share of at least 0.7. Unnamed activity also competes.
- **Cluster match.** A whole label takes a participant when they overlap it by at least 2 s, at a share of
  at least 0.7 and at least 50% of the label's duration. This applies only if at least 80% of that label's
  segment matches agree.
- **Neighbour fill.** An unmatched segment of 6 s or less between two same-name neighbours (gaps of 2 s or
  less) inherits that name at 0.9 × the weaker neighbour's confidence.
- Mic segments are never renamed by platform activity.

## 5. Desktop shell (Notion 7.39.0)

Static reads of the Windows installer (verified against `latest.yml`) and the mac arm64 DMG. The raw notes are
`~/re/notion/evidence/notion-7.39.0-desktop-findings.md`.

- **[O] Thin wrapper.** The desktop app (Electron 44) loads the web app remotely. It has no meeting code of its
  own, does no resampling or mixing, and has no echo cancellation or noise suppression anywhere.
- **[O] System audio** comes from the web app's own screen-capture request, which the shell grants only to
  Notion origins.
  - mac 14.2+: an audio-only Core Audio tap.
  - Otherwise: a loopback stream through ScreenCaptureKit (mac) or Chromium's WASAPI loopback (Windows).
- **[O] Frame relay.** A newline-JSON relay of base64 Float32 frames exists only for remote-desktop sessions
  and for a Linux Flatpak `audio_proxy` helper. The helper doesn't ship in these builds.
- **[O] Meet add-on relay.** A small native-messaging host, registered for Chrome only and authenticated with a
  token file, passes the add-on's speaker intervals through unchanged.
- **[O] Zoom (mac only).**
  - **Sampling:** Zoom's accessibility tree is sampled every 500 ms.
  - **Speaking signals:** a final whole-word status part ("…, is speaking"), Zoom's localized "Talking:" label,
    or a tile moving alone to the end of the gallery.
  - **Timing:** a speaker's interval closes after a 1 s hangover, and open intervals are re-sent every 5 s. A
    name is attached only after 1 s of stable identity.
  - **Sole remote:** when there is exactly one unmuted remote participant, they count as speaking after a 2 s
    grace period.
- **[O] Call detection.**
  - **Windows:** microphone peak level and audio sessions, with hysteresis for Bluetooth mics.
  - **mac:** Core Audio process objects.
  - **Linux:** PipeWire links, like Cereal's detector.
  - **All platforms:** a vanished process is kept for 4 s. The web app decides which apps count as meetings.

## 6. Cereal data model

- `transcript_chunks.speaker`: the raw diarized label from the provider. Null when the engine doesn't
  diarize.
- `transcript_chunks.speaker_session`: the provider session, `<recording id>-<source>-<connection>`.
- `documents.speakers`: user assignments, as JSON `{"<source>:<session>:<label>": {name, email?}}`.
- Display names are derived at render and format time (`src/shared/speakers.ts`) and never stored, so the
  rules above can change without a migration.
