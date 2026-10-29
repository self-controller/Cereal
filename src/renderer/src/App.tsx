import { useEffect, useState, type ReactNode } from 'react'
import { MotionConfig } from 'motion/react'
import { call, useEvent } from './lib/api'
import { navigate, useRoute } from './lib/router'
import { useApp } from './store'
import { Toaster, TooltipProvider } from './components/oats'
import { Toolbar, ToolbarFade, ToolbarProvider } from './components/shell/Toolbar'
import { Sidebar } from './components/shell/Sidebar'
import { useLayout, useUi, watchWindowWidth } from './components/shell/layout'
import { SearchPalette } from './components/SearchPalette'
import { TemplatesModal } from './components/TemplatesModal'
import { HomeView } from './views/HomeView'
import { NoteView } from './views/note/NoteView'
import { FolderView } from './views/FolderView'
import { ChatView } from './views/ChatView'
import { AssistantView } from './views/AssistantView'
import { RecipesView } from './views/RecipesView'
import { SettingsSidebar, SettingsView } from './views/settings/SettingsView'

/** Resolve the theme setting, mark <html>, and tell main so the window controls match. */
function useTheme(): 'light' | 'dark' {
  const theme = useApp((s) => s.settings?.theme ?? 'system')
  const [resolved, setResolved] = useState<'light' | 'dark'>('light')
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const next = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = next
      setResolved(next)
      void call('window:chrome', { dark: next === 'dark' }).catch(() => {})
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
  return resolved
}

export function App(): ReactNode {
  const route = useRoute()
  const app = useApp()
  const theme = useTheme()

  useEffect(() => {
    void app.loadSettings()
    void app.refreshDocuments()
    void app.refreshFolders()
    void app.refreshTemplates()
    void app.refreshUpcoming()
    void window.cereal.invoke('recording:state').then((s) => useApp.setState({ recording: s }))
    return watchWindowWidth()
  }, [])

  // Note pages close the sidebar; leaving one restores it.
  useEffect(() => useLayout.getState().setOnNote(route.name === 'note'), [route.name])

  // /templates opens the templates modal over Home.
  useEffect(() => {
    if (route.name !== 'templates') return
    useUi.getState().openTemplates({ slug: route.slug })
    navigate('/')
  }, [route])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'k') {
        e.preventDefault()
        useUi.getState().setSearch(!useUi.getState().searchOpen)
      } else if (mod && key === 'n') {
        e.preventDefault()
        void call('documents:create', {}).then((d) => navigate(`/note/${d.id}`))
      } else if (mod && e.key === ',') {
        e.preventDefault()
        navigate('/settings')
      } else if (mod && key === 's' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        useLayout.getState().toggle()
      } else if (e.key === 'Escape' && useLayout.getState().narrow && useLayout.getState().opened) {
        e.stopImmediatePropagation()
        useLayout.getState().close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEvent('recording:state', (s) => {
    useApp.setState({ recording: s })
    if (s.error && s.status === 'idle') app.showToast('error', s.error)
  })
  useEvent('audio:levels', (levels) => useApp.setState({ levels }))
  useEvent('transcript:chunks', ({ documentId, chunks }) => app.mergeChunks(documentId, chunks))
  useEvent('panel:updated', (p) => app.upsertPanel(p))
  useEvent('documents:changed', () => void app.refreshDocuments())
  useEvent('folders:changed', () => void app.refreshFolders())
  useEvent('calendar:changed', (events) => useApp.setState({ upcoming: events }))
  useEvent('settings:changed', (s) => app.setSettings(s))
  useEvent('navigate', ({ route }) => navigate(route))

  const settings = route.name === 'settings'

  return (
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <ToolbarProvider>
          <main className="relative flex h-screen w-screen flex-col overflow-hidden bg-surface text-[13px] text-ink-primary">
            <div className="relative flex min-h-0 w-full flex-1 flex-row">
              <Toolbar title={settings ? 'Settings' : undefined} />
              {route.name === 'settings' ? <SettingsSidebar section={route.section} /> : <Sidebar route={route} />}
              <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-surface transition-colors duration-300">
                <ToolbarFade />
                {(route.name === 'home' || route.name === 'templates') && <HomeView />}
                {route.name === 'note' && <NoteView key={route.id} id={route.id} />}
                {route.name === 'folder' && <FolderView key={route.id} id={route.id} />}
                {route.name === 'chat' && <ChatView key={route.threadId ?? 'new'} threadId={route.threadId} />}
                {route.name === 'assistant' && <AssistantView section={route.section} taskId={route.taskId} />}
                {route.name === 'recipes' && <RecipesView />}
                {route.name === 'settings' && <SettingsView section={route.section} />}
              </div>
            </div>
          </main>
          <SearchPalette />
          <TemplatesModal />
          <Toaster theme={theme} />
        </ToolbarProvider>
      </TooltipProvider>
    </MotionConfig>
  )
}
