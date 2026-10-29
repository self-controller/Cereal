// End-to-end smoke test: launches the built Cereal app with an isolated profile, a fake Deepgram
// WebSocket server and a fake Ollama server, then drives the UI through the core loop:
// new note → type notes → transcribe (real PipeWire capture) → stop → enhance → edit and explain the notes → chat.
import { _electron as electron } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const shots = process.argv[2] || join(tmpdir(), 'cereal-shots')
mkdirSync(shots, { recursive: true })
const log = (...a) => console.log('[e2e]', ...a)

// --- fake Deepgram: answer the first audio frames with a scripted conversation per source
const script = {
  microphone: ['Thanks for making time today.', 'Our budget for the pilot is fifty thousand dollars.', 'Can we ship before the end of Q3?'],
  system: ['Happy to be here.', 'Q3 works if legal signs off on the data agreement by Friday.', 'I will send the contract draft tomorrow.']
}
// The call audio is diarized: two remote voices (Deepgram word-level `speaker`), so the speakers chip can name them.
const systemSpeakers = [0, 1, 0]
const diarized = (text, start, speaker) => text.split(' ').map((w, i) => ({ word: w.toLowerCase().replace(/[^\w']/g, ''), punctuated_word: w, start: start + i * 0.1, end: start + i * 0.1 + 0.1, speaker }))
const dg = new WebSocketServer({ port: 0 })
let connections = 0
dg.on('connection', (socket, req) => {
  const idx = connections++
  const lines = idx % 2 === 0 ? script.microphone : script.system
  let frames = 0
  let sent = 0
  socket.on('message', (data, isBinary) => {
    if (!isBinary) {
      if (JSON.parse(data.toString()).type === 'CloseStream') socket.close()
      return
    }
    frames++
    if (frames % 8 === 0 && sent < lines.length) {
      const text = lines[sent]
      const start = sent * 3 + (idx % 2) * 1.5
      const partial = text.split(' ').slice(0, 3).join(' ')
      const words = (t) => (idx % 2 === 1 ? { words: diarized(t, start, systemSpeakers[sent]) } : {})
      socket.send(JSON.stringify({ type: 'Results', is_final: false, start, duration: 1, channel: { alternatives: [{ transcript: partial, ...words(partial) }] } }))
      socket.send(JSON.stringify({ type: 'Results', is_final: true, start, duration: 1.4, channel: { alternatives: [{ transcript: text, ...words(text) }] } }))
      sent++
    }
  })
})
await new Promise((r) => dg.on('listening', r))
const dgUrl = `ws://127.0.0.1:${dg.address().port}/v1/listen`

// --- fake Ollama: stream NDJSON replies. With tools (chat and the Assistant) it plays a scripted agent.
const notes = '### Budget\n- Pilot budget is $50k\n- Legal must approve the data agreement by Friday\n\n### Timeline\n- Ship before end of Q3\n\n### Next steps\n- They send the contract draft tomorrow'
const call = (name, args) => ({ call: { name, arguments: args } })

/** What the scripted agent does next, from the system prompt and the conversation so far. */
function agentTurn(system, messages) {
  const last = messages[messages.length - 1]
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const after = (tool) => last.role === 'tool' && last.tool_name === tool
  if (system.includes('You are working on one task')) {
    if (last.role === 'user') return call('searchMeetings', { query: 'Acme' })
    if (after('searchMeetings')) return call('draftEmail', { to: ['kim@acme.com'], subject: 'Acme pilot: next steps', body: 'Hi Kim,\n\nThanks for the call. We agreed a $50k pilot and to ship before the end of Q3 once legal signs off.\n\nBest,\nDee' })
    if (after('draftEmail')) return call('publishResult', { status: 'done', summary: 'Drafted the Acme follow-up', text: 'The follow-up email to Kim is drafted, covering the $50k pilot and the Q3 timeline [1].' })
    return 'Done.'
  }
  if (system.includes('This is your conversation with the user')) {
    if (lastUser.startsWith('[Task')) {
      if (last.role === 'user') return call('publishHome', { briefing: 'Your **Acme follow-up** is drafted and ready to review.', groups: [{ title: 'Ready to review', task_ids: [lastUser.match(/task_id ([0-9a-f-]+)/)[1]] }] })
      return 'Your Acme follow-up is ready to review.'
    }
    if (last.role === 'user') return { text: 'On it. ', ...call('startTask', { title: 'Acme follow-up', handoff: 'Draft a follow-up email to Kim at Acme about the pilot call: budget and timeline.' }) }
    return 'I started a task to draft it.'
  }
  if (system.includes("one of the user's")) {
    if (lastUser.includes('Spell out')) return after('editMeetingNotes') ? 'I spelled out the budget in your notes.' : call('editMeetingNotes', { textToReplace: 'budget 50k', newText: 'budget $50,000' })
    return 'The pilot budget is **$50k**.'
  }
  // Global chat: look it up, then answer citing what the search numbered [1].
  if (last.role === 'user') return call('searchMeetings', { query: 'ship Q3' })
  return 'You agreed to ship before the end of Q3, pending legal sign-off [1].'
}

/** The agent requests the fake model received (to check what attachments reached it). */
const agentRequests = []
/** Every other model request (enhance, titles, Transcript Summary), to check the transcript's speaker labels. */
const modelRequests = []
const ollama = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'fake' }] }))
    const json = JSON.parse(body || '{}')
    if (json.tools) agentRequests.push(json)
    else if (json.messages) modelRequests.push(json)
    const system = json.messages?.[0]?.content ?? ''
    const turn = json.tools
      ? agentTurn(system, json.messages.slice(1))
      : system.includes('short, specific title')
        ? 'Pilot Budget and Q3 Timeline'
        : system.includes('Explain where that line comes from')
          ? 'They set Friday as the deadline for legal.\n> Q3 works if legal signs off on the data agreement by Friday.'
          : notes
    const reply = typeof turn === 'string' ? turn : (turn.text ?? '')
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    const parts = reply.match(/.{1,12}/gs) ?? []
    let i = 0
    const t = setInterval(() => {
      if (i < parts.length) res.write(JSON.stringify({ message: { content: parts[i++] }, done: false }) + '\n')
      else {
        if (typeof turn !== 'string') res.write(JSON.stringify({ message: { content: '', tool_calls: [{ function: turn.call }] }, done: false }) + '\n')
        // Like real Ollama, the last chunk counts the prompt and the reply (the Usage page's what-if prices them).
        res.end(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: Math.ceil(body.length / 4), eval_count: parts.length * 3 }) + '\n')
        clearInterval(t)
      }
      // The enhanced notes stream slowly enough to see (and screenshot) them being written.
    }, turn === notes ? 70 : 15)
  })
})
await new Promise((r) => ollama.listen(0, '127.0.0.1', r))
const ollamaUrl = `http://127.0.0.1:${ollama.address().port}`

