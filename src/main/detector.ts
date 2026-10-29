import { activeMeetingApps } from './audio/pipewire'

const POLL_MS = 3_000
const END_GRACE_MS = 20_000

/**
 * Watches PipeWire for meeting apps capturing the microphone (Granola uses a native mic-activity
 * tracker for this). Fires `onStart(app)` when a meeting app starts using the mic and
 * `onEnd()` once no meeting app has used it for END_GRACE_MS.
 */
export class MeetingDetector {
  private timer: NodeJS.Timeout | null = null
  private active = new Set<string>()
  private goneSince: number | null = null

  constructor(
    private readonly onStart: (app: string) => void,
    private readonly onEnd: () => void,
    private readonly poll: () => Promise<string[]> = activeMeetingApps
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), POLL_MS)
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.active.clear()
    this.goneSince = null
  }

  get meetingActive(): boolean {
    return this.active.size > 0
  }

  async tick(now = Date.now()): Promise<void> {
    const apps = new Set(await this.poll())
    const wasActive = this.active.size > 0
    if (!wasActive && apps.size > 0) this.onStart([...apps][0])
    if (apps.size > 0) {
      this.goneSince = null
      this.active = apps
      return
    }
    if (wasActive) {
      this.goneSince ??= now
      if (now - this.goneSince >= END_GRACE_MS) {
        this.active.clear()
        this.goneSince = null
        this.onEnd()
      }
    }
  }
}
