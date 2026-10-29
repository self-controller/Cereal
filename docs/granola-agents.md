# Granola 7.663.2: agent architecture (REA findings)

This document is a companion to `granola-findings.md`. It covers every agent-like system in the shipped Granola desktop client.

**Sources.** The analysis was static. The artifact was `~/re/granola/7.663.2/app/resources/app.asar` (sha256 `321f76e03e3a5bc1ed4d734fb5a40cfde075953659230374dd4618d45f0a2f25`). REA's JavaScript analyzer located the modules, export shapes and source ranges. The bytes at those ranges were then read as inert text. Nothing was executed.

**What this document records.** Only names, enums and data shapes are recorded. No Granola code is reproduced, and no prompt text ships in the client: every agent prompt lives on the server.

Tags follow `granola-findings.md`: **[O]** observed in shipped bytes, **[I]** inference, **[?]** open unknown.

## REA provenance

| Evidence | What |
| --- | --- |
| `ev_82a83c73f99bf9860d57f56c7491fa53d5ce3346d566197226b1bbd9631a43c5` | JS application analysis of 22 selected sources, the agent chunks plus main and preload. It recorded 5,584 findings. |
| `ev_36b263d8191fb41fbbe5ea5bf91ca583620da1424f8abedf832f0cf517c4730a` | Summary view of that analysis |
| `ev_6e24c9af0f215f0df081f0694ddfa6b0be82644005648f87934316a69ea1c35d` | Endpoint facts: 44 rows, mostly dynamic `fetch(e)` calls |
| `ev_5565086f19bf5b365c4f2e20e5076847a3a32833739fa770b311f605cb855759` | Module export and return-shape facts. These led to the Hermes `bot-chat` reducer. |
| `ev_81b9181b89457811b63098358f64292b23ab7d52870e2c68d38c2ca023257915` | Semantic trace seeded on the request field `chat_history`. No seed node matched. |

The full session was exported to `~/re/granola/evidence/granola-7.663.2-agents-evidence.json`.

**Limits.**
- **Integrity policy.** The analysis ran with `integrity_policy: record-and-continue`. Seven unpacked `.node`/`.exe` members fail their ASAR integrity hashes, which is consistent with signing after packing. None of the JavaScript analyzed here is affected.
- **Dynamic request wrappers.** Requests go through dynamic wrappers: `$(token, "<endpoint>", {input})`, `X.getAPIEndpoint(name)` and `Sa(name)`. REA cannot trace request fields through them, so field-level request shapes come from the zod schemas.
- **`primary-*.js`.** Semantic analysis of `primary-*.js` (4.8 MB) never started, because the result budget ran out. Its static facts were kept.
- **Unselected sources.** 880 unselected files remain outside the analysis scope.

**Chunks cited** (sha256 prefix):

| Chunk | sha256 prefix |
| --- | --- |
| `api-C8TM1NqZ.js` | `f77f5fae2a34b565` |
| `entity-schemas-CSi0NuU1.js` | `a86b2c23b6a1bfff` |
| `multiChatStore-V0PZf-sj.js` | `ca4944bb30cb8e6b` |
| `primary-CXVdv0fU.js` | `3bd198b715f97bb4` |
| `namespace-B6iZFaY8.js` | `a55ec548db981bf0` |
| `AssistantPage-BbBsnVH-.js` | `8cb5f85ea634c303` |
| `api-D06Xbt1r.js` | `d6057cb1a85cf877` |
| `bot-chat-c0KgMteC.js` | `ac51ce0ea91b3e1c` |
| `setup-BiFt_c3N.js` | `0be807eb262b33de` |
| `HermesRoute-cWIVG9GH.js` | `0520716766f555a9` |
| `reminderAgent-Dd0yVAEp.js` | `e3366cbd54a96ed2` |
| `reminder-agent-notification-CtzfQGZk.js` | `aab441c2479dc7ee` |
| `quick-chat-DD0YWFYd.js` | `ae124bbd6cbbc54b` |
| `types-Ddt9D0Pg.js` (URL map) | `76b0e4c9534ab060` |
| `dist-electron/main/index.js` | `fbc0da27f4359a88` |
| `dist-electron/preload/preload.js` | `1a7efed433848b56` |