const userData = mkdtempSync(join(tmpdir(), 'cereal-e2e-'))
writeFileSync(join(userData, '.env'), 'DEEPGRAM_API_KEY=fake-key\n')
const app = await electron.launch({
  args: ['out/main/index.js'],
  // The widget stays a window of this app (not the XWayland host process) so Playwright can see it.
  env: { ...process.env, CEREAL_USER_DATA: userData, CEREAL_DEEPGRAM_URL: dgUrl, CEREAL_WIDGET_IN_PROCESS: '1', ELECTRON_ENABLE_LOGGING: '0' }
})
const win = await app.firstWindow()
win.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && log('console', m.type(), m.text().slice(0, 600)))
win.on('pageerror', (e) => log('page error:', e.message, (e.stack || '').split('\n').slice(0, 4).join(' | ')))
await win.setViewportSize({ width: 1280, height: 820 }).catch(() => {})
await win.waitForSelector('text=Coming up')
await win.evaluate(async ({ ollamaUrl }) => {
  await window.cereal.invoke('settings:update', { llm: { provider: 'ollama', ollamaUrl, ollamaModel: 'fake' }, profile: { name: 'Dee' }, detection: { enabled: false }, audio: { playSounds: false } })
  // A short transcript panel, so the transcript overflows it and scrolling can be checked.
  localStorage.setItem('cereal.floatingChatHeight', '160')
}, { ollamaUrl })
await win.screenshot({ path: join(shots, '1-home.png') })
log('home ok')

