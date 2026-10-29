import { shell, type BrowserWindow, type BrowserWindowConstructorOptions } from 'electron'
import { join } from 'node:path'

// Window helpers shared by the app (app.ts) and the widget host process (widget/host.ts). Both are entry files in
// out/main while shared code lands in out/main/chunks, so callers pass their own __dirname as `baseDir`.

export type Page = 'index' | 'widget'

export function loadPage(win: BrowserWindow, baseDir: string, page: Page, route = ''): void {
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (dev) void win.loadURL(`${dev}/${page}.html${route ? `#${route}` : ''}`)
  else void win.loadFile(join(baseDir, `../renderer/${page}.html`), route ? { hash: route } : undefined)
}

/** Whether an IPC sender is one of Cereal's own pages. */
export function isOwnPage(url: string): boolean {
  const dev = process.env['ELECTRON_RENDERER_URL']
  return url.startsWith('file://') || (!!dev && url.startsWith(dev))
}

export function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file://')) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })
}

/**
 * The floating widget's window: a frameless, transparent, always-on-top panel the page sizes itself. `zoom` scales
 * the page (the XWayland host matches the app's display scale with it).
 */
export function widgetWindowOptions(
  baseDir: string,
  bounds: { x: number; y: number; width: number; height: number },
  { zoom = 1 }: { zoom?: number } = {}
): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    title: 'Cereal recording',
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: join(baseDir, '../preload/index.js'), sandbox: true, contextIsolation: true, zoomFactor: zoom }
  }
}