## Overview: six agent surfaces

All model and tool execution happens on Granola's servers. The desktop app is a thin client: it streams events, renders tool calls and approvals, and applies some note edits locally.

| # | Surface | Transport | Client code |
| --- | --- | --- | --- |
| 1 | **Ask chat**, the agentic chat | `stream.api.granola.ai/v1/chat-with-documents` (`-web` variant). The response is JSON chunks split by a delimiter. | `api-C8TM1NqZ.js` (stream reader and chunk parser), `entity-schemas-*.js`, `multiChatStore-*.js` |
| 2 | **Assistant** ("Keto") | Actions go to `cinnamon.api.granola.ai/v1/keto-gateway`. Events come back on `stream.api…/keto-socket`, as SSE carried over a POST fetch. | `primary-*.js`, `namespace-B6iZFaY8.js`, `AssistantPage-*.js` |
| 3 | **Buddy** ("Hermes"; the error copy says "Buds") | `stream.api…/raisin`. The client POSTs a zod `{action}` union, and the stream comes back as NDJSON packets. | `api-D06Xbt1r.js`, `bot-chat-*.js`, `setup-*.js`, `HermesRoute-*.js` |
| 4 | **Granny**, voice calls | WebRTC. The SDP offer is POSTed to `granny-live.<domain>/v1/granny/session`, events arrive as NDJSON from `/v1/granny/events`, and `/v1/granny/command` takes commands. | `AssistantPage-*.js` |
| 5 | **Dispatch**, post-meeting drafts | `draft_preview` chat outputs and threads with `initiated_by: dispatch` | `entity-schemas-*.js`, the `dispatcher-notification:*` IPC |
| 6 | **Reminder agent**, proactive cards | A reminder and commitment store, with its own card window | `reminderAgent-*.js`, `reminder-agent-notification-*.js` |

A floating **Quick chat** window also exists: `quick-chat:visible|submit|dismiss` and `mountQuickChatWindow`.

The `api_urls` map in `types-Ddt9D0Pg.js` lists agent endpoints beyond these six. **[?]** Their purposes are only partly known:
- `granny-agent`, `granny-edits`, `granny-metadata`, `granny-personal-instructions`, `granny-voice-traces`
- `keto-prompts`, `raisin-tools`, `read-durable-stream`, `llm-proxy-stream`
- `cloud-agent`, `cloud-agent-connector`, `get-cloud-agent-connectors`
- `mcp-server`, `mcp-registry`, `mcp-tool-execute`, `mcp-oauth-start`, `manage-mcp-token`, `mcp-info`
- `photon-assistant`, `agent-adk-demo`, `draft-dispatch-playground`, `run-dispatch-playground`, `enqueue-dispatch-classifier`, `admin-long-running-tasks`

## 1. Ask chat (agentic chat)

- **[O] Transport.**
  - The client POSTs JSON to `chat-with-documents`, with a 30 s timeout and 2 retries.
  - The body is read incrementally and split on a fixed delimiter. Each part is JSON-parsed.
  - Chunk types:
    - `text_delta {delta}`
    - `context_sources_delta {numTotalSources, scannedDocuments, citationIds, webSearch}`
    - `context_limit_reached`
    - `outputs {outputs}` and `output_delta {index, output}`. An `output_delta` replaces the output at `index`, or appends it if `index` is past the end.
    - `stream_completed {reasoning{text, durationSeconds}, contentType text|chat_with_citations, response|responseText, outputs, changedBlocks, metadata, braintrustSpanId}`
    - `error`
  - Unknown chunk types are logged and skipped.