await win.click('[data-testid="new-note-button"]')
await win.waitForSelector('.ProseMirror')
await win.fill('textarea[aria-label="Title"]', 'Acme pilot call')
await win.click('.ProseMirror')
await win.keyboard.type('budget 50k\nship Q3?\n')
await win.waitForTimeout(800)

await win.click('[data-testid="start-transcript-button"]')
await win.waitForSelector('[data-testid="stop-transcript-button"]', { timeout: 15000 })
log('recording started')
// The note's options sit under the title, and the recording widget sits left of the chat input.
if ((await win.$eval('[data-testid="note-options"]', (el) => el.previousElementSibling?.getAttribute('aria-label'))) !== 'Title') throw new Error('note options are not under the title')
const widgetBox = await win.$eval('[data-testid="recording-widget"]', (el) => el.getBoundingClientRect().toJSON())
const inputBox = await win.$eval('[data-testid="floating-chat"] [data-testid="chat-input"]', (el) => el.getBoundingClientRect().toJSON())
if (widgetBox.right > inputBox.left || widgetBox.bottom < inputBox.top || widgetBox.top > inputBox.bottom) throw new Error(`recording widget is not beside the chat input: ${JSON.stringify({ widgetBox, inputBox })}`)
log('layout ok')
// Clicking the widget opens the transcript in the chat bar; wait for scripted lines from both sources.
await win.click('[data-testid="show-transcript-button"]')
await win.waitForSelector('[data-testid="floating-chat"][data-state="transcript"]', { timeout: 5000 })
await win.waitForSelector('[data-testid="hide-transcript-button"]', { timeout: 5000 })
// The open panel leaves the toolbar clickable (an outside-click layer used to cover it).
const toolbarHit = await win.$eval('[data-testid="toggle-sidebar-button"]', (el) => {
  const r = el.getBoundingClientRect()
  return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
})
if (!toolbarHit) throw new Error('the open transcript panel covers the toolbar')
await win.setViewportSize({ width: 1280, height: 480 }).catch(() => {})
// Floating widget: appears when the main window loses focus during recording.
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
await win.waitForTimeout(1500)
const widget = app.windows().find((w) => w.url().includes('widget.html'))
if (!widget) throw new Error('widget window did not open')
await widget.waitForSelector('[data-testid="widget"]', { timeout: 5000 })
await widget.screenshot({ path: join(shots, '2b-widget.png') })
log('widget ok')
await app.evaluate(({ BrowserWindow }) => {
  const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('widget'))
  main.restore()
  main.focus()
})
await win.waitForSelector('text=I will send the contract draft tomorrow.', { timeout: 30000 })
await win.waitForSelector('text=Can we ship before the end of Q3?', { timeout: 30000 })
await win.screenshot({ path: join(shots, '2-recording.png') })
log('live transcript ok')

// Transcript scrolling: it follows the live text, stays put once scrolled up, and "Scroll to latest" lands at the
// real bottom without bouncing back.
const fromBottom = () => win.$eval('[data-testid="transcript-scroller"]', (el) => el.scrollHeight - el.scrollTop - el.clientHeight)
const overflow = await win.$eval('[data-testid="transcript-scroller"]', (el) => el.scrollHeight - el.clientHeight)
if (overflow < 100) throw new Error(`transcript does not overflow (${overflow}px), cannot check scrolling`)
await win.waitForTimeout(400)
if ((await fromBottom()) > 48) throw new Error(`transcript did not follow the live text (${await fromBottom()}px from the bottom)`)
await win.$eval('[data-testid="transcript-scroller"]', (el) => (el.scrollTop = 0))
await win.waitForSelector('button[aria-label="Scroll to latest"]', { timeout: 2000 })
await win.waitForTimeout(400)
if ((await win.$eval('[data-testid="transcript-scroller"]', (el) => el.scrollTop)) !== 0) throw new Error('transcript jumped after scrolling up')
await win.click('button[aria-label="Scroll to latest"]')
await win.waitForSelector('button[aria-label="Scroll to latest"]', { state: 'detached', timeout: 2000 })
await win.waitForTimeout(400)
if ((await fromBottom()) > 48) throw new Error(`"Scroll to latest" stopped ${await fromBottom()}px short of the bottom`)
await win.$eval('[data-testid="transcript-scroller"]', (el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 300))
await win.waitForTimeout(200)
await win.$eval('[data-testid="transcript-scroller"]', (el) => (el.scrollTop = el.scrollHeight))
await win.waitForTimeout(400)
if ((await fromBottom()) > 48) throw new Error(`transcript bounced after scrolling to the bottom (${await fromBottom()}px)`)
await win.screenshot({ path: join(shots, '2a-transcript-scroll.png') })
await win.setViewportSize({ width: 1280, height: 820 }).catch(() => {})
log('transcript scrolling ok')

