import { app, BrowserWindow, screen } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { join } from 'node:path'
import { handle, setSenderValidator } from '../ipc'
import { hardenWindow, isOwnPage, loadPage, widgetWindowOptions } from '../windows'
import { anchorResize, defaultWidgetBounds, fitWidgetSize, hostZoom, isSavedPosition, restoreBounds, type Rect, type SavedPosition } from './placement'
import { receive, send, WIDGET_HOST_FD, type FromHost, type ToHost } from './protocol'
import type { WidgetState } from '@shared/ipc'
import type { RecordingState } from '@shared/types'

// The floating widget's own process (started by widget/controller.ts). Wayland compositors such as GNOME ignore
// where a window asks to be and won't keep it above other apps, so on Wayland the app runs this host with
// --ozone-platform=x11: as an XWayland client the widget can sit at the screen edge and stay on top, while the main
// window stays a native Wayland one. The host only draws the widget; the app owns all state and actions.

app.setName('Cereal')
// Its own Chromium profile, so the two processes never contend for the app's caches and locks.
app.setPath('userData', process.env['CEREAL_WIDGET_USER_DATA'] || join(app.getPath('appData'), 'Cereal', 'widget-host'))

const channel = new Socket({ fd: WIDGET_HOST_FD, readable: true, writable: true })
const post = (msg: FromHost): void => send(channel, msg)
// The app went away (quit or crashed): so does the widget.
channel.on('close', () => app.quit())
channel.on('error', () => app.quit())

let state: WidgetState = { mode: 'recording', documentId: null }
let recording: RecordingState = { status: 'idle', document_id: null, started_at: null, engine: null, sources: [], error: null, warnings: [] }
let size = { width: 48, height: 120 }
let visible = false
let win: BrowserWindow | null = null
/** Page zoom that sizes the widget like the app's UI (set once the screen is known). */
let zoom = 1

const positionFile = (): string => join(app.getPath('userData'), 'widget-position.json')

function readPosition(): SavedPosition | null {
  try {
    const saved: unknown = JSON.parse(readFileSync(positionFile(), 'utf8'))
    return isSavedPosition(saved) ? saved : null
  } catch {
    return null
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function savePosition(bounds: Rect): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(positionFile(), JSON.stringify({ bounds, display: screen.getDisplayMatching(bounds).bounds }))
    } catch {
      // Losing the position only means the widget starts at the default spot next time.
    }
  }, 500)
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  const restored = restoreBounds(readPosition(), screen.getAllDisplays(), size)
  const bounds = restored ?? defaultWidgetBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea, size)
  // Focusable on purpose: an unfocusable X11 window is override-redirect, which the window manager won't let the
  // user drag. (GNOME ignores the "demands attention" hint on skip-taskbar windows, so no notification shows.)
  const w = new BrowserWindow(widgetWindowOptions(__dirname, bounds, { zoom }))
  w.setAlwaysOnTop(true, 'floating')
  w.setVisibleOnAllWorkspaces(true)
  hardenWindow(w)
  w.on('move', () => savePosition(w.getBounds()))
  w.on('closed', () => {
    if (win === w) win = null
  })
  loadPage(w, __dirname, 'widget')
  win = w
  return w
}

function relay(channelName: 'widget:state' | 'recording:state' | 'audio:levels', payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channelName, payload)
}

function onMessage(msg: ToHost): void {
  if (msg.type === 'state') {
    state = msg.state
    relay('widget:state', state)
  } else if (msg.type === 'recording') {
    recording = msg.state
    relay('recording:state', recording)
  } else if (msg.type === 'levels') {
    relay('audio:levels', msg.levels)
  } else if (msg.type === 'show') {
    visible = true
    if (!app.isReady()) return
    const w = ensureWindow()
    if (!w.isVisible()) w.showInactive()
  } else if (msg.type === 'hide') {
    visible = false
    if (win?.isVisible()) win.hide()
  }
}

receive<ToHost>(channel, onMessage)

// The widget is only ever hidden, but keep the host alive if its window does close.
app.on('window-all-closed', () => undefined)

void app.whenReady().then(() => {
  zoom = hostZoom(Number(process.env['CEREAL_WIDGET_SCALE']), screen.getPrimaryDisplay().scaleFactor)
  setSenderValidator((event) => isOwnPage(event.senderFrame?.url ?? ''))
  handle('widget:state', () => state)
  handle('recording:state', () => recording)
  handle('widget:resize', (next) => {
    // The page measures in CSS pixels; the window is in DIPs.
    size = fitWidgetSize({ width: next.width * zoom, height: next.height * zoom })
    if (!win || win.isDestroyed()) return
    const prev = win.getBounds()
    win.setBounds(anchorResize(prev, size, screen.getDisplayMatching(prev).workArea))
  })
  handle('widget:action', (action) => post({ type: 'action', action }))
  if (visible) onMessage({ type: 'show' })
  post({ type: 'ready' })
})