- **[O] Chat context object.**
  - `currentViewContext` is a discriminated union over `view`. There are 8 variants, each with its own fields:
    - `meeting`, `live-meeting`: `meetingId`, `userSelectedText`, `relatedMeetings`, `preMeetingBrief`
    - `global`: counts, oldest/newest/recent/upcoming meetings
    - `list`, `web-list`: folder metadata, files, `activeTab notes|files`, space type
    - `shared-with-me`
    - `search`: `query`, `type person|company|freeform`, `documentIds`
    - `view`
    - `mcp`
  - It sits alongside these fields:
    - `mode`: `all|recent|…|deepdive`
    - `includeTranscripts`
    - `selectedDocuments`
    - `additionalContext {userSelectedDocuments, userMentionedDocuments, changedBlocks}`
    - `directoryContext`: the folder tree (favorites, my notes, shared, team, spaces)
- **[O] Message outputs.** An assistant message's `outputs[]` contains:
  - `reasoning {text, durationSeconds}`
  - `text {text}`
  - `text_with_citations {plain_text, response_lines[{answer_text, citations[], line_index}]}`
  - `draft_preview` (see Dispatch)
  - `tool_call`
- **[O] Citations.** A citation is `{message_id, meeting_id, brief_id, response_line_index, message_index}`. It can also carry:
  - `citation_source_type`: `transcript|summary|pre_meeting_brief|email|calendar|web`
  - `citation_source_quote`
  - an email, calendar or web reference
- **[O] Tool-call base fields.** These are shared by every tool:
  - **Identity and streaming:** `id`, `argsDelta` (arguments streamed as text).
  - **Display:** `renderInline`, `isVisibleInChat`.
  - **Provider execution:** `providerExecuted`.
  - **Provider replay:** `providerReplayKey` is one of `anthropic|vertex-anthropic|bedrock|openai|xai|google|vertex-google|baseten`. `providerCallMetadata` and `providerResultMetadata` hold opaque per-provider data.
  - **Lifecycle:** `completed`, `startedAtMs`, `completedAtMs`, `reverted`, `error`.
  - **Confirmation:** `confirmationRequired`, `confirmationStatus pending|confirmed|cancelled`. This is separate from approval.
  - **Approval:** `approval {id, status pending|approved|denied, reason, proposedArgs}`.
- **[O] Tool catalogue.**
  - The tool-call union is discriminated on `name` and has **82 distinct literal names**.
    - One of them is the placeholder `$FUNCTION_NAME`.
    - `react_to_message` is not among the literals. It is referenced through a constant, so it brings the count of real tools back to 82.
  - Two dynamic families sit alongside them:
    - **MCP tools:** any name matching the MCP name predicate, carrying `mcpConnectionId`, `mcpServerUrl` and `mcpToolTitle`.
    - **Connector tools:** carry `connectorActionId`, `connectorKey`, `connectorConnectionId` and `connectorDisplayName`.
  - Named tools by area:
    - **Meetings:**
      - `searchMeetingsByKeywords`, `searchMeetingsByPeople`, `searchMeetingsByPeopleAndCompanies`
      - `queryMeetingContext`, `listMeetings`, `getMeetings`, `fetchMeetings`, `exploreMeetings`, `listRequestableMeetings`
      - `readMeetings`, `readTranscript`, `readMeetingAttachment`, `readPreMeetingBrief`, `getBriefResearchContext`
      - `get_action_items`, `render_action_items`
    - **Notes and folders:**
      - `editMeetingNotes`, `rewriteMeetingNotes`, `organizeNote`, `shareNote`
      - `findNoteLocations`, `createFolder`, `findFolders`, `listFolderFiles`
      - `readFile`, `requestDocumentAccess`
    - **Calendar:**
      - `getUpcomingCalendarEvents`, `listCalendarEvents`, `searchCalendar`, `searchCalendarEvents`, `readCalendarEvent`
      - `draftCalendarEvent`, `editCalendarEvent`, `deleteCalendarEvent`, `respondToCalendarEvent`
      - `createFocusTime`, `createOutOfOffice`
      - `queryFreeBusy`, `searchRooms`, `getCoworkerSchedules`, `getCalendarStyle`
      - `appendEventNotes`, `editEventNotes`, `readEventNotes`
    - **Email and Slack:**
      - `searchEmailThreads`, `searchEmailThreadsByTopic`, `searchEmailThreadsWithPerson`, `readEmailThread`
      - `writeFollowUpEmail`, `writeFollowUpSlackMessage`, `findExistingSlackGroupDm`
      - `getEmailWritingStyle`, `getSlackWritingStyle`, `getToneOfVoice`
    - **People:** `findPeople`, `resolvePerson`, `resolveGroup`, `searchPeopleAndCompanies`.
    - **Docs and CRM:**
      - `searchGoogleDocs`, `readGoogleDoc`
      - `listCrmFields`, `getCrmFieldValues`, `getCrmFieldExamples`, `updateCrmField`
    - **Access:** `resolveConnectorAccess {connector gmail|slack|google_docs, trigger}`, `requestGoogleWorkflowAuthorization`.
    - **Cross-connector search:** `search {connectors: 1–4 of slack|granola|gmail|calendar, queries: 1–5}`, which returns `candidates` and `providerErrors`.
    - **Generation:** `generateImage`, `generateExcalidrawDiagram`, `searchImages`.
    - **Agent self-management:**
      - `askUserQuestion`
      - `readChatSkill`
      - `memory_bash {command, change_note}`
      - `update_personal_instructions {revision, add[], remove[]}`
      - `granny_history {kind calls|reasoning, from, to, id, offset}`
      - `react_to_message`
      - `getCurrentTime`
      - `searchHelpArticles`
    - **Provider-executed:** `web_search`, `web_fetch`, `code_execution`, `toolSearch`.
    - **Placeholder:** `$FUNCTION_NAME`.