await win.click('[data-testid="stop-transcript-button"]')
await win.waitForSelector('[data-testid="floating-chat"][data-state="idle"]', { timeout: 5000 })
await win.waitForSelector('[data-testid="enhance-button"]', { timeout: 15000 })
await win.screenshot({ path: join(shots, '2c-stopped.png') })

// Speakers: the call audio had two voices. The chip lists them with a sample line; naming them reaches the
// transcript bubbles, the saved note and the prompts.
await win.waitForSelector('[data-testid="speakers-chip"]:has-text("Identify speakers")', { timeout: 5000 })
if (!(await win.textContent('[data-testid="speakers-chip"]')).includes('2')) throw new Error('speakers chip does not count two unnamed voices')
await win.click('[data-testid="speakers-chip"]')
await win.waitForSelector('[data-testid="speaker-row"]:has-text("Speaker 1"):has-text("I will send the contract draft tomorrow.")', { timeout: 5000 })
await win.screenshot({ path: join(shots, '2d-speakers.png') })
const nameSpeaker = async (label, name) => {
  await win.click(`[data-testid="speaker-row"]:has-text("${label}") button:has-text("Identify")`)
  await win.fill('[data-testid="speaker-name-input"]', name)
  await win.keyboard.press('Enter')
  await win.waitForSelector(`[data-testid="speaker-row"]:has-text("${name}")`, { timeout: 5000 })
}
await nameSpeaker('Speaker 1', 'Kim')
await nameSpeaker('Speaker 2', 'Lee')
await win.waitForSelector('[data-testid="speakers-chip"]:has-text("2 speakers")', { timeout: 5000 })
await win.keyboard.press('Escape')
await win.click('[data-testid="show-transcript-button"]')
await win.waitForSelector('[data-testid="speaker-label"]:has-text("Lee")', { timeout: 5000 })
await win.waitForSelector('[data-testid="speaker-label"]:has-text("Kim")', { timeout: 5000 })
await win.screenshot({ path: join(shots, '2e-named-speakers.png') })
await win.keyboard.press('Escape')
await win.waitForSelector('[data-testid="floating-chat"][data-state="idle"]', { timeout: 5000 })
const savedSpeakers = await win.evaluate(async () => {
  const [doc] = await window.cereal.invoke('documents:list')
  return Object.values((await window.cereal.invoke('documents:get', doc.id)).speakers).map((s) => s.name).sort()
})
if (savedSpeakers.join() !== 'Kim,Lee') throw new Error(`speaker names were not saved: ${savedSpeakers}`)
log('speakers ok')
await win.click('[data-testid="enhance-button"]')
// While the notes are written: the status pill, and the user's notes underneath with the grey sweep.
await win.waitForSelector('[data-slot="enhance-status"]', { timeout: 10000 })
await win.waitForSelector('[data-testid="notes-echo"] .grayscale-text-pulse', { timeout: 5000 })
await win.waitForSelector('text=Pilot budget is $50k', { timeout: 20000 })
await win.screenshot({ path: join(shots, '3-generating.png') })
await win.waitForSelector('text=grey lines were added by AI', { timeout: 20000 })
// Then the pill goes and the user's notes fold up into the new notes.
await win.waitForSelector('[data-slot="enhance-status"]', { state: 'detached', timeout: 5000 })
await win.waitForSelector('[data-testid="notes-echo"]', { state: 'detached', timeout: 8000 })
await win.waitForTimeout(500)
await win.screenshot({ path: join(shots, '3-enhanced.png') })
if (!modelRequests.some((r) => r.messages.some((m) => typeof m.content === 'string' && m.content.includes('Lee: Q3 works if legal signs off')))) throw new Error('the enhance prompt does not name the speaker')
log('enhance ok')

