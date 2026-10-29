// The agent utility process: runs the model/tool loop and talks to the backend in main over the parent port.
import { createProviderFromConfig } from '../../llm'
import type { BackendApi, BackendMethod, FromWorker, ToWorker } from '../protocol'
import { AgentRuntime } from '../runtime'

const port = process.parentPort
let nextId = 1
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function send(msg: FromWorker): void {
  port.postMessage(msg)
}

function call(method: BackendMethod, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { resolve, reject })
    send({ type: 'call', id, method, args })
  })
}

const backend = new Proxy({} as BackendApi, {
  get: (_target, method: string) => (...args: unknown[]) => call(method as BackendMethod, args)
})

const runtime = new AgentRuntime(backend, createProviderFromConfig)

port.on('message', (e: Electron.MessageEvent) => {
  const msg = e.data as ToWorker
  if (msg.type === 'run') runtime.start(msg.runId)
  else if (msg.type === 'cancel') runtime.cancel(msg.runId)
  else if (msg.type === 'reply') {
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    if (msg.error !== undefined) w.reject(new Error(msg.error))
    else w.resolve(msg.result)
  }
})

send({ type: 'ready' })