- **[O] `askUserQuestion`.**
  - The arguments are `{questions[1–3]{id, question, options[2–4]{label, description}, multiSelect=false}}`. Question IDs must be unique, and option labels must be unique within a question.
  - The result is `{answers: Record<qid, string[]>}`.
- **[O] `readChatSkill {skillName}`.** Returns `{skillName, instructions}` or `false`.
- **[I] Provider-executed tools.** `web_search`, `web_fetch`, `code_execution` and tool search line up with Anthropic's server tools, executed by the provider and marked `providerExecuted`. Deferred tool loading would sit behind `toolSearch`.
- **[O] Client-side edits.**
  - **`editMeetingNotes`** is applied to the editor on the client and can be undone with `reverted`. This is per the earlier pass and was not re-checked here.
  - **`changedBlocks`** returns with `chat_with_citations` completions.
- **[O] Client state.** The Ask chat store (`multiChatStore`) tracks:
  - per-thread streaming state: `assistantMessageId`, `streamingOutputs`, `status`, `streamingContextSources`, `meetingsContextLimit`
  - the selected models, `{single:"auto", multi:"auto"}`
  - an A/B evaluation mode (`evaluationDisplay {sideBySide, selectedVariant}`)
  - tool-call auto-focus timestamps

## 2. Assistant ("Keto")

- **[O] Client actions.** The client sends actions through `keto-gateway`, with the header `X-Granola-Workspace-Id`. The actions are:
  - `start {requestId, message}`, `stop {runId}`, `retry {runId}`
  - `activate`, `home {pendingInputIds}`
  - `instance {cursor{createdAt, runId, sequence}, publishedOnly, taskId, includeReasoning}`, which pages runs and events
  - `agent.control {requestId, mode restart|reset}`
  - `thread.read {limit}`
  - the `assistant.*` actions: `send`, `stop`, `conversation.open`, `task.read`, `task.stop`, `task.approve`, `viewing`, `call.send`, `call.heartbeat`, `call.end`, `photon.connect`, `photon.disconnect`, `photon.inspect`, `photon.status`
