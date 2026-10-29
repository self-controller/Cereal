import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { encodeWav, pcm16ToFloat32, PrefixStabilizer, Segmenter, type SegmentEvent } from './segmenter'
import type { StreamOptions, TranscriptionEngine, TranscriptionStream } from './types'

const READY_TIMEOUT_MS = 60_000
const REQUEST_TIMEOUT_MS = 120_000

/** Find a whisper.cpp server binary: explicit path, then PATH, then common install dirs. */
export function findWhisperServer(explicit: string): string | null {
  if (explicit && existsSync(explicit)) return explicit
  const names = ['whisper-server', 'whisper-cpp-server', 'whisper.cpp-server']
  const dirs = [...(process.env.PATH ?? '').split(':'), join(homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin', join(homedir(), 'whisper.cpp/build/bin')]
  for (const dir of dirs) for (const name of names) if (dir && existsSync(join(dir, name))) return join(dir, name)
  return null
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('No free port'))))
    })
  })
}

/**
 * Owns one `whisper-server` process on a random localhost port, like Granola's local ASR worker,
 * and serialises inference requests through it.
 */
export class WhisperServer {
  private proc: ChildProcess | null = null
  private url: string | null = null
  private starting: Promise<void> | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private busy = 0

  constructor(
    private readonly binary: string,
    private readonly modelPath: string,
    private readonly threads: number
  ) {}

  get isBusy(): boolean {
    return this.busy > 0
  }

  start(): Promise<void> {
    this.starting ??= this.boot()
    return this.starting
  }

  private async boot(): Promise<void> {
    if (!existsSync(this.modelPath)) throw new Error('The Whisper model is not downloaded yet. Download it in Settings → Transcription.')
    const port = await freePort()
    const proc = spawn(this.binary, ['-m', this.modelPath, '--host', '127.0.0.1', '--port', String(port), '--threads', String(this.threads), '--suppress-nst'], {
      stdio: 'ignore'
    })
    this.proc = proc
    let exitCode: number | null = null
    proc.on('exit', (code) => {
      exitCode = code ?? -1
      if (this.proc === proc) {
        this.proc = null
        this.url = null
        this.starting = null
      }
    })
    proc.on('error', () => (exitCode = -1))
    const base = `http://127.0.0.1:${port}`
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (exitCode !== null) throw new Error(`whisper-server exited (code ${exitCode}). Check the binary path and model.`)
      try {
        if ((await fetch(`${base}/`, { signal: AbortSignal.timeout(2_000) })).ok) {
          this.url = `${base}/inference`
          return
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    proc.kill('SIGKILL')
    throw new Error('whisper-server did not become ready in time.')
  }

  /** Transcribe mono float audio; requests run one at a time. */
  transcribe(audio: Float32Array, sampleRate: number, prompt?: string): Promise<string> {
    this.busy++
    const run = async (): Promise<string> => {
      try {
        await this.start()
        const form = new FormData()
        form.append('file', new Blob([new Uint8Array(encodeWav(audio, sampleRate))], { type: 'audio/wav' }), 'segment.wav')
        form.append('temperature', '0.0')
        form.append('response_format', 'json')
        if (prompt) form.append('prompt', prompt)
        const res = await fetch(this.url!, { method: 'POST', body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`whisper-server inference failed: HTTP ${res.status}`)
        const json = (await res.json()) as { text?: string }
        return cleanWhisperText(json.text ?? '')
      } finally {
        this.busy--
      }
    }
    const p = this.chain.then(run, run)
    this.chain = p.catch(() => undefined)
    return p
  }

  stop(): void {
    this.proc?.kill('SIGKILL')
    this.proc = null
    this.url = null
    this.starting = null
  }
}

/** Whisper emits markers like "[BLANK_AUDIO]" or "(music)" on silence; drop them. */
export function cleanWhisperText(text: string): string {
  return text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

class WhisperStream extends EventEmitter implements TranscriptionStream {
  private readonly segmenter: Segmenter
  private readonly stabilizers = new Map<number, PrefixStabilizer>()
  private readonly finalized = new Set<number>()
  private finals: Promise<void>[] = []
  private closed = false

  constructor(
    private readonly server: WhisperServer,
    private readonly opts: StreamOptions
  ) {
    super()
    this.segmenter = new Segmenter({ sampleRate: opts.sampleRate })
  }

  private get prompt(): string | undefined {
    return this.opts.keyterms.length ? this.opts.keyterms.slice(0, 40).join(', ') : undefined
  }

  write(pcm: Buffer): void {
    if (this.closed) return
    for (const ev of this.segmenter.push(pcm16ToFloat32(pcm))) this.handle(ev)
  }

  private handle(ev: SegmentEvent): void {
    const toMs = (s: number): number => Math.round((s / this.opts.sampleRate) * 1000)
    const key = `s${ev.id}`
    if (ev.type === 'partial') {
      // Skip partials while the server is behind; finals always run.
      if (this.server.isBusy) return
      this.server
        .transcribe(ev.audio, this.opts.sampleRate)
        .then((text) => {
          if (this.closed || this.finalized.has(ev.id)) return
          let stab = this.stabilizers.get(ev.id)
          if (!stab) this.stabilizers.set(ev.id, (stab = new PrefixStabilizer()))
          const committed = stab.advance(text.split(/\s+/).filter(Boolean)).join(' ')
          if (committed) this.emit('segment', { key, text: committed, startMs: toMs(ev.startSample), endMs: toMs(ev.endSample), isFinal: false })
        })
        .catch(() => undefined)
      return
    }
    this.finalized.add(ev.id) // late partials for this segment are ignored
    this.stabilizers.delete(ev.id)
    const p = this.server
      .transcribe(ev.audio, this.opts.sampleRate, this.prompt)
      .then((text) => {
        if (this.closed) return
        this.emit('segment', { key, text, startMs: toMs(ev.startSample), endMs: toMs(ev.endSample), isFinal: true })
      })
      .catch((e: Error) => {
        this.emit('error', e)
      })
    this.finals.push(p)
  }

  async finish(): Promise<void> {
    for (const ev of this.segmenter.flush()) this.handle(ev)
    await Promise.all(this.finals)
  }

  close(): void {
    this.closed = true
  }
}

export class WhisperEngine implements TranscriptionEngine {
  readonly id = 'whisper' as const
  private readonly server: WhisperServer

  constructor(binary: string, modelPath: string, threads: number) {
    this.server = new WhisperServer(binary, modelPath, threads)
  }

  async open(opts: StreamOptions): Promise<TranscriptionStream> {
    await this.server.start()
    return new WhisperStream(this.server, opts)
  }

  dispose(): void {
    this.server.stop()
  }
}
