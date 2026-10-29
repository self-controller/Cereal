import { app, BrowserWindow, screen } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { hardenWindow, loadPage, widgetWindowOptions } from '../windows'
import { anchorResize, defaultWidgetBounds, type Size } from './placement'
import { receive, send, WIDGET_HOST_FD, WIDGET_HOST_FLAG, type FromHost, type ToHost, type WidgetAction } from './protocol'
import type { WidgetState } from '@shared/ipc'
import type { RecordingState } from '@shared/types'

// The floating widget ("nub", docs/granola-ui.md §Nub), as the app sees it. On X11 it is an ordinary window of the
// app. On Wayland, where the compositor decides window positions and ignores always-on-top, it lives in a small
// XWayland host process instead (widget/host.ts) that the app drives over a pipe.

export interface Widget {
  show(): void
  hide(): void
  isVisible(): boolean
  /** Get the widget ready before its first appearance (recording started). */
  warm(): void
  /** The page's own size report (the in-process widget's `widget:resize`). */
  resize(size: Size): void
  // State changes. The in-process widget already receives every broadcast, so these only feed the host.
  setState(state: WidgetState): void
  setRecording(state: RecordingState): void
  setLevels(levels: { microphone: number; system: number }): void
  dispose(): void
}

export interface WidgetOptions {
  /** The app entry's __dirname (out/main). */
  baseDir: string
  /** Current state, to bring a newly started host up to date. */
  snapshot: () => { widget: WidgetState; recording: RecordingState }
  onAction: (action: WidgetAction) => void
}

export function createWidget(opts: WidgetOptions): Widget {
  return useHost() ? new HostedWidget(opts) : new InProcessWidget(opts.baseDir)
}

/** Linux on Wayland with XWayland available, unless CEREAL_WIDGET_IN_PROCESS=1 (the e2e run keeps it in-process). */
function useHost(): boolean {
  if (process.platform !== 'linux' || process.env['CEREAL_WIDGET_IN_PROCESS'] === '1' || !process.env['DISPLAY']) return false
  const ozone = app.commandLine.getSwitchValue('ozone-platform')
  return ozone ? ozone === 'wayland' : !!process.env['WAYLAND_DISPLAY']
}

class InProcessWidget implements Widget {
  private win: BrowserWindow | null = null
  private size: Size = { width: 48, height: 120 }

  constructor(private readonly baseDir: string) {}

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const win = new BrowserWindow(widgetWindowOptions(this.baseDir, defaultWidgetBounds(area, this.size)))
    win.setAlwaysOnTop(true, 'floating')
    hardenWindow(win)
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    loadPage(win, this.baseDir, 'widget')
    this.win = win
    return win
  }

  show(): void {
    const win = this.ensure()
    if (!win.isVisible()) win.showInactive()
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide()
  }

  isVisible(): boolean {
    return !!this.win && !this.win.isDestroyed() && this.win.isVisible()
  }

  warm(): void {}

  resize(size: Size): void {
    this.size = size
    const win = this.win
    if (!win || win.isDestroyed()) return
    const prev = win.getBounds()
    win.setBounds(anchorResize(prev, size, screen.getDisplayMatching(prev).workArea))
  }

  setState(): void {}
  setRecording(): void {}
  setLevels(): void {}

  dispose(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
  }
}

/** A host that exits this soon after starting counts as a failed start. */
const QUICK_EXIT_MS = 10_000
/** After this many failed starts, fall back to an in-process widget wherever the compositor puts it. */
const MAX_FAILED_STARTS = 3

class HostedWidget implements Widget {
  private child: ChildProcess | null = null
  private channel: Duplex | null = null
  private ready = false
  /** Whether the app wants the widget shown; the host is told on every (re)start. */
  private visible = false
  private failedStarts = 0
  private fallback: InProcessWidget | null = null
  private disposed = false

  constructor(private readonly opts: WidgetOptions) {}

  private start(): void {
    if (this.child || this.disposed) return
    // A packaged app always runs its own entry; an unpacked one needs the app path.
    const args = [...(app.isPackaged ? [] : [app.getAppPath()]), WIDGET_HOST_FLAG, '--ozone-platform=x11']
    // CEREAL_WIDGET_DEBUG_PORT opens DevTools on the host, for inspecting or driving the widget page.
    const debugPort = process.env['CEREAL_WIDGET_DEBUG_PORT']
    if (debugPort && /^\d+$/.test(debugPort)) args.push(`--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1')
    const startedAt = Date.now()
    // The host matches the widget's size to this display's scale (placement.ts hostZoom).
    const scale = screen.getPrimaryDisplay().scaleFactor
    const child = spawn(process.execPath, args, {
      stdio: ['ignore', 'inherit', 'inherit', 'pipe'],
      env: {
        ...process.env,
        CEREAL_WIDGET_USER_DATA: join(app.getPath('userData'), 'widget-host'),
        CEREAL_WIDGET_SCALE: String(scale)
      }
    })
    const channel = child.stdio[WIDGET_HOST_FD] as Duplex
    channel.on('error', () => undefined)
    receive<FromHost>(channel, (msg) => this.onMessage(child, msg))
    child.on('error', (e) => console.warn('Widget host failed to start:', e.message))
    child.on('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.channel = null
      this.ready = false
      if (this.disposed) return
      console.warn(`Widget host exited (${signal ?? code})`)
      if (Date.now() - startedAt < QUICK_EXIT_MS && ++this.failedStarts >= MAX_FAILED_STARTS) {
        console.warn('Widget host keeps failing; showing the widget in-process instead.')
        this.fallback = new InProcessWidget(this.opts.baseDir)
        if (this.visible) this.fallback.show()
      } else if (this.visible) {
        this.start()
      }
    })
    this.child = child
    this.channel = channel
  }

  private onMessage(child: ChildProcess, msg: FromHost): void {
    if (child !== this.child) return
    if (msg.type === 'ready') {
      this.ready = true
      const { widget, recording } = this.opts.snapshot()
      this.post({ type: 'state', state: widget })
      this.post({ type: 'recording', state: recording })
      this.post({ type: this.visible ? 'show' : 'hide' })
    } else if (msg.type === 'action') {
      this.opts.onAction(msg.action)
    }
  }

  /** Until the host is ready, messages are dropped: it is brought up to date when it says it's ready. */
  private post(msg: ToHost): void {
    if (this.ready && this.channel) send(this.channel, msg)
  }

  show(): void {
    if (this.fallback) return this.fallback.show()
    this.visible = true
    this.start()
    this.post({ type: 'show' })
  }

  hide(): void {
    if (this.fallback) return this.fallback.hide()
    if (!this.visible) return
    this.visible = false
    this.post({ type: 'hide' })
  }

  isVisible(): boolean {
    return this.fallback ? this.fallback.isVisible() : this.visible
  }

  warm(): void {
    if (!this.fallback) this.start()
  }

  resize(size: Size): void {
    this.fallback?.resize(size)
  }

  setState(state: WidgetState): void {
    this.post({ type: 'state', state })
  }

  setRecording(state: RecordingState): void {
    this.post({ type: 'recording', state })
  }

  setLevels(levels: { microphone: number; system: number }): void {
    if (this.visible) this.post({ type: 'levels', levels })
  }

  dispose(): void {
    this.disposed = true
    this.child?.kill()
    this.child = null
    this.fallback?.dispose()
  }
}