// Enhanced notes are an editor: AI lines are grey, the user's own (typed "budget 50k") are not.
const aiLine = '.enhanced-notes p:has-text("Legal must approve the data agreement by Friday")'
await win.waitForSelector(`${aiLine}[data-generated="true"]`, { timeout: 5000 })
if (await win.$('.enhanced-notes p[data-generated="true"]:has-text("Pilot budget is $50k")')) throw new Error("the user's own line is marked as AI-written")

// Transcript Summary: hovering a line shows its button; the popover streams a summary and a quote from the transcript.
await win.hover(aiLine)
await win.click('[data-testid="transcript-summary-button"]')
await win.waitForSelector('[data-testid="transcript-summary-header"]', { timeout: 5000 })
await win.waitForSelector('[data-testid="transcript-summary-quote"]:has-text("Lee •")', { timeout: 20000 })
await win.waitForSelector('text=They set Friday as the deadline for legal.', { timeout: 5000 })
await win.screenshot({ path: join(shots, '3a-transcript-summary.png') })
// The quote opens the transcript at the words it came from. A click outside collapses it and still lands.
await win.click('[data-testid="transcript-summary-quote"]')
await win.waitForSelector('[data-testid="floating-chat"][data-state="transcript"]', { timeout: 5000 })
await win.waitForSelector('[data-testid="transcript-scroller"] [data-highlighted]:has-text("legal signs off")', { timeout: 5000 })
await win.screenshot({ path: join(shots, '3b-quote-in-transcript.png') })
await win.click('[data-testid="share-button"]')
await win.waitForSelector('[data-testid="floating-chat"][data-state="idle"]', { timeout: 5000 })
await win.waitForSelector('[role="menu"]:has-text("Copy as Markdown")', { timeout: 5000 })
await win.keyboard.press('Escape')
await win.waitForSelector('[role="menu"]', { state: 'detached', timeout: 5000 })
log('transcript summary ok')

// Editing an AI line makes it the user's (black), and the edit is saved.
await win.click(aiLine)
await win.keyboard.press('End')
await win.keyboard.type(' (confirmed)')
await win.waitForSelector('.enhanced-notes p:has-text("Friday (confirmed)"):not([data-generated])', { timeout: 5000 })
await win.waitForTimeout(1500)
const savedEdit = await win.evaluate(async () => {
  const doc = (await window.cereal.invoke('documents:list'))[0]
  return (await window.cereal.invoke('panels:list', doc.id))[0].content
})
if (!savedEdit.includes('Friday (confirmed)')) throw new Error(`enhanced notes edit was not saved: ${savedEdit}`)
log('enhanced edit ok')

// The chat bar (docs/granola-chat-bar.md): a TipTap editor in the floating bar at the bottom of the note.
const noteChat = '[data-testid="floating-chat"] [data-testid="chat-input"] .ProseMirror'
const typeInChat = async (selector, text) => {
  await win.click(selector)
  await win.keyboard.type(text)
}
await win.waitForSelector('[data-testid="floating-chat"] [data-testid="chat-input"][data-placeholder="Ask anything"]')

// "/" opens the recipe menu; choosing one leaves a recipe chip in the text.
await typeInChat(noteChat, '/tl')
await win.waitForSelector('[role="listbox"][aria-label="Recipes"] [role="option"]', { timeout: 5000 })
await win.waitForTimeout(300)
await win.screenshot({ path: join(shots, '4c-recipe-menu.png') })
await win.keyboard.press('Enter')
await win.waitForSelector(`${noteChat} .chat-recipe-node[data-recipe="tldr"]`, { timeout: 5000 })
await win.keyboard.press('Control+a')
await win.keyboard.press('Backspace')
log('recipe menu ok')