- **[O] Pending inputs.** Pending inputs are cached in `localStorage` under a `keto-pending-v1` key.
- **[O] Thread read.** A thread read returns:
  - `items`, `olderCursor`, `hasMore`, `tasks`, `activeRunId`
  - `heartbeat {live, lastSeenAt}`
  - `pendingInputs[{requestId, message, taskId, state:"queued"}]`
  - `receivedInputIds`
- **[O] Event stream (`keto-socket`).**
  - The client POSTs `{runId, afterSequence, includeReasoning}` and reads the body as SSE frames (`event:` and `data:` lines).
  - Event names:
    - `run.snapshot`: tells whether the run is still live.
    - `error`: throws.
    - `reconnect`: ignored.
    - Default: a sequenced run event. Duplicates where `sequence ≤ afterSequence` are dropped.
  - On disconnect it waits 1 s and reconnects, until the run leaves `starting|running`.
- **[O] Run events.** Every run event carries `runId` and `sequence`. The types are:
  - `input.received`
  - `message.delta {messageId, delta}` and `message.completed {messageId, text}`
  - `reasoning.started`, `reasoning.delta` and `reasoning.completed`
  - `model.started {messageId, model}`
  - `model.usage {finishReason, toolCallCount, cachedInputTokens, inputTokens, outputTokens, reasoningTokens}`
  - `tool.started {toolCallId, name, arguments}`, `tool.output {toolCallId, stream stdout|stderr, delta}` and `tool.completed {toolCallId, result}`
  - `file.written {path}`
  - `run.status {status, sessionId, error}`
  
  Run status is `starting|running|completed|failed|cancelled`.
- **[O] Worker ↔ backend actions.**
  - The action list:
    - `worker.next`, `claim`, `heartbeat`
    - `inbox.next {drainCapable}`, `inbox.ack {ids 1–20}`
    - `context.seed`, `prompt.resolve`, `skills.resolve`
    - `mcp.credentials {multiple, connectionId}`
    - `events {1–20 events}`
    - `finish {status completed|failed, error}`
    - `trace.span {spanId, name, payload, previous[], complete}`
  - Responses observed:
    - `worker.next` returns `{shutdown, run:{runId, runtimeToken}|null}`.
    - `claim` returns `{instanceId, message, inboxEnabled, resetContext, inputs, threadId}`.
    - `mcp.credentials` returns `{connection, connections[]}`. A connection's URL must be `https://mcp.slack.com`, over `http|sse`, with an `accessToken`.
- **[O] Infrastructure config schemas.**
  - ECS task config: `{cluster, taskDefinition, subnets, securityGroups}`.
  - Runtime config: `{accountId, cluster, image, subnets, securityGroups, fileSystemId, logGroup, openaiSecretArn, braintrustSecretArn, permissionsBoundaryArn, runtimeUrl, exportBucket}`.
  - **[I]** Each assistant instance runs as an AWS ECS task with an EFS filesystem. The model provider is OpenAI and tracing goes to Braintrust.
- **[O] Worker tools.** The labelled worker tools are `bash` (Running/Ran), `read_file`, `write_file` and `edit_file`. `tool.output` carries the shell's stdout and stderr.
- **[O] Voice-session events.** The Assistant voice session events are:
  - `session.ready`, `session.instructions.append`, `session.thinking.append`, `session.commentary.append`
  - `session.input_transcript.delta`, `session.output_transcript.delta`
  - `session.ending`, `session.closed`
  - `turn.started`, `turn.completed`, `turn.failed`
  - `delegation.started`, `delegation.finished`
  - `reaction.updated`, `personal_instructions.updated`
- **[?] `photon`.** `assistant.photon.*` and the `photon-assistant` endpoint look like an external messaging channel for the Assistant. Their purpose is not established.

## 3. Buddy ("Hermes")

Buddy is a separate system from Keto, with a different endpoint, schema and UI route (`/hermes`).

- **[O] Transport.**
  - Every call is a POST of `{action, …}` to `raisin`, with auth headers.
  - The timeout is 35 s, or 90 s for `telegram-*` and 120 s for `bot-chat-submit`.
  - Streams are NDJSON. Each line is parsed with the packet schema, and a line larger than 8 MB is rejected.
  - Error copy: "Could not reach Buds (…)".
