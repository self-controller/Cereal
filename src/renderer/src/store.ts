import { create } from 'zustand'
import { toast } from 'sonner'
import { call } from './lib/api'
import { mergeTranscriptChunks } from '@shared/transcript'
import type { CalendarEvent, DocumentSummary, Folder, Panel, RecordingState, Settings, Template, TranscriptChunk } from '@shared/types'

interface AppState {
  documents: DocumentSummary[]
  folders: Folder[]
  templates: Template[]
  upcoming: CalendarEvent[]
  settings: Settings | null
  recording: RecordingState
  levels: { microphone: number; system: number }
  transcripts: Record<string, TranscriptChunk[]>
  panels: Record<string, Panel[]>

  refreshDocuments(): Promise<void>
  refreshFolders(): Promise<void>
  refreshTemplates(): Promise<void>
  refreshUpcoming(): Promise<void>
  loadSettings(): Promise<void>
  setSettings(s: Settings): void
  loadTranscript(documentId: string): Promise<void>
  mergeChunks(documentId: string, chunks: TranscriptChunk[]): void
  loadPanels(documentId: string): Promise<void>
  upsertPanel(panel: Panel): void
  removePanel(documentId: string, panelId: string): void
  showToast(kind: 'error' | 'info', text: string): void
}

export const useApp = create<AppState>((set, get) => ({
  documents: [],
  folders: [],
  templates: [],
  upcoming: [],
  settings: null,
  recording: { status: 'idle', document_id: null, started_at: null, engine: null, sources: [], error: null, warnings: [] },
  levels: { microphone: 0, system: 0 },
  transcripts: {},
  panels: {},

  async refreshDocuments() {
    set({ documents: await call('documents:list') })
  },
  async refreshFolders() {
    set({ folders: await call('folders:list') })
  },
  async refreshTemplates() {
    set({ templates: await call('templates:list') })
  },
  async refreshUpcoming() {
    set({ upcoming: await call('calendar:upcoming') })
  },
  async loadSettings() {
    set({ settings: await call('settings:get') })
  },
  setSettings(settings) {
    set({ settings })
  },
  async loadTranscript(documentId) {
    const chunks = await call('transcript:get', documentId)
    // Keep any live interim chunks that arrived before the load finished.
    set((s) => ({ transcripts: { ...s.transcripts, [documentId]: mergeTranscriptChunks(chunks, (s.transcripts[documentId] ?? []).filter((c) => !c.is_final)) } }))
  },
  mergeChunks(documentId, chunks) {
    set((s) => ({ transcripts: { ...s.transcripts, [documentId]: mergeTranscriptChunks(s.transcripts[documentId] ?? [], chunks) } }))
  },
  async loadPanels(documentId) {
    const panels = await call('panels:list', documentId)
    set((s) => ({ panels: { ...s.panels, [documentId]: panels } }))
  },
  upsertPanel(panel) {
    const list = get().panels[panel.document_id] ?? []
    const next = list.some((p) => p.id === panel.id) ? list.map((p) => (p.id === panel.id ? panel : p)) : [...list, panel]
    set((s) => ({ panels: { ...s.panels, [panel.document_id]: next } }))
  },
  removePanel(documentId, panelId) {
    set((s) => ({ panels: { ...s.panels, [documentId]: (s.panels[documentId] ?? []).filter((p) => p.id !== panelId) } }))
  },
  showToast(kind, text) {
    if (kind === 'error') toast.error(text, { duration: 7000 })
    else toast(text, { duration: 3500 })
  }
}))
