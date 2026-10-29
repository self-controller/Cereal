import { create } from 'zustand'

// Sidebar and toolbar state, after Granola's listsSidebarPreferences (docs/granola-ui.md §Sidebar):
// - the user's open/closed choice is remembered; note pages close the sidebar and leaving one restores it;
// - below 768px the sidebar becomes a floating overlay that starts closed;
// - only a manual toggle animates the width; automatic changes snap.

export const SIDEBAR_MIN = 192
export const SIDEBAR_MAX = 330
const NARROW = 768
const STORAGE_KEY = 'cereal.sidebar'

interface Stored {
  width: number
  open: boolean
}

function load(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Stored>
    return { width: clamp(v.width ?? SIDEBAR_MIN), open: v.open ?? true }
  } catch {
    return { width: SIDEBAR_MIN, open: true }
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function save(s: Stored): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
    } catch {
      // Storage can be unavailable; the sidebar just won't remember.
    }
  }, 300)
}

function clamp(w: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.round(w)))
}

interface LayoutState {
  /** Whether the sidebar is showing right now. */
  opened: boolean
  /** The user's own choice, restored when leaving a note or a narrow window. */
  preferred: boolean
  /** Set by a manual toggle; only then does the width animate. */
  animate: boolean
  width: number
  resizing: boolean
  narrow: boolean
  onNote: boolean
  toggle(): void
  close(): void
  setWidth(w: number): void
  setResizing(r: boolean): void
  setNarrow(n: boolean): void
  setOnNote(n: boolean): void
}

const initial = load()

export const useLayout = create<LayoutState>((set, get) => ({
  opened: initial.open && window.innerWidth >= NARROW,
  preferred: initial.open,
  animate: false,
  width: initial.width,
  resizing: false,
  narrow: window.innerWidth < NARROW,
  onNote: false,

  toggle() {
    const { opened, narrow, width } = get()
    if (narrow) return set({ opened: !opened, animate: true })
    set({ opened: !opened, preferred: !opened, animate: true })
    save({ width, open: !opened })
  },
  close() {
    set({ opened: false, animate: true })
  },
  setWidth(w) {
    const width = clamp(w)
    set({ width })
    save({ width, open: get().preferred })
  },
  setResizing(resizing) {
    set({ resizing })
  },
  setNarrow(narrow) {
    if (narrow === get().narrow) return
    const { preferred, onNote } = get()
    set({ narrow, opened: narrow ? false : preferred && !onNote, animate: false })
  },
  setOnNote(onNote) {
    if (onNote === get().onNote) return
    const { preferred, narrow } = get()
    set({ onNote, opened: narrow ? false : !onNote && preferred, animate: false })
  }
}))

export function watchWindowWidth(): () => void {
  const onResize = (): void => useLayout.getState().setNarrow(window.innerWidth < NARROW)
  window.addEventListener('resize', onResize)
  return () => window.removeEventListener('resize', onResize)
}

/** App-wide overlays that any view can open. */
interface UiState {
  searchOpen: boolean
  templates: { open: boolean; slug?: string; onApply?: (slug: string) => void }
  setSearch(open: boolean): void
  openTemplates(opts?: { slug?: string; onApply?: (slug: string) => void }): void
  closeTemplates(): void
}

export const useUi = create<UiState>((set) => ({
  searchOpen: false,
  templates: { open: false },
  setSearch(searchOpen) {
    set({ searchOpen })
  },
  openTemplates(opts) {
    set({ templates: { open: true, ...opts } })
  },
  closeTemplates() {
    set((s) => ({ templates: { ...s.templates, open: false } }))
  }
}))