- **[O] Actions.**
  - **Chat:**
    - `bot-chat`: the long-lived event stream.
    - `bot-chat-submit {input ≤100k, attachments ≤20, ≤50 MB total}`.
    - `bot-chat-stop`.
    - `bot-chat-clarify {requestId, questionId, answer}`.
    - `bot-chat-approval {requestId, choice once|deny}`.
    - `bot-chat-upload-urls`, `bot-chat-download-urls`.
  - **Telegram:** `telegram-status`, `-start`, `-retry`, `-poll`, `-connect` and `-cancel`, with a `pairingId`.
  - **Setup:** `setup-start {timezone, dashboard}`, `setup-status`, `setup-complete`, `setup-retry-personalization` and `dashboard-status`.
  - **Files:** `files-list`, `files-read` and `files-search` over absolute "Hermes paths". A denylist blocks `.env*`, `.envrc`, `auth.json`, `auth.lock`, `credentials`, `config.yaml`, `.anthropic_oauth.json`, the Google token/OAuth files, `webhook_subscriptions.json`, `bws_cache*.json`, `.git-credentials`, `mcp-tokens`, `pairing`, `.ssh`, `.aws` and `.gnupg`.
  - **Runs:**
    - `start {input, sessionId, requestId, model {provider anthropic|openai-api, name}}`
    - `status`, `events` and `stop` (each with a `runId`)
    - `approval {runId, requestId, choice once|deny}`
    - `history {sessionId}`
    - `results`
  - **Listings:** `sessions`, `jobs` and `skills`.
  - **Skills:** `skill-toggle {name, enabled}`. Skill names match `^[a-z0-9][a-z0-9._-]{0,63}$` ("Use a Hermes skill name"), and a skill's mode is `included|optional`.
- **[O] Packet envelope.**
  - The envelope is `{id?, result?, error?, params?{type, session_id, payload}}`. Packets with `id: resume|snapshot` carry the session state:
    - `session_id`, `messages[{role, display_kind, text, row_id, timestamp}]`, `running`, `turn_started_at`
    - `inflight {user, assistant, error, corrections[]}`
    - `queued {user}`
    - `pending_approval {request_id, command, description}`
    - `pending_clarify {request_id, question, choices, multi_select, questions[{qid,…}], answers}`
  - Event types:
    - `message.start`, `message.delta` and `message.complete`
    - `session.info {running}`
    - `approval.request`
    - `tool.start {name}` and `tool.complete`
    - `status.update`
    - `clarify.request` and `clarify.expire`
    - `error`
  - Hidden from the transcript:
    - messages whose `display_kind` is `hidden`, `async_delegation_complete`, `internal_notification`, `auto_continue`, `model_switch` or `personality_switch`
    - assistant text equal to `[SILENT]`
- **[O] Run status.** `started|queued|running|waiting_for_approval|stopping|completed|failed|cancelled|interrupted`, with `approval {request_id, command}`.
- **[O] Jobs.** A job is `{id, name, schedule{kind}, schedule_display, enabled, state}`. The UI shows only `cron` and `interval` jobs.
- **[O] Client.**
  - **Reconnects:** one shared subscription per session. It reconnects with a backoff of `min(30 s, 1 s·2ⁿ)`, and also on the window `online` and `focus` events.
  - **Messages:** messages are deduplicated by `row_id` and cached in `localStorage` (`hermes-main-messages:v1:<session>`).
  - **Multiple bots:** a persisted store (`hermes-bot-poc`) holds several bots, each with its own `sessionId`, name, avatar and draft. The defaults are "Chief of Stuff", "Attio" and "Emails".
- **[O] Provisioning.**
  - Setup status is `not_started|provisioning|verifying|ready|failed`, plus `acknowledged`.
  - A ready personalization result is `{generatedAt, result{profileMarkdown, memory, introduction, suggestions[≤3]{title, reason, prompt}}}`.
