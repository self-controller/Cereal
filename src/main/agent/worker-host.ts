import { utilityProcess, type UtilityProcess } from 'electron'
import type { AgentBackend, AgentHost } from './backend'
import type { BackendMethod, FromWorker, ToWorker } from './protocol'

/**
 * Runs the agent loop in an Electron utility process (out/main/agent.js), the way Granola keeps heavy work out of
 * main. The worker calls back into the backend for every database or tool action; if it dies, its runs fail and
 * the next run starts a fresh worker.
 */
export class WorkerHost implements AgentHost {
  private child: UtilityProcess | null = null
  private ready = false
  private queue: ToWorker[] = []
  /** Runs handed to the current worker that haven't finished or suspended yet. */
  private inflight = new Set<string>()

  constructor(
    private readonly entry: string,
    private readonly backend: AgentBackend
  ) {}

  start(runId: string): void {
    this.inflight.add(runId)
    this.post({ type: 'run', runId })
  }

  cancel(runId: string): void {
    if (this.child) this.post({ type: 'cancel', runId })
  }

  stop(): void {
    this.child?.kill()
    this.child = null
  }

  private spawn(): UtilityProcess {
    const child = utilityProcess.fork(this.entry, [], { serviceName: 'Cereal agent', stdio: 'inherit' })
    child.on('message', (msg: FromWorker) => void this.onMessage(child, msg))
    child.on('exit', () => {
      if (this.child === child) {
        this.child = null
        this.ready = false
      }
      const lost = [...this.inflight]
      this.inflight.clear()
      for (const runId of lost) this.backend.failIfRunning(runId, 'The agent process stopped unexpectedly. Try again.')
    })
    return child
  }

  private post(msg: ToWorker): void {
    if (!this.child) {
      this.ready = false
      this.child = this.spawn()
    }
    if (this.ready) this.child.postMessage(msg)
    else this.queue.push(msg)
  }

  private async onMessage(child: UtilityProcess, msg: FromWorker): Promise<void> {
    if (msg.type === 'ready') {
      this.ready = true
      for (const m of this.queue.splice(0)) child.postMessage(m)
      return
    }
    const runId = msg.args[0] as string
    try {
      const fn = this.backend[msg.method as BackendMethod] as (...a: unknown[]) => unknown
      const result = await fn.apply(this.backend, msg.args)
      if (msg.method === 'finish' || msg.method === 'suspend' || (msg.method === 'claim' && result === null)) this.inflight.delete(runId)
      child.postMessage({ type: 'reply', id: msg.id, result } satisfies ToWorker)
    } catch (e) {
      child.postMessage({ type: 'reply', id: msg.id, error: e instanceof Error ? e.message : String(e) } satisfies ToWorker)
    }
  }
}
