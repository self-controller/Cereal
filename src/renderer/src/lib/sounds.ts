// Short synthesized cues for start/stop (Granola plays sounds here too; these are generated, not sampled).
let ctx: AudioContext | null = null

function play(notes: { freq: number; at: number; dur: number }[], volume = 0.08): void {
  try {
    ctx ??= new AudioContext()
    const now = ctx.currentTime
    for (const n of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = n.freq
      gain.gain.setValueAtTime(0, now + n.at)
      gain.gain.linearRampToValueAtTime(volume, now + n.at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(now + n.at)
      osc.stop(now + n.at + n.dur + 0.05)
    }
  } catch {
    // Audio output unavailable; cues are optional.
  }
}

export const sounds = {
  start: (): void => play([
    { freq: 660, at: 0, dur: 0.18 },
    { freq: 880, at: 0.12, dur: 0.25 }
  ]),
  stop: (): void => play([
    { freq: 880, at: 0, dur: 0.18 },
    { freq: 587, at: 0.12, dur: 0.3 }
  ])
}