- **[O] Tool bridge.** A second bundled action union contains:
  - `list {supportsMessageApproval}`
  - `user-context`, `onboarding-context`, `model-policy`
  - `shared-skills`, `share-skill {name, description ≤1024, mode, files ≤50 incl. SKILL.md, ≤256 KB}`, `unshare-skill`
  - `call {name, input}`
  - `notify {id, text, sessionId}`
  
  **[I]** This is the `raisin-tools` bridge. The hosted runtime uses it to list and call Granola tools and to push notifications back.
- **[I] Runtime origin.** The runtime looks like a hosted instance of an off-the-shelf agent runtime, most likely Nous Research's open-source "Hermes Agent". The evidence:
  - a per-user home with `config.yaml`, `auth.json` and `.env`
  - Telegram gateway pairing
  - cron and interval jobs
  - the skill-name rule
  - a `clarify` tool
  - personality and model switching
  - `[SILENT]` replies
  - once/deny approval of shell `command`s
  
  This is not confirmed.

## 4. Granny (voice calls)

- **[O] Host.** The origin is derived from the `create-granny-live-session` host, as `https://granny-live.<domain>`.
- **[O] Session request.** `POST /v1/granny/session` has a 60 s timeout. The body is `{protocolVersion: 2, attemptId, callId, sdp, documentSelection: "backend", mode start|resume, documentId?, settings {voice: "marin", pace: "normal"}, transcriptOwner: "backend"}`.
- **[O] Headers.** The request sends the time zone (`x-granola-time-zone`) and the workspace. A resumed call also sends the protocol header `x-granola-granny-protocol: mixed-chat-voice-v1`.
- **[O] Events.** `GET /v1/granny/events?session_id=` returns NDJSON, with a 45 s idle timeout and a 1 MB line cap.
- **[O] Commands.** `POST /v1/granny/command {type:"close", session_id}` ends a call. It is retried every 30 s for up to an hour.
- **[O] Calls.** Only one call can be active at a time.
- **[O] Activity label.** Events with a `delegation_id` drive the label:
  - `delegation.started` and `turn.started` show "Working…".
  - A `tool_call` for `createBlock` or `draftCalendarEvent` shows "Drafting…".
  - `turn.completed|failed` and `delegation.finished` clear the label.
  - `session.closed` and `session.ending` end the call.
- **[I] Media path.** Granola's backend terminates WebRTC, and an OpenAI realtime model sits behind it. `marin` is an OpenAI realtime voice name. Long tasks are delegated to the text agent.

## 5. Dispatch (post-meeting drafts)

- **[O] Output.** `draft_preview {title, summary, artifacts[1+]}`. Each artifact has `{id, title, status ready_for_approval|needs_input|blocked, confidence high|medium|low, missingInfo[]}` and one of these kinds:
  - `email {to[], cc[], subject, body, sendCopyToSelf}`
  - `slack_message {destinationType person|channel, destinationLabel, workspaceName, message, mentionRecipient}`
  - `linear_ticket_batch {team, defaultAssignee, tickets[{title, description, priority none…urgent, assignee, includeInBatch}]}`
  - `calendar_event {eventTitle, attendees, date, startTime, endTime, timeZone, location, notes}`
  - `cursor_plan {planMarkdown}`
- **[O] Threads.** Chat threads carry `initiated_by: user|dispatch`.
- **[O] Rendering.** The artifact kinds are also referenced in `MiniStation-*.js`, `PortraitPage-*.js` and `primary-*.js`. That chunk was not analyzed.
- **[O] Card window.** A `dispatcher-notification` card window has the IPC channels `:card`, `:set-card`, `:dismiss`, `:open-thread`, `:request-initial-state` and `:set-ignore-mouse`.
- **[O] Endpoints.** `enqueue-dispatch-classifier`, `draft-dispatch-playground` and `run-dispatch-playground`.

## 6. Reminder agent

