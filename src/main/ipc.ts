import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { EventChannel, EventMap, InvokeChannel, InvokeMap } from '@shared/ipc'

type Handler<K extends InvokeChannel> = (...args: Parameters<InvokeMap[K]>) => ReturnType<InvokeMap[K]> | Promise<Awaited<ReturnType<InvokeMap[K]>>>

let isTrustedSender: (event: IpcMainInvokeEvent) => boolean = () => true

/** Only accept IPC from Cereal's own windows. */
export function setSenderValidator(fn: (event: IpcMainInvokeEvent) => boolean): void {
  isTrustedSender = fn
}

export function handle<K extends InvokeChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    return handler(...(args as Parameters<InvokeMap[K]>))
  })
}

export function broadcast<K extends EventChannel>(channel: K, payload: EventMap[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
