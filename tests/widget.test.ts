import { describe, expect, it } from 'vitest'
import { anchorResize, clampToArea, defaultWidgetBounds, fitWidgetSize, hostZoom, isSavedPosition, restoreBounds } from '../src/main/widget/placement'

const display = { x: 0, y: 0, width: 1536, height: 960 }
const workArea = { x: 0, y: 32, width: 1536, height: 928 }

describe('widget placement (Granola nub rules)', () => {
  it('starts flush with the right edge, 70% of the way down', () => {
    expect(defaultWidgetBounds(workArea, { width: 50, height: 90 })).toEqual({ x: 1486, y: 32 + Math.round((928 - 37) * 0.7), width: 50, height: 90 })
  })

  it('keeps the top-right corner when the widget grows, and stays on screen', () => {
    const pill = { x: 1486, y: 600, width: 50, height: 90 }
    expect(anchorResize(pill, { width: 136, height: 140 }, workArea)).toEqual({ x: 1400, y: 600, width: 136, height: 140 })
    expect(anchorResize({ ...pill, y: 900 }, { width: 136, height: 140 }, workArea).y).toBe(32 + 928 - 140)
    expect(clampToArea({ x: -40, y: 0, width: 50, height: 50 }, workArea)).toEqual({ x: 0, y: 32, width: 50, height: 50 })
  })

  it('restores a dragged position only while its display is attached', () => {
    const saved = { bounds: { x: 200, y: 300, width: 50, height: 90 }, display }
    expect(restoreBounds(saved, [{ bounds: display, workArea }], { width: 50, height: 90 })).toEqual(saved.bounds)
    expect(restoreBounds(saved, [{ bounds: { ...display, width: 1920 }, workArea }], { width: 50, height: 90 })).toBeNull()
    expect(restoreBounds(null, [{ bounds: display, workArea }], { width: 50, height: 90 })).toBeNull()
  })

  it('validates saved positions and limits page-reported sizes', () => {
    expect(isSavedPosition({ bounds: { x: 1, y: 2, width: 3, height: 4 }, display })).toBe(true)
    expect(isSavedPosition({ bounds: { x: 1, y: 2 }, display })).toBe(false)
    expect(fitWidgetSize({ width: 10.2, height: 9000 })).toEqual({ width: 24, height: 500 })
  })

  it('zooms the XWayland widget to the app\'s display scale', () => {
    // Native-resolution XWayland on a 167% display: the host renders at scale 2 and is zoomed down to match.
    expect(hostZoom(1.6666666, 2)).toBe(0.833)
    expect(hostZoom(2, 2)).toBe(1)
    // The compositor upscales X11 windows itself: no zoom.
    expect(hostZoom(1.6666666, 1)).toBe(1)
    expect(hostZoom(NaN, 2)).toBe(1)
  })
})
