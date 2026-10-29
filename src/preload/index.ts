import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, type CerealBridge, type EventChannel, type InvokeChannel } from '@shared/ipc'

const invokeAllowed = new Set<string>(INVOKE_CHANNELS)
const eventAllowed = new Set<string>(EVENT_CHANNELS)

const bridge: CerealBridge = {
  invoke: ((channel: InvokeChannel, ...args: unknown[]) => {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`))
    return ipcRenderer.invoke(channel, ...args)
  }) as CerealBridge['invoke'],
  on: ((channel: EventChannel, listener: (payload: unknown) => void) => {
    if (!eventAllowed.has(channel)) throw new Error(`Unknown channel ${channel}`)
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }) as CerealBridge['on'],
  platform: process.platform
}

contextBridge.exposeInMainWorld('cereal', bridge)