- **[O] Reminders.** A reminder has these fields:
  - `id`, `kind`
  - `status pending|active|dismissed|resolved`, `resolvedReason`
  - `dueAt`, `expiresAt`
  - `presentation {variant default|focus_time|running_late, title, summary}`
  - `actions[]`
  - `threadId`, `context`
  
  Kinds include `running_late`, `no_show`, `calendar_invite`, `missing_details` and `follow_up_emails`.
- **[O] Actions.** There are four action kinds. Each kind's run goes through `requested → preparing → ready → executing|done|unknown|failed {reason, retryable}`.
  - `draft_block {blockType}`
  - `open_chat`
  - `chat_action {mode background|open, instruction, expectedTool{name, calendarId, eventId, responseStatus}}`
  - `review_follow_ups`
- **[O] Card sizes.**

  | Variant | Size | Behaviour |
  | --- | --- | --- |
  | `default` | 339×280 | |
  | `running_late` | 339×319 | |
  | `focus_time` | 328×88 | Auto-dismisses after 30 s |

  Margins: top 16, side 24, bottom 24, screen 16.
- **[O] Commitment extraction.**
  - Commitments are extracted per document: `{version, sourceTitle, sourceDate, items[{id, title, task, type email|slack|calendar|todo, confidence high|low, attribution}]}`.
  - The item status is `open|done|dismissed`.
  - The store schema is version 2.
- **[O] Card window.** A `reminder-agent-notification` card window has the IPC channels `:cards`, `:set-cards`, `:card-action`, `:update-window`, `:request-initial-state` and `:set-ignore-mouse`.

## Shared desktop shell

- **[O] Card window.** Main owns one frameless, always-on-top (`screen-saver` level) card window, loaded as `!hermes-notification`. It is shared by Buddy (`kind: hermes`) and the Assistant (`kind: assistant`).
  - **Placement:** it shows inactive, at the top-right of the active display.
  - **Mouse events:** the window starts with `setIgnoreMouseEvents(true, {forward: true})`. The renderer switches this through `:set-ignore-mouse`.
  - **Timing:** it auto-hides 8 s after the last update, then hides fully 350 ms later.
  - **Focus rule:** it is suppressed while the main window is focused, unless the kind is `assistant`.
  - **Opening:** clicking the card sends `hermes:open-conversation`.
- **[O] Renderer side.** The renderer only raises a card when its document is hidden or unfocused. It uses `setHermesNotificationCard({kind, sessionId, name, avatar, snippet ≤200, receivedAt})`.

## Cereal implications

- **One system or two.** Granola runs several separate agent backends. Cereal's plan to put every surface on one local agent core is a deliberate simplification, and it holds up. The surfaces differ in transport and UI, not in the loop.
- **Tool calls.** Model the tool call on the shared base. In particular, keep these as separate fields:
  - streamed `argsDelta`
  - `providerExecuted`
  - `confirmation*`, separate from `approval`
  - `reverted`
  - opaque provider replay metadata
- **Clarifying questions.** Granola has two shapes:
  - **Ask chat** uses a structured `askUserQuestion`: 1–3 questions with 2–4 options each.
  - **Buddy** uses `clarify.request`, which can carry several questions with `qid`s.
  
  Cereal can use the Ask-chat shape for both.
- **Approvals.** Buddy's approvals are `once|deny` per command, and Keto's are allow/approval-required/denied per action. Cereal's per-tool `ask` policy with "always allow" fits between the two.
- **Deferred surfaces.** Dispatch, reminders, quick chat, voice and Telegram are deferred. Their schemas above are enough to add any of them later on the same core.

## Open unknowns

- [?] The top-level request body of `chat-with-documents` beyond the context object. REA could not trace it through the dynamic wrapper, and the earlier grep-based reading was not re-checked.
- [?] What `granny-agent`, `cloud-agent`, `read-durable-stream` and `photon-assistant` do. All four are in the URL map, but their call sites are dynamic or absent from the analyzed scope.
- [?] Whether Buddy's runtime really is Nous Research's Hermes Agent (see §3).