// The model picker lists the cloud providers (unavailable without keys) and Ollama's local models.
await win.click('[data-testid="floating-chat"] [data-testid="model-picker"]')
await win.waitForSelector('[role="menu"] :text("Gemini 3.1 Pro")', { timeout: 5000 })
const geminiDisabled = await win.$eval('[role="menuitem"]:has-text("Gemini 3.1 Pro")', (el) => el.hasAttribute('data-disabled') || el.getAttribute('aria-disabled') === 'true')
if (!geminiDisabled) throw new Error('Gemini should be unavailable without GEMINI_API_KEY')
await win.waitForSelector('[role="menuitem"]:has-text("fake")', { timeout: 5000 })
await win.screenshot({ path: join(shots, '4d-model-picker.png') })
await win.keyboard.press('Escape')
log('model picker ok')

// Files: a PNG and a text file, as chips; the model gets the image (Ollama's `images`) and the text.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
await win.setInputFiles('[data-testid="floating-chat"] [data-testid="attach-file-input"]', [
  { name: 'chart.png', mimeType: 'image/png', buffer: png },
  { name: 'budget.txt', mimeType: 'text/plain', buffer: Buffer.from('Pilot budget: 50,000 USD, approved by finance.') }
])
try {
  await win.waitForFunction(() => document.querySelectorAll('[data-testid="floating-chat"] [data-testid="chat-chip"]').length >= 2 && !document.querySelector('[data-testid="floating-chat"] [data-testid="chat-chip"] .animate-spin'), null, { timeout: 10000 })
} catch (e) {
  await win.screenshot({ path: join(shots, 'fail-attachments.png') })
  log('chips', await win.$$eval('[data-testid="floating-chat"] [data-testid="chat-chip"]', (els) => els.map((el) => el.outerHTML.slice(0, 300))))
  throw e
}
await win.screenshot({ path: join(shots, '4e-attachments.png') })

await typeInChat(noteChat, 'What is the budget?')
await win.keyboard.press('Enter')
try {
  await win.waitForSelector('text=The pilot budget is', { timeout: 20000 })
} catch (e) {
  await win.screenshot({ path: join(shots, 'fail-chat.png') })
  log('threads', JSON.stringify(await win.evaluate(async () => {
    const d = (await window.cereal.invoke('documents:list'))[0]
    const t = await window.cereal.invoke('chat:threads', d.id)
    return { t, m: t[0] ? await window.cereal.invoke('chat:messages', t[0].id) : null }
  })))
  throw e
}
await win.screenshot({ path: join(shots, '4-chat.png') })
const withFiles = agentRequests.find((r) => r.messages.some((m) => m.role === 'user' && m.images?.length))
if (!withFiles) throw new Error('the image never reached the model')
const asked = withFiles.messages.filter((m) => m.role === 'user').pop()
if (!asked.content.includes('Pilot budget: 50,000 USD') || !asked.content.includes('What is the budget?')) throw new Error(`attachment text missing: ${asked.content.slice(0, 300)}`)
await win.waitForSelector('[data-testid="user-message"] [data-testid="chat-chip"]:has-text("chart.png")', { timeout: 5000 })
log('note chat with attachments ok')

// Edit the question: the overwrite warning shows, and the answer is replaced.
await win.hover('[data-testid="user-message"]')
await win.click('[data-testid="user-message"] button[aria-label="Edit message"]')
await win.waitForSelector('[data-testid="edit-banner"]', { timeout: 5000 })
await win.keyboard.type(' In dollars.')
await win.keyboard.press('Enter')
await win.waitForSelector('[data-testid="edit-banner"]', { state: 'detached', timeout: 5000 })
await win.waitForSelector('[data-testid="user-message"]:has-text("In dollars.")', { timeout: 10000 })
if ((await win.$$('[data-testid="user-message"]')).length !== 1) throw new Error('editing should replace the question, not add one')
await win.waitForSelector('text=The pilot budget is', { timeout: 20000 })
log('edit and resend ok')

