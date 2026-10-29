import { describe, expect, it } from 'vitest'
import { barOffset, levelNormaliser } from '@shared/barLevels'

// Room noise as measured on a laptop microphone through PipeWire: RMS 0.016–0.026, above Granola's fixed floor
// (200/32767), which used to read as full volume.
const hiss = (i: number): number => 0.016 + ((i * 7) % 11) / 1000

describe('dancing bar levels', () => {
  it('rests through room noise', () => {
    const norm = levelNormaliser()
    const levels = Array.from({ length: 60 }, (_, i) => norm(hiss(i)))
    expect(Math.max(...levels)).toBe(0)
    // At level 0 every bar sits at the same resting dot, so nothing moves.
    expect(barOffset(0, 2, 7)).toBe(8.5)
    expect(barOffset(0, 1, 7)).toBe(8.5)
  })

  it('moves for speech over the noise, and for any sound over digital silence', () => {
    const norm = levelNormaliser()
    for (let i = 0; i < 30; i++) norm(hiss(i))
    expect(norm(0.15)).toBeGreaterThan(0.9)
    expect(barOffset(1, 1, 10, () => 0.5)).toBe(0)

    // System audio is digitally silent between sounds: once past start-up, that silence is its noise floor.
    const system = levelNormaliser()
    for (let i = 0; i < 20; i++) system(0)
    expect(system(0.01)).toBeCloseTo(1)
  })

  it('rests while the capture starts up', () => {
    // What PipeWire delivers in the first 600 ms: zeros, then partial windows, then the room's hiss.
    const norm = levelNormaliser()
    const levels = [0, 0, 0.0001, 0.0052, ...Array.from({ length: 40 }, (_, i) => hiss(i))].map(norm)
    expect(Math.max(...levels)).toBe(0)
  })

  it('follows the room when it gets quieter or louder', () => {
    const norm = levelNormaliser()
    for (let i = 0; i < 40; i++) norm(0.05)
    // Quieter: the noise estimate drops at once, so the old noise level now counts as sound.
    norm(0.01)
    expect(norm(0.05)).toBeGreaterThan(0)
    // Louder: after a few seconds the new hiss is noise again.
    for (let i = 0; i < 30; i++) norm(0.04)
    expect(norm(0.04)).toBe(0)
  })
})
