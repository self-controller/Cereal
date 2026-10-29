// Level maths for the renderer's <DancingBars> (docs/granola-ui.md §Dancing bars), kept pure so tests can run it.
// Levels are RMS values, 0..1, every 100 ms.

const FLOOR = 200 / 32767
const DECAY = 0.27
/** How many recent levels the room's noise is taken from: 3 s, long enough to always span a pause in speech. */
const NOISE_WINDOW = 30
/** Sound has to be this many times louder than the noise to move the bars. */
const NOISE_MARGIN = 2
/** Levels in the first second, while a capture may still be starting (zeros, then partial windows), are skipped. */
const STARTUP = 10

/**
 * Turns RMS levels into bar heights (0..1). Like Granola's, it normalises against a fast-decaying peak so quiet and
 * loud speakers both move the bars. It first takes away the room's noise (the quietest level of the last 3 s): a
 * microphone whose hiss sits above Granola's fixed floor would otherwise read as full volume and keep the bars
 * dancing through silence, where Granola's rest until someone speaks.
 */
export function levelNormaliser(): (rms: number) => number {
  let peak = FLOOR
  let seen = 0
  const recent: number[] = []
  return (rms) => {
    // Start-up levels would pin the noise estimate near 0 for the next 3 s; the bars rest meanwhile.
    if (seen++ < STARTUP) return 0
    recent.push(rms)
    if (recent.length > NOISE_WINDOW) recent.shift()
    const signal = Math.max(0, rms - Math.min(...recent) * NOISE_MARGIN)
    peak = Math.max(FLOOR, peak * DECAY, signal)
    return signal / peak
  }
}

/**
 * How far a half-bar is pushed out of its box (0 = full height, 8.5 = a dot at rest). Outer bars (`weight` 2) move
 * half as much as the middle one.
 */
export function barOffset(level: number, weight: number, steps: number, random = Math.random): number {
  const r = (random() * 0.4 + 0.6) * weight
  return 10 - Math.min(Math.floor((steps * level) / r) + 1.5, steps)
}
