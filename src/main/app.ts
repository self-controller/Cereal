import { app, BrowserWindow, Menu, Notification, Tray, nativeImage, protocol, session, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openDatabase } from './db'
import { Store } from './db/store'
import { SettingsService } from './settings'
import { broadcast, handle, setSenderValidator } from './ipc'
import { PipeWireCapture, SAMPLE_RATE, commandExists, listAudioDevices } from './audio/pipewire'
import { DeepgramEngine } from './transcription/deepgram'
import { WhisperEngine, findWhisperServer } from './transcription/whisper'
import { WhisperModels } from './transcription/models'
import type { TranscriptionEngine } from './transcription/types'
import { Recorder } from './recorder'
import { AiService } from './ai/service'
import { TranscriptSummaryService } from './ai/transcriptSummary'
import { chatModels, createProvider, deleteRemoteFile, describeLlmError } from './llm'
import { AttachmentService } from './attachments/service'
import { Dictation } from './transcription/dictation'
import { CalendarService } from './calendar'
import { MeetingDetector } from './detector'
import { AgentStore } from './db/agent-store'
import { UsageStore } from './db/usage-store'
import { ensurePricingFile, loadPrices, meter } from './usage'
import { AgentFiles } from './agent/files'
import { AgentBackend } from './agent/backend'
import { ChatAgent } from './agent/chat'
import { Assistant } from './agent/assistant'
import { WorkerHost } from './agent/worker-host'
import { InProcessHost } from './agent/host'
import { hardenWindow, isOwnPage, loadPage } from './windows'
import { createWidget } from './widget/controller'
import { fitWidgetSize } from './widget/placement'
import type { WidgetAction } from './widget/protocol'
import type { CalendarEvent, CerealDocument, NoteMode } from '@shared/types'
import type { WidgetState } from '@shared/ipc'

const RESOURCES = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources')

app.setName('Cereal')
if (!app.requestSingleInstanceLock()) app.quit()

// Inside Flatpak, encrypt tokens with the key the Secret portal gives this app, not the host keyring's (which the
// sandbox can't reach). Chromium can't switch this off again once it has encrypted with it.
if (process.env['FLATPAK_ID']) app.commandLine.appendSwitch('enable-features', 'SecretPortalKeyProviderUseForEncryption')

