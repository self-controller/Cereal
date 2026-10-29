import type { Readable, Writable } from 'node:stream'
import type { WidgetState } from '@shared/ipc'
import type { RecordingState } from '@shared/types'

// Messages between the app and the widget host process (widget/host.ts), one JSON object per line over the
// child's fd 3.

export const WIDGET_HOST_FLAG = '--cereal-widget-host'
/** File descriptor the host reads and writes messages on. */
export const WIDGET_HOST_FD = 3

export type WidgetAction = 'start' | 'dismiss' | 'open'

export type ToHost =
  | { type: 'state'; state: WidgetState }
  | { type: 'recording'; state: RecordingState }
  | { type: 'levels'; levels: { microphone: number; system: number } }
  | { type: 'show' }
  | { type: 'hide' }

export type FromHost = { type: 'ready' } | { type: 'action'; action: WidgetAction }

export function send(stream: Writable, msg: ToHost | FromHost): void {
  if (stream.writable) stream.write(`${JSON.stringify(msg)}\n`)
}

/** Call `onMessage` for every complete line on `stream`; malformed lines are skipped. */
export function receive<T>(stream: Readable, onMessage: (msg: T) => void): void {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (data: string) => {
    buffer += data
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (!line.trim()) continue
      let msg: T
      try {
        msg = JSON.parse(line) as T
      } catch {
        continue // Not ours (or truncated).
      }
      onMessage(msg)
    }
  })
}
