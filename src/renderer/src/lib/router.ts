import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'note'; id: string }
  | { name: 'folder'; id: string }
  | { name: 'chat'; threadId?: string }
  | { name: 'assistant'; section: 'conversation' | 'task' | 'routines' | 'skills' | 'files'; taskId?: string }
  | { name: 'recipes' }
  | { name: 'templates'; slug?: string }
  | { name: 'settings'; section: SettingsSection }

export const SETTINGS_SECTIONS = ['general', 'profile', 'transcription', 'audio', 'ai', 'assistant', 'calendar', 'usage'] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export function parseRoute(hash: string): Route {
  const [, a, b, c] = hash.replace(/^#/, '').split('/')
  switch (a) {
    case 'assistant':
      if (b === 'task' && c) return { name: 'assistant', section: 'task', taskId: c }
      if (b === 'routines' || b === 'skills' || b === 'files') return { name: 'assistant', section: b }
      return { name: 'assistant', section: 'conversation' }
    case 'note':
      return b ? { name: 'note', id: b } : { name: 'home' }
    case 'folder':
      return b ? { name: 'folder', id: b } : { name: 'home' }
    case 'chat':
      return { name: 'chat', threadId: b }
    case 'recipes':
      return { name: 'recipes' }
    case 'templates':
      return { name: 'templates', slug: b }
    case 'settings':
      return { name: 'settings', section: (SETTINGS_SECTIONS as readonly string[]).includes(b) ? (b as SettingsSection) : 'general' }
    default:
      return { name: 'home' }
  }
}

export function navigate(path: string): void {
  const hash = path.startsWith('#') ? path : `#${path}`
  if (window.location.hash !== hash) window.location.hash = hash
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb)
  return () => window.removeEventListener('hashchange', cb)
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  return parseRoute(hash)
}