// Chat attachments are served to the renderer (thumbnails, the preview lightbox) from cereal-attachment://file/<id>.
protocol.registerSchemesAsPrivileged([{ scheme: 'cereal-attachment', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

// Window chrome per theme: the page surface, and the title bar overlay's control glyphs (Granola's frameless
// window: the 44px toolbar is the drag area and the window controls sit at its right end).
const CHROME = {
  light: { color: '#f7f7f2', symbolColor: '#4e4d4b' },
  dark: { color: '#292929', symbolColor: '#acada8' }
}
let darkChrome = false

function createMainWindow(): BrowserWindow {
  const chrome = CHROME[darkChrome ? 'dark' : 'light']
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 500,
    minHeight: 480,
    show: false,
    title: 'Cereal',
    icon: join(RESOURCES, 'icon.png'),
    backgroundColor: chrome.color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...chrome, height: 44 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  hardenWindow(win)
  win.once('ready-to-show', () => win.show())
  win.on('focus', updateWidget)
  win.on('blur', updateWidget)
  win.on('minimize', updateWidget)
  win.on('restore', updateWidget)
  win.on('close', (e) => {
    // Keep recording in the background when the window is closed mid-meeting.
    if (!quitting && recorder.getState().status === 'recording') {
      e.preventDefault()
      win.hide()
      updateWidget()
    }
  })
  win.on('closed', () => (mainWindow = null))
  // A page that stops answering looks like dead buttons; these lines land in the journal under the Flatpak.
  win.on('unresponsive', () => console.warn('Main window is not responding'))
  win.on('responsive', () => console.warn('Main window is responding again'))
  win.webContents.on('render-process-gone', (_e, d) => console.warn(`Main window renderer gone: ${d.reason} (exit ${d.exitCode})`))
  loadPage(win, __dirname, 'index')
  return win
}

/**
 * After a click in the XWayland-hosted widget, GNOME may only say "Cereal is ready" rather than raise this window: the
 * click hands it no Wayland activation token. Hiding and showing the window would get it focus, but Chromium re-maps
 * it against the protocol (mutter logs "Buggy client").
 */
function showMain(route?: string): void {
  if (!mainWindow) mainWindow = createMainWindow()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  if (route) broadcast('navigate', { route })
}

// ------------------------------------------------------------------ widget

// Granola's "nub": a small floating pill at the right edge of the screen while Cereal transcribes in the
// background, which also asks "Take notes?" when a meeting is detected. The page sizes itself; the window follows.
// On Wayland it runs in its own XWayland process (widget/controller.ts).
let widgetState: WidgetState = { mode: 'recording', documentId: null }
const widget = createWidget({
  baseDir: __dirname,
  snapshot: () => ({ widget: widgetState, recording: recorder.getState() }),
  onAction: (action) => onWidgetAction(action)
})

function setWidgetState(state: WidgetState): void {
  widgetState = state
  broadcast('widget:state', state)
  widget.setState(state)
}

function onWidgetAction(action: WidgetAction): void {
  if (action === 'open') {
    // A stopped recording keeps its note's id, and that note may since have been deleted: only a live one opens.
    const { status, document_id: id } = recorder.getState()
    return showMain(status !== 'idle' && id ? `/note/${id}` : undefined)
  }
  const prompt = widgetState.mode === 'prompt'
  setWidgetState({ mode: 'recording', documentId: recorder.getState().document_id })
  updateWidget()
  if (action === 'start' && prompt) void startMeetingNotes('meeting')
}

/** Show the widget while recording with the main window out of focus, or while a detected meeting awaits an answer. */
function updateWidget(): void {
  const recording = recorder?.getState().status === 'recording'
  const mainVisible = !!mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused()
  const documentId = recorder?.getState().document_id ?? null
  if (recording && (widgetState.mode !== 'recording' || widgetState.documentId !== documentId)) setWidgetState({ mode: 'recording', documentId })
  if (recording) widget.warm()
  const show = widgetState.mode === 'prompt' || (recording && !mainVisible)
  if (show) widget.show()
  else if (widget.isVisible()) widget.hide()
}

// --------------------------------------------------------------- services

app.setPath('userData', process.env['CEREAL_USER_DATA'] || join(app.getPath('appData'), 'Cereal'))
const db = openDatabase(join(app.getPath('userData'), 'cereal.db'))
const store = new Store(db)
const usage = new UsageStore(db)
const recordUsage = usage.record.bind(usage)
const pricingFile = join(app.getPath('userData'), 'pricing.json')
const settings = new SettingsService(store, join(app.getPath('userData'), '.env'))
const models = new WhisperModels(join(app.getPath('userData'), 'models'), (list) => broadcast('asr:models-changed', list))
const calendar = new CalendarService(store, settings, (url) => void shell.openExternal(url), (events) => broadcast('calendar:changed', events))
const attachments = new AttachmentService(
  store,
  join(app.getPath('userData'), 'attachments'),
  (a) => broadcast('chat:attachment', a),
  (provider, remoteId) => deleteRemoteFile(settings, provider, remoteId)
)
attachments.purge()
const dictation = new Dictation({
  settings: () => settings.get(),
  deepgramKey: () => settings.getSecret('deepgramApiKey'),
  whisperModelPath: (id) => models.path(id),
  envFile: settings.envFile,
  deepgramUrl: process.env['CEREAL_DEEPGRAM_LISTEN_URL'] || undefined,
  recordUsage
})

async function createEngine(): Promise<TranscriptionEngine> {
  const t = settings.get().transcription
  if (t.engine === 'deepgram') {
    const key = settings.getSecret('deepgramApiKey')
    if (!key) throw new Error(`Set DEEPGRAM_API_KEY in ${settings.envFile}, or switch to local Whisper in Settings → Transcription.`)
    return new DeepgramEngine(key, t.deepgramModel, process.env['CEREAL_DEEPGRAM_URL'] || undefined)
  }
  const binary = findWhisperServer(t.whisperServerPath)
  if (!binary) throw new Error('whisper-server was not found. Install whisper.cpp (sudo dnf install whisper-cpp) or set its path in Settings → Transcription.')
  return new WhisperEngine(binary, models.path(t.whisperModel), t.whisperThreads)
}

const recorder = new Recorder({
  store,
  settings: () => settings.get(),
  createEngine,
  createCapture: (opts) => new PipeWireCapture(opts),
  emitChunks: (documentId, chunks) => broadcast('transcript:chunks', { documentId, chunks }),
  emitState: (state) => {
    broadcast('recording:state', state)
    widget.setRecording(state)
    updateWidget()
    updateTray()
  },
  emitLevels: (levels) => {
    broadcast('audio:levels', levels)
    widget.setLevels(levels)
  },
  sampleRate: SAMPLE_RATE,
  recordUsage
})

const ai = new AiService({
  store,
  settings,
  provider: () => createProvider(settings),
  emitPanel: (panel) => broadcast('panel:updated', panel),
  emitDocumentChanged: (id) => broadcast('documents:changed', { id }),
  recordUsage
})
const transcriptSummary = new TranscriptSummaryService({
  store,
  settings,
  provider: () => createProvider(settings),
  emit: (update) => broadcast('transcript-summary:update', update),
  recordUsage
})

// ------------------------------------------------------------------ agent

const agentStore = new AgentStore(db)
const agentFiles = new AgentFiles(join(app.getPath('userData'), 'agent'))
agentFiles.seedStarterSkill()
const agent = new AgentBackend({
  store,
  agentStore,
  files: agentFiles,
  settings,
  attachments,
  rewriteNotes: (documentId, instructions) => ai.enhance(documentId, store.listPanels(documentId).pop()?.template_slug ?? null, instructions),
  emitChatMessage: (m) => broadcast('chat:message', m),
  emitAgentMessage: (m) => broadcast('assistant:message', m),
  emitAgentEvent: (r) => broadcast('agent:event', r),
  recordUsage
})
// The agent loop runs in its own utility process (out/main/agent.js); CEREAL_AGENT_IN_PROCESS=1 keeps it in main.
agent.host = process.env['CEREAL_AGENT_IN_PROCESS'] === '1' ? new InProcessHost(agent) : new WorkerHost(join(__dirname, 'agent.js'), agent)
const chat = new ChatAgent({
  store,
  agentStore,
  backend: agent,
  settings,
  files: agentFiles,
  attachments,
  emitMessage: (m) => broadcast('chat:message', m),
  emitThread: (t) => broadcast('chat:thread', t)
})
const assistant = new Assistant({
  store,
  agentStore,
  backend: agent,
  settings,
  files: agentFiles,
  emitMessage: (m) => broadcast('assistant:message', m),
  emitThread: (t) => broadcast('assistant:thread', t),
  emitHome: (h) => broadcast('assistant:home', h),
  emitRoutines: () => broadcast('assistant:routines-changed', null),
  notify: (title, body, route) => notify(title, body, () => showMain(route)),
  isFocused: () => !!mainWindow?.isFocused()
})

function noteForEvent(event: CalendarEvent): CerealDocument {
  return store.findDocumentForEvent(event.id) ?? store.createDocument({ calendar_event: event })
}

async function stopRecording(): Promise<void> {
  const before = recorder.getState()
  await recorder.stop()
  if (before.document_id && settings.get().enhance.autoEnhanceOnStop && store.getTranscript(before.document_id).length > 0) {
    try {
      ai.enhance(before.document_id)
    } catch {
      // Missing AI configuration: the user can enhance manually.
    }
  }
}

/** Start notes for a meeting: link the ongoing calendar event if there is one, open the note, start recording. Lectures skip the calendar. */
async function startMeetingNotes(mode: NoteMode = 'meeting'): Promise<void> {
  const event = mode === 'meeting' ? calendar.current() : null
  const doc = event ? noteForEvent(event) : store.createDocument({ mode })
  broadcast('documents:changed', { id: doc.id })
  showMain(`/note/${doc.id}`)
  try {
    await recorder.start(doc.id)
  } catch (e) {
    notify('Could not start recording', (e as Error).message)
  }
}

function notify(title: string, body: string, onClick?: () => void): void {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body, icon: join(RESOURCES, 'icon.png'), silent: false })
  if (onClick) n.on('click', onClick)
  n.show()
}

const detector = new MeetingDetector(
  (app) => {
    if (recorder.getState().status !== 'idle') return
    setWidgetState({ mode: 'prompt', title: calendar.current()?.title ?? null, app })
    updateWidget()
    broadcast('meeting:detected', { app })
  },
  () => {
    // The meeting ended before anyone answered the prompt.
    if (widgetState.mode === 'prompt') {
      setWidgetState({ mode: 'recording', documentId: null })
      updateWidget()
    }
    // A meeting app releasing the mic doesn't end a lecture that happens to be recording.
    const { status, document_id } = recorder.getState()
    if (status === 'recording' && store.getDocument(document_id ?? '')?.mode !== 'lecture') {
      void stopRecording().then(() => notify('Meeting ended', 'Cereal stopped transcribing. Your notes are saved.'))
    }
  }
)

// Remind about calendar events just before they start.
const reminded = new Set<string>()
function checkUpcomingMeetings(): void {
  const lead = settings.get().calendar.notifyMinutesBefore * 60_000
  const now = Date.now()
  for (const e of calendar.upcoming()) {
    const start = Date.parse(e.start)
    if (start - now <= lead && start - now > -60_000 && !reminded.has(e.id)) {
      reminded.add(e.id)
      if (recorder.getState().status === 'idle') {
        notify(`${e.title} is starting`, 'Click to open notes and start transcribing.', () => {
          const doc = noteForEvent(e)
          showMain(`/note/${doc.id}`)
          void recorder.start(doc.id).catch((err: Error) => notify('Could not start recording', err.message))
        })
      }
    }
  }
}

// ------------------------------------------------------------------- tray

function updateTray(): void {
  if (!tray) return
  const recording = recorder.getState().status === 'recording'
  tray.setToolTip(recording ? 'Cereal: transcribing' : 'Cereal')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Cereal', click: () => showMain() },
      recording
        ? { label: 'Stop transcribing', click: () => void stopRecording() }
        : { label: 'New note and transcribe', click: () => void startMeetingNotes() },
      ...(recording ? [] : [{ label: 'New lecture and transcribe', click: () => void startMeetingNotes('lecture') }]),
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

// -------------------------------------------------------------------- IPC

function registerIpc(): void {
  setSenderValidator((event) => isOwnPage(event.senderFrame?.url ?? ''))

  const changed = (id: string | null): void => broadcast('documents:changed', { id })

  handle('documents:list', (q) => store.listDocuments(q))
  handle('documents:get', (id) => store.getDocument(id))
  handle('documents:create', (init) => {
    const doc = store.createDocument(init)
    changed(doc.id)
    return doc
  })
  handle('documents:update', (id, patch) => {
    const doc = store.updateDocument(id, patch)
    if (patch.title !== undefined || patch.calendar_event !== undefined || patch.mode !== undefined) changed(id)
    return doc
  })
  handle('documents:delete', async (id) => {
    if (recorder.getState().document_id === id) await recorder.stop()
    store.deleteDocument(id)
    changed(null)
  })
  handle('documents:for-event', (event) => {
    const doc = noteForEvent(event)
    changed(doc.id)
    return doc
  })

  handle('transcript:get', (id) => store.getTranscript(id))
  handle('transcript:clear', (id) => store.clearTranscript(id))

  handle('recording:start', async (id) => {
    const state = await recorder.start(id)
    changed(id)
    return state
  })
  handle('recording:stop', async () => {
    await stopRecording()
    return recorder.getState()
  })
  handle('recording:state', () => recorder.getState())

  handle('panels:list', (id) => store.listPanels(id))
  handle('panels:enhance', (id, slug) => ai.enhance(id, slug))
  handle('panels:rewrite', (panelId, instructions) => ai.rewrite(panelId, instructions))
  handle('panels:update', (panelId, patch) => ai.saveEdit(panelId, patch.content_json))
  handle('transcript-summary:start', (requestId, documentId, line) => transcriptSummary.start(requestId, documentId, line))
  handle('transcript-summary:cancel', (requestId) => transcriptSummary.cancel(requestId))
  handle('panels:delete', (panelId) => {
    ai.cancel(panelId)
    store.deletePanel(panelId)
  })

  handle('folders:list', () => store.listFolders())
  handle('folders:create', (title) => {
    const f = store.createFolder(title)
    broadcast('folders:changed', null)
    return f
  })
  handle('folders:rename', (id, title) => {
    store.renameFolder(id, title)
    broadcast('folders:changed', null)
  })
  handle('folders:delete', (id) => {
    store.deleteFolder(id)
    broadcast('folders:changed', null)
    changed(null)
  })
  handle('folders:add-document', (folderId, documentId) => {
    store.addToFolder(folderId, documentId)
    broadcast('folders:changed', null)
    changed(documentId)
  })
  handle('folders:remove-document', (folderId, documentId) => {
    store.removeFromFolder(folderId, documentId)
    broadcast('folders:changed', null)
    changed(documentId)
  })

  handle('templates:list', () => store.listTemplates())
  handle('templates:upsert', (t) => store.upsertTemplate(t))
  handle('templates:delete', (slug) => store.deleteTemplate(slug))

  handle('recipes:list', () => store.listRecipes())
  handle('recipes:upsert', (r) => store.upsertRecipe(r))
  handle('recipes:delete', (id) => store.deleteRecipe(id))

  handle('chat:threads', (documentId) => store.listThreads(documentId))
  handle('chat:messages', (threadId) => store.listMessages(threadId))
  handle('chat:send', (input) => chat.send(input))
  handle('chat:delete-thread', (id) => chat.deleteThread(id))
  handle('chat:stop', (messageId) => chat.stop(messageId))
  handle('chat:tool-applied', (messageId, toolCallId, patch) => chat.toolApplied(messageId, toolCallId, patch))
  handle('chat:retry', (threadId) => chat.retry(threadId))
  handle('chat:attach', (input) => attachments.add(input))
  handle('chat:remove-attachment', (id) => {
    // Only drafts can be removed from the bar; a sent file goes with its message or thread.
    if (!store.getAttachment(id)?.message_id) attachments.remove(id)
  })
  handle('chat:models', () =>
    chatModels(settings, async () => {
      const ollama = createProvider(settings, 'ollama')
      return Promise.race([ollama.listModels(), new Promise<string[]>((r) => setTimeout(() => r([]), 1500))])
    })
  )
  handle('chat:mention-search', (q, exclude) => store.searchTitles(q.trim(), 50, exclude ?? []))
  handle('dictation:transcribe', async (audio) => ({ text: await dictation.transcribe(audio.samples, audio.sampleRate) }))

  handle('agent:decide', (approvalId, decision, always) => {
    agent.decide(approvalId, decision, always)
    if (always) broadcast('settings:changed', settings.get())
  })
  handle('agent:events', (runId, after) => agentStore.eventsSince(runId, after))
  handle('agent:sources', (threadId) => agentStore.sources(threadId))

  handle('assistant:open', () => assistant.open())
  handle('assistant:thread', (id) => assistant.readThread(id))
  handle('assistant:send', (input) => assistant.send(input))
  handle('assistant:stop', (threadId) => assistant.stop(threadId))
  handle('assistant:task-stop', (taskId) => assistant.stopTask(taskId))
  handle('assistant:routines', () => assistant.routines())
  handle('assistant:routine-update', (id, patch) => assistant.updateRoutine(id, patch))
  handle('assistant:routine-delete', (id) => assistant.deleteRoutine(id))
  handle('assistant:skills', () => agentFiles.skills())
  handle('assistant:files', (path) => agentFiles.list(path))
  handle('assistant:file-read', (path) => agentFiles.read(path))
  handle('assistant:open-folder', async (path) => {
    const error = await shell.openPath(path ? agentFiles.resolve(path) : agentFiles.root)
    if (error) throw new Error(`Couldn't open the folder: ${error}`)
  })
  handle('assistant:reset', () => assistant.reset())

  handle('search:query', (q) => store.search(q))

  handle('settings:get', () => settings.get())
  handle('settings:update', (patch) => {
    const next = settings.update(patch)
    broadcast('settings:changed', next)
    if (next.detection.enabled) detector.start()
    else detector.stop()
    if (patch.assistant?.enabled) assistant.drain()
    return next
  })
  handle('secrets:status', async () => {
    await settings.loadTokens()
    return settings.secretStatus()
  })
  handle('secrets:open-env', async () => {
    settings.ensureEnvFile()
    const error = await shell.openPath(settings.envFile)
    if (error) throw new Error(`Couldn't open ${settings.envFile}: ${error}`)
  })

  handle('llm:test', async (id) => {
    try {
      const provider = createProvider(settings, id)
      // Reasoning models (GPT-5.x, Gemini 3.x) spend output tokens thinking before they answer.
      const reply = await provider.generate({
        tier: 'fast',
        system: 'Reply with exactly: OK',
        messages: [{ role: 'user', content: 'Say OK.' }],
        maxTokens: 512,
        onUsage: meter(recordUsage, 'connection-test')
      })
      return { ok: true, message: `Connected. Model replied: ${reply.trim().slice(0, 40) || '(empty)'}` }
    } catch (e) {
      return { ok: false, message: describeLlmError(e) }
    }
  })
  handle('llm:models', async (id) => {
    try {
      return await createProvider(settings, id).listModels()
    } catch {
      return []
    }
  })

  handle('asr:models', () => models.list())
  handle('asr:download', (id) => {
    models.download(id).catch((e: Error) => notify('Model download failed', e.message))
  })
  handle('asr:delete', (id) => models.delete(id))
  handle('asr:test-deepgram', async () => {
    const key = settings.getSecret('deepgramApiKey')
    if (!key) return { ok: false, message: `DEEPGRAM_API_KEY is not set in ${settings.envFile}.` }
    return DeepgramEngine.test(key, settings.get().transcription.deepgramModel)
  })

  handle('audio:devices', () => listAudioDevices())
  handle('usage:summary', (range) => {
    const { prices, errors } = loadPrices(pricingFile)
    return usage.summary(range, prices, errors)
  })
  handle('usage:open-pricing', async () => {
    ensurePricingFile(pricingFile)
    const error = await shell.openPath(pricingFile)
    if (error) throw new Error(`Couldn't open ${pricingFile}: ${error}`)
  })
  handle('env:status', async () => ({
    pwRecord: await commandExists('pw-record'),
    pwDump: await commandExists('pw-dump'),
    whisperServer: findWhisperServer(settings.get().transcription.whisperServerPath),
    safeStorage: await settings.tokensProtected(),
    envFile: settings.envFile
  }))

  handle('calendar:connect', () => calendar.connect())
  handle('calendar:disconnect', () => calendar.disconnect())
  handle('calendar:upcoming', () => calendar.upcoming())
  handle('calendar:sync', async () => {
    try {
      return await calendar.sync()
    } catch {
      return calendar.upcoming()
    }
  })

  handle('app:open-external', (url) => {
    if (/^(https?:\/\/|mailto:)/.test(url)) void shell.openExternal(url)
  })
  handle('app:focus-main', (route) => showMain(route))
  handle('app:quit', () => {
    quitting = true
    app.quit()
  })
  handle('window:chrome', ({ dark }) => {
    darkChrome = dark
    const chrome = CHROME[dark ? 'dark' : 'light']
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.setBackgroundColor(chrome.color)
    mainWindow.setTitleBarOverlay({ ...chrome, height: 44 })
  })
  handle('widget:state', () => widgetState)
  handle('widget:resize', (size) => widget.resize(fitWidgetSize(size)))
  handle('widget:action', (action) => onWidgetAction(action))
}

// -------------------------------------------------------------- lifecycle

app.on('second-instance', () => showMain())

// The GPU or a utility process dying can leave the window frozen on its last frame.
app.on('child-process-gone', (_e, d) => console.warn(`${d.type} process gone: ${d.reason} (exit ${d.exitCode})`))

/** cereal-attachment://file/<id>: an attachment's bytes, for thumbnails and previews in Cereal's own pages. */
function serveAttachments(): void {
  protocol.handle('cereal-attachment', async (request) => {
    const id = new URL(request.url).pathname.replace(/^\//, '')
    const a = /^[0-9a-f-]{36}$/.test(id) ? store.getAttachment(id) : null
    if (!a) return new Response('Not found', { status: 404 })
    try {
      // Text files are shown as plain text, never rendered as HTML.
      const type = a.kind === 'text' ? 'text/plain; charset=utf-8' : a.mime
      // Cereal's pages load from file:// (origin "null"), so the text preview's fetch needs CORS; only Cereal's own
      // windows can reach this scheme.
      return new Response(await readFile(attachments.originalPath(id)), { headers: { 'content-type': type, 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

app.whenReady().then(() => {
  // The keyring can be slow to answer, so only the calendar waits for the tokens.
  const tokensLoaded = settings.loadTokens()
  serveAttachments()
  // Permissions (the microphone for dictation, notifications, the clipboard) only for Cereal's own pages.
  session.defaultSession.setPermissionRequestHandler((wc, _permission, callback) => callback(isOwnPage(wc.getURL())))
  session.defaultSession.setPermissionCheckHandler((wc) => !!wc && isOwnPage(wc.getURL()))
  registerIpc()
  mainWindow = createMainWindow()
  try {
    tray = new Tray(nativeImage.createFromPath(join(RESOURCES, 'tray.png')).resize({ width: 22, height: 22 }))
    tray.on('click', () => showMain())
    updateTray()
  } catch {
    tray = null // Not every Linux desktop has a status area.
  }
  if (settings.get().detection.enabled) detector.start()
  agent.recover()
  agentStore.pruneEvents(new Date(Date.now() - 14 * 86_400_000).toISOString())
  assistant.tick()
  setInterval(() => assistant.tick(), 30_000)
  setInterval(checkUpcomingMeetings, 30_000)
  void tokensLoaded.then(() => {
    setInterval(() => void calendar.sync().catch(() => undefined), 5 * 60_000)
    return calendar.sync()
  }).catch(() => undefined)
})

app.on('activate', () => showMain())

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', (e) => {
  if (recorder.getState().status !== 'idle') {
    e.preventDefault()
    void recorder.stop().finally(() => app.quit())
    return
  }
  detector.stop()
  dictation.stop()
  agent.host?.stop()
  widget.dispose()
  db.close()
})

app.on('window-all-closed', () => {
  // While recording, the window hides instead of closing, so this only runs when idle.
  if (recorder.getState().status === 'idle') app.quit()
})
