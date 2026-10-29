import { describe, expect, it } from 'vitest'
import { easeInExpo, foldAwayDuration } from '@shared/motion'

describe('enhanced-notes motion', () => {
  it('eases in exponentially from 0 to 1', () => {
    expect(easeInExpo(0)).toBe(0)
    expect(easeInExpo(1)).toBe(1)
    expect(easeInExpo(0.5)).toBeCloseTo(2 ** -5)
    expect(easeInExpo(0.9)).toBeGreaterThan(easeInExpo(0.5))
  })

  it('folds short notes away in 1.3 s and screen-tall notes in 3 s', () => {
    expect(foldAwayDuration(0, 900)).toBeCloseTo(1.3)
    expect(foldAwayDuration(450, 900)).toBeCloseTo(2.15)
    expect(foldAwayDuration(900, 900)).toBeCloseTo(3)
    expect(foldAwayDuration(5000, 900)).toBeCloseTo(3)
    expect(foldAwayDuration(300, 0)).toBeCloseTo(3)
  })
})