// Ctrl+J closes the open panel and opens it again.
await win.keyboard.press('Control+j')
await win.waitForSelector('[data-testid="floating-chat"][data-state="idle"]', { timeout: 5000 })
await win.keyboard.press('Control+j')
await win.waitForSelector('[data-testid="floating-chat"][data-state="chat"]', { timeout: 5000 })
log('ctrl+j ok')

// The chat edits the notepad (switching to My notes), and the edit can be undone.
await typeInChat(noteChat, 'Spell out the budget')
await win.keyboard.press('Enter')
await win.waitForSelector('text=Applied to your notes', { timeout: 20000 })
await win.waitForSelector('.ProseMirror :text("budget $50,000")', { timeout: 5000 })
await win.waitForSelector('text=I spelled out the budget', { timeout: 10000 })
await win.screenshot({ path: join(shots, '4a-chat-edit.png') })
await win.click('button:has-text("Undo")')
await win.waitForSelector('.ProseMirror :text("budget 50k")', { timeout: 5000 })
await win.waitForSelector('button:has-text("Reapply")', { timeout: 5000 })
log('note edit + undo ok')

const state = await win.evaluate(async () => {
  const docs = await window.cereal.invoke('documents:list')
  const doc = docs[0]
  const chunks = await window.cereal.invoke('transcript:get', doc.id)
  const panels = await window.cereal.invoke('panels:list', doc.id)
  const hits = await window.cereal.invoke('search:query', 'contract draft')
  return { title: doc.title, chunks: chunks.length, sources: [...new Set(chunks.map((c) => c.source))], allFinal: chunks.every((c) => c.is_final), panel: panels[0]?.generated_lines, hits: hits.length }
})
log('state', JSON.stringify(state))
if (state.chunks < 6 || state.sources.length !== 2 || !state.allFinal || state.hits < 1) throw new Error('unexpected persisted state')

// Note pages close the sidebar; open it, then go to Chat.
await win.keyboard.press('Control+s')
await win.click('[data-testid="sidebar-chat"]')
await win.waitForSelector('text=Hi Dee, ask anything')
// "@" points at a note: it goes in as a mention, and shows as a chip on the sent question.
const pageChat = '[data-testid="chat-input"] .ProseMirror'
await typeInChat(pageChat, '@Acme')
await win.waitForSelector('[role="listbox"][aria-label="Notes"] :text("Acme pilot call")', { timeout: 5000 })
await win.keyboard.press('Enter')
await win.waitForSelector(`${pageChat} .chat-mention-node`, { timeout: 5000 })
await win.keyboard.type('When are we shipping?')
await win.keyboard.press('Enter')
await win.waitForSelector('button:has-text("1. Acme pilot call")', { timeout: 20000 })
await win.waitForSelector('text=Searched meetings', { timeout: 5000 })
await win.waitForSelector('[data-testid="user-message"] [data-testid="chat-chip"]:has-text("Acme pilot call")', { timeout: 5000 })
const mentioned = agentRequests.at(-1).messages.find((m) => m.role === 'user' && m.content.includes('When are we shipping?'))
if (!mentioned?.content.includes('meeting_id:')) throw new Error('the mentioned note was not passed to the model')
await win.screenshot({ path: join(shots, '4b-ask-cereal.png') })
log('global chat with mention, tools and citation ok')

// The Assistant hands the work to a task (run by the agent utility process), which drafts and reports back.
await win.click('[data-testid="sidebar-assistant"]')
await win.waitForSelector('text=Your Assistant')
await win.fill('textarea[placeholder^="Ask your Assistant"]', 'Draft a follow-up to Acme')
await win.keyboard.press('Enter')
try {
  await win.waitForSelector('text=Your Acme follow-up is ready to review.', { timeout: 30000 })
} catch (e) {
  await win.screenshot({ path: join(shots, 'fail-assistant.png') })
  log('assistant', JSON.stringify(await win.evaluate(() => window.cereal.invoke('assistant:open'))).slice(0, 3000))
  throw e
}
await win.waitForSelector('text=Ready to review · 1', { timeout: 5000 })
await win.screenshot({ path: join(shots, '8-assistant.png') })
await win.click('button:has-text("Acme follow-up") >> nth=0')
await win.waitForSelector('text=Email draft', { timeout: 10000 })
await win.waitForSelector('text=Drafted the Acme follow-up', { timeout: 5000 })
await win.screenshot({ path: join(shots, '8b-assistant-task.png') })
const assistant = await win.evaluate(() => window.cereal.invoke('assistant:open'))
if (assistant.tasks.length !== 1 || assistant.tasks[0].status !== 'done') throw new Error(`unexpected tasks: ${JSON.stringify(assistant.tasks)}`)
log('assistant task ok')

