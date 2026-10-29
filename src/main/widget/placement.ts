// Where the floating widget sits (docs/granola-ui.md §Nub). Like Granola's nub it starts flush with the right edge
// of the display, 70% of the way down; a dragged position is kept while that display is still attached, and size
// changes keep the top-right corner where it is (the page draws the pill in its top-right corner).

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

/** A saved widget position and the bounds of the display it was on. */
export interface SavedPosition {
  bounds: Rect
  display: Rect
}

/** Height of the collapsed pill, which the 70% line is measured against. */
const PILL_HEIGHT = 37

export function clampToArea(b: Rect, area: Rect): Rect {
  return {
    ...b,
    x: Math.max(area.x, Math.min(b.x, area.x + area.width - b.width)),
    y: Math.max(area.y, Math.min(b.y, area.y + area.height - b.height))
  }
}

export function defaultWidgetBounds(area: Rect, size: Size): Rect {
  return clampToArea({ x: area.x + area.width - size.width, y: area.y + Math.round((area.height - PILL_HEIGHT) * 0.7), ...size }, area)
}

/** Resize keeping the top-right corner, then pull the widget back inside `area` if it grew past an edge. */
export function anchorResize(prev: Rect, size: Size, area: Rect): Rect {
  return clampToArea({ x: prev.x + prev.width - size.width, y: prev.y, ...size }, area)
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** The saved position, if the display it was saved on is still attached with the same bounds. */
export function restoreBounds(saved: SavedPosition | null | undefined, displays: { bounds: Rect; workArea: Rect }[], size: Size): Rect | null {
  const display = saved && displays.find((d) => sameRect(d.bounds, saved.display))
  return display ? anchorResize(saved.bounds, size, display.workArea) : null
}

/** The size the page asked for, kept within sane limits. */
export function fitWidgetSize(size: Size): Size {
  return { width: Math.max(24, Math.min(400, Math.ceil(size.width))), height: Math.max(24, Math.min(500, Math.ceil(size.height))) }
}

export function isSavedPosition(v: unknown): v is SavedPosition {
  const rect = (r: unknown): boolean => !!r && typeof r === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((r as Record<string, unknown>)[k]))
  return !!v && typeof v === 'object' && rect((v as SavedPosition).bounds) && rect((v as SavedPosition).display)
}

/**
 * Page zoom that makes the XWayland widget as big as the app's own UI. When XWayland runs at native resolution
 * (GNOME 50), X11 clients scale themselves by a whole number (2 on a 167% display), so the page is zoomed by the
 * app's scale over the host's. With a host scale of 1 the compositor upscales X11 windows itself and no zoom is needed.
 */
export function hostZoom(appScale: number, hostScale: number): number {
  if (!(appScale > 0) || !(hostScale > 1)) return 1
  const zoom = appScale / hostScale
  if (!Number.isFinite(zoom) || Math.abs(zoom - 1) < 0.02) return 1
  return Math.min(2, Math.max(0.5, Math.round(zoom * 1000) / 1000))
}
