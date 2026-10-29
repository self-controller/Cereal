import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { AudioDevice, TranscriptSource } from '@shared/types'

export const SAMPLE_RATE = 16_000
/** Tag on our own capture streams so meeting detection can ignore them. */
export const CAPTURE_APP_NAME = 'cereal-capture'

export interface CaptureOptions {
  source: TranscriptSource
  /** PipeWire node name; null = default source (mic) or default sink monitor (system). */
  target: string | null
}

/**
 * One PipeWire capture stream (PCM16 LE mono 16 kHz) via `pw-record --raw`.
 * The system stream records the sink monitor (`stream.capture.sink=true`), which is how
 * Cereal hears the other side of a call, analogous to Granola's Windows render loopback.
 *
 * Events: 'data' (Buffer), 'level' (rms 0..1 every 100 ms), 'error' (Error), 'stopped'.
 */
export class PipeWireCapture extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null
  private running = false
  private restarts = 0
  private carry: Buffer | null = null
  private sumSquares = 0
  private sampleCount = 0
  private readonly samplesPerLevel = SAMPLE_RATE / 10

  constructor(readonly opts: CaptureOptions) {
    super()
  }

  start(): void {
    this.running = true
    this.spawnRecorder()
  }

  stop(): void {
    this.running = false
    this.proc?.kill('SIGTERM')
    this.proc = null
  }

  private spawnRecorder(): void {
    const props = [`application.name="${CAPTURE_APP_NAME}"`, `node.description="Cereal ${this.opts.source}"`]
    if (this.opts.source === 'system') props.push('stream.capture.sink=true')
    const args = ['--raw', '--format', 's16', '--rate', String(SAMPLE_RATE), '--channels', '1', '--latency', '50ms', '-P', `{ ${props.join(' ')} }`]
    if (this.opts.target) args.push('--target', this.opts.target)
    args.push('-')

    const proc = spawn('pw-record', args, { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as ChildProcessWithoutNullStreams
    this.proc = proc
    let stderr = ''
    proc.stdout.on('data', (buf: Buffer) => this.onData(buf))
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)))
    proc.on('error', (err) => {
      this.running = false
      this.emit('error', new Error(`Could not start pw-record (${err.message}). Install pipewire-utils.`))
    })
    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      if (!this.running) return this.emit('stopped')
      // The device went away or the server restarted: retry a few times, like Granola's render-follow reopen.
      if (this.restarts++ < 5) {
        setTimeout(() => this.running && this.spawnRecorder(), 500 * this.restarts)
      } else {
        this.running = false
        this.emit('error', new Error(`pw-record exited (${code}): ${stderr.trim() || 'no output'}`))
      }
    })
  }

  private onData(buf: Buffer): void {
    // Keep sample alignment across reads.
    let data = this.carry ? Buffer.concat([this.carry, buf]) : buf
    this.carry = null
    if (data.length % 2 === 1) {
      this.carry = data.subarray(data.length - 1)
      data = data.subarray(0, data.length - 1)
    }
    if (data.length === 0) return
    this.restarts = 0
    for (let i = 0; i < data.length; i += 2) {
      const s = data.readInt16LE(i) / 32768
      this.sumSquares += s * s
      if (++this.sampleCount === this.samplesPerLevel) {
        this.emit('level', Math.sqrt(this.sumSquares / this.sampleCount))
        this.sumSquares = 0
        this.sampleCount = 0
      }
    }
    this.emit('data', data)
  }
}

export function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => execFile('which', [cmd], (err) => resolve(!err)))
}

interface PwNode {
  type?: string
  info?: { props?: Record<string, unknown> }
}

/** `pw-dump` as parsed JSON (empty array if unavailable). */
export function pwDump(): Promise<PwNode[]> {
  return new Promise((resolve) => {
    execFile('pw-dump', { maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve([])
      try {
        resolve(JSON.parse(stdout) as PwNode[])
      } catch {
        resolve([])
      }
    })
  })
}

function defaultNodeName(dump: PwNode[], key: 'default.audio.source' | 'default.audio.sink'): string | null {
  for (const obj of dump) {
    if (obj.type !== 'PipeWire:Interface:Metadata') continue
    const metadata = (obj as { metadata?: { key: string; value: { name?: string } }[] }).metadata ?? []
    const entry = metadata.find((m) => m.key === key)
    if (entry?.value?.name) return entry.value.name
  }
  return null
}

export async function listAudioDevices(): Promise<AudioDevice[]> {
  const dump = await pwDump()
  const defSource = defaultNodeName(dump, 'default.audio.source')
  const defSink = defaultNodeName(dump, 'default.audio.sink')
  const out: AudioDevice[] = []
  for (const node of dump) {
    if (node.type !== 'PipeWire:Interface:Node') continue
    const p = node.info?.props ?? {}
    const cls = String(p['media.class'] ?? '')
    const name = String(p['node.name'] ?? '')
    const description = String(p['node.description'] ?? p['node.nick'] ?? name)
    if (cls === 'Audio/Source' || cls === 'Audio/Source/Virtual') out.push({ name, description, kind: 'source', isDefault: name === defSource })
    if (cls === 'Audio/Sink') out.push({ name, description, kind: 'sink', isDefault: name === defSink })
  }
  return out
}

/** Applications that look like meeting clients, matched against PipeWire capture streams. */
const MEETING_APPS: [RegExp, string][] = [
  [/zoom/i, 'Zoom'],
  [/teams/i, 'Microsoft Teams'],
  [/slack/i, 'Slack'],
  [/discord/i, 'Discord'],
  [/webex/i, 'Webex'],
  [/skype/i, 'Skype'],
  [/chrom(e|ium)|brave|vivaldi|edge/i, 'Browser call'],
  [/firefox|zen|librewolf|floorp/i, 'Browser call']
]

/** Names of meeting apps currently capturing the microphone (Linux analogue of Granola's mic activity tracker). */
export async function activeMeetingApps(): Promise<string[]> {
  const dump = await pwDump()
  const apps = new Set<string>()
  for (const node of dump) {
    if (node.type !== 'PipeWire:Interface:Node') continue
    const p = node.info?.props ?? {}
    if (p['media.class'] !== 'Stream/Input/Audio') continue
    if (p['stream.capture.sink'] === true || p['stream.capture.sink'] === 'true') continue
    const appName = String(p['application.name'] ?? '')
    if (appName === CAPTURE_APP_NAME) continue
    const haystack = `${appName} ${p['application.process.binary'] ?? ''}`
    const match = MEETING_APPS.find(([re]) => re.test(haystack))
    if (match) apps.add(match[1])
  }
  return [...apps]
}