await win.click('[data-testid="sidebar-home"]')
await win.waitForSelector('text=Coming up')
await win.screenshot({ path: join(shots, '1b-home-notes.png') })
// A click inside a note row's delete dialog (here its text) stays in the dialog: it used to bubble through the
// portal to the row and open the note.
await win.hover('[data-testid="note-list-item"] >> nth=0')
await win.click('[data-testid="note-list-item"] >> nth=0 >> [data-testid="note-menu-button"]')
await win.click('[role="menuitem"]:has-text("Delete note")')
await win.click('[role="dialog"] >> text=Its transcript and enhanced notes are deleted too.')
await win.waitForTimeout(300)
if ((await win.evaluate(() => location.hash)) !== '#/' || !(await win.$('[role="dialog"]'))) throw new Error('a click in the row\'s delete dialog left Home')
await win.click('[role="dialog"] button:has-text("Cancel")')
await win.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 5000 })
log('note row dialog ok')
await win.keyboard.press('Control+k')
await win.keyboard.type('contract')
await win.waitForTimeout(400)
await win.screenshot({ path: join(shots, '5-search.png') })
await win.keyboard.press('Escape')

await win.keyboard.press('Control+,')
await win.waitForSelector('text=Preferences')
await win.waitForTimeout(300)
await win.screenshot({ path: join(shots, '6-settings.png') })

// Settings → Usage: the meeting's two Deepgram streams cost money; the fake Ollama model is local and free, but the
// what-if prices its tokens on the cloud models.
await win.click('[data-testid="settings-nav-usage"]')
await win.waitForSelector('[data-testid="usage-total"]', { timeout: 5000 })
await win.waitForSelector('text=What if')
await win.waitForTimeout(300)
await win.screenshot({ path: join(shots, '6b-usage.png') })
const usage = await win.evaluate(() => window.cereal.invoke('usage:summary', 'all'))
const purposes = usage.purposes.map((p) => p.purpose)
for (const p of ['transcription', 'enhance', 'transcript-summary', 'chat', 'chat-title', 'assistant']) {
  if (!purposes.includes(p)) throw new Error(`no ${p} usage recorded: ${purposes.join(', ')}`)
}
const deepgram = usage.audio.find((a) => a.provider === 'deepgram' && a.mode === 'streaming')
if (!deepgram || deepgram.minutes <= 0 || !(deepgram.cost > 0)) throw new Error(`transcription usage missing: ${JSON.stringify(usage.audio)}`)
const local = usage.models.find((m) => m.provider === 'ollama' && m.model === 'fake')
if (!local?.local || local.inputTokens <= 0 || usage.cost.llm !== 0) throw new Error(`ollama usage wrong: ${JSON.stringify(usage.models)}`)
if (!usage.whatIf.llm.length || usage.whatIf.llm.some((r) => !(r.cost > 0))) throw new Error(`what-if missing: ${JSON.stringify(usage.whatIf)}`)
log('usage ok', `$${usage.cost.total.toFixed(4)} (${deepgram.minutes.toFixed(2)} min audio, ${local.requests} local requests)`)

await win.evaluate(() => window.cereal.invoke('settings:update', { theme: 'dark' }))
await win.waitForTimeout(300)
await win.screenshot({ path: join(shots, '6c-usage-dark.png') })
await win.click('text=Back to notes')
await win.waitForTimeout(300)
await win.screenshot({ path: join(shots, '7-home-dark.png') })

await app.close()
dg.close()
ollama.close()
log('PASS — screenshots in', shots)
