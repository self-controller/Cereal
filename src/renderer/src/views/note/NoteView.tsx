import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Copy, MoreHorizontal, NotebookPen, Share, Sparkles, Trash2 } from 'lucide-react'
import { formatTranscript } from '@shared/transcript'
import { resolveSpeakers } from '@shared/speakers'
import { AUTO_TEMPLATE_SLUG, defaultTemplateFor } from '@shared/defaults'
import { call, errorMessage, useEvent } from '../../lib/api'
import { navigate } from '../../lib/router'
import { sounds } from '../../lib/sounds'
import { applyNoteEdit } from '../../lib/noteEdits'
import { useApp } from '../../store'
import { Notepad, type NotepadChange } from '../../components/Notepad'
import { FloatingChatPanel, useChatSession, useChatShortcuts, type FloatingState } from '../../components/FloatingChat'
import type { ComposerSend } from '../../components/chat/Composer'
import type { OutputActions } from '../../components/AgentOutputs'
import { ChromeItem, ConfirmDialog, IconButton, Menu, MenuItem, MenuSeparator, MorphButton, SegmentedTabs, cn, type SegmentedTab } from '../../components/oats'
import { ToolbarContent } from '../../components/shell/Toolbar'
import { RecordingWidget } from './RecordingWidget'
import { TranscriptPanel } from './TranscriptPanel'
import type { TranscriptFocus } from './TranscriptView'
import { EnhancedView, EnhancedMenu } from './EnhancedView'
import type { EnhancedEditorHandle } from './EnhancedEditor'
import { MetaChips } from './MetaChips'
import { SpeakersProvider } from './SpeakersChip'
import type { Editor } from '@tiptap/react'
import type { ChatMessage, CerealDocument } from '@shared/types'
import type { ToolCallOutput } from '@shared/agent'

// The transcript isn't a tab: it opens from the recording widget, in the chat bar (docs/granola-ui.md §Note).
type Tab = 'notes' | 'enhanced'
const NONE: never[] = []

export function NoteView({ id }: { id: string }): ReactNode {
  const [doc, setDoc] = useState<CerealDocument | null>(null)
  const [missing, setMissing] = useState(false)
  const [title, setTitle] = useState('')
  const [tab, setTab] = useState<Tab>('notes')
  const [panelId, setPanelId] = useState<string | null>(null)
  const [chatState, setChatState] = useState<FloatingState>('idle')
  /** Where the transcript should scroll to when a Transcript Summary quote opens it. */
  const [transcriptFocus, setTranscriptFocus] = useState<TranscriptFocus | null>(null)
  const enhancedEditor = useRef<EnhancedEditorHandle>(null)
  /** Text selected in My notes, offered to the chat as context until it's sent or dismissed. */
  const [selectedText, setSelectedText] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'note' | 'transcript' | null>(null)
  const recording = useApp((s) => s.recording)
  const chunks = useApp((s) => s.transcripts[id]) ?? NONE
  const notePanels = useApp((s) => s.panels[id]) ?? NONE
  const templates = useApp((s) => s.templates)
  const settings = useApp((s) => s.settings)
  const { loadTranscript, loadPanels, upsertPanel, removePanel, showToast } = useApp.getState()
  const isRecordingHere = recording.document_id === id && recording.status === 'recording'
  const isStartingHere = recording.document_id === id && recording.status === 'starting'
  const pending = useRef<Partial<NotepadChange & { title: string }>>({})
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const chat = useChatSession(id)
  const chatMessages = chat.messages
  const editorRef = useRef<Editor | null>(null)
  const [editorReady, setEditorReady] = useState(0)
  const handledTools = useRef(new Set<string>())

  // ------------------------------------------------------------- loading

  useEffect(() => {
    let live = true
    setDoc(null)
    setMissing(false)
    setChatState('idle')
    setTranscriptFocus(null)
    setSelectedText(null)
    void call('documents:get', id).then((d) => {
      if (!live) return
      if (!d) return setMissing(true)
      setDoc(d)
      setTitle(d.title)
    })
    void loadTranscript(id)
    void loadPanels(id).then(() => {
      const list = useApp.getState().panels[id] ?? []
      if (!live) return
      setPanelId(list[list.length - 1]?.id ?? null)
      setTab(list.length ? 'enhanced' : 'notes')
    })
    return () => {
      live = false
    }
  }, [id, loadTranscript, loadPanels])

  useEvent('documents:changed', (e) => {
    if (e.id === id)
      void call('documents:get', id).then((d) => {
        if (!d) return
        setDoc(d)
        if (!pending.current.title) setTitle(d.title)
      })
  })

  // --------------------------------------------------------------- saving

  const flush = useCallback(async () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    const patch = pending.current
    pending.current = {}
    if (Object.keys(patch).length === 0) return
    try {
      const updated = await call('documents:update', id, patch)
      setDoc((d) => (d ? { ...d, ...updated, notes: d.notes } : updated))
    } catch (e) {
      showToast('error', `Could not save: ${errorMessage(e)}`)
    }
  }, [id, showToast])

  const queueSave = useCallback(
    (patch: Partial<NotepadChange & { title: string }>) => {
      pending.current = { ...pending.current, ...patch }
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => void flush(), 500)
    },
    [flush]
  )

  useEffect(() => () => void flush(), [flush])

  // ------------------------------------------------------------ recording

  const start = async (): Promise<void> => {
    await flush()
    try {
      await call('recording:start', id)
      if (settings?.audio.playSounds) sounds.start()
    } catch (e) {
      showToast('error', errorMessage(e))
    }
  }

  const stop = async (): Promise<void> => {
    try {
      await call('recording:stop')
      if (settings?.audio.playSounds) sounds.stop()
    } catch (e) {
      showToast('error', errorMessage(e))
    }
  }

  const enhance = async (slug?: string | null): Promise<void> => {
    enhancedEditor.current?.flush()
    await flush()
    try {
      const panel = await call('panels:enhance', id, slug ?? null)
      upsertPanel(panel)
      setPanelId(panel.id)
      setTab('enhanced')
    } catch (e) {
      showToast('error', errorMessage(e))
    }
  }

  const sendChat = async (req: ComposerSend): Promise<void> => {
    await flush()
    setChatState('chat')
    await chat.send(req)
  }

  // Ctrl+J opens the chat; again (in a live meeting) it shows the transcript; again it closes.
  useChatShortcuts({
    onToggle: () => setChatState((s) => (s === 'idle' ? 'chat' : s === 'chat' && recording.document_id === id && recording.status === 'recording' ? 'transcript' : 'idle')),
    onNewChat: chat.newChat
  })

  // Selecting text in My notes offers it to the chat ("Chat with selected text").
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const onSelection = (): void => {
      if (!editor.isFocused) return
      const { from, to, empty } = editor.state.selection
      setSelectedText(empty ? null : editor.state.doc.textBetween(from, to, '\n').trim().slice(0, 4000) || null)
    }
    editor.on('selectionUpdate', onSelection)
    return () => {
      editor.off('selectionUpdate', onSelection)
    }
  }, [editorReady])

  // ----------------------------------------------------------- agent edits

  // The chat's editMeetingNotes calls are applied here, in the editor (switching to My notes first), and reported
  // back so the card can offer Undo. rewriteMeetingNotes opens the new tab once.
  useEffect(() => {
    for (const m of chatMessages) {
      for (const o of m.outputs) {
        if (o.type !== 'tool_call' || !o.completed || o.error || handledTools.current.has(o.id)) continue
        if (o.name === 'rewriteMeetingNotes') {
          handledTools.current.add(o.id)
          const newPanel = (o.result as { newPanelId?: string } | undefined)?.newPanelId
          if (newPanel && m.status === 'in_progress') {
            setPanelId(newPanel)
            setTab('enhanced')
          }
          continue
        }
        if (o.name !== 'editMeetingNotes' || o.applied !== null) continue
        // Edits from a chat that ended long ago aren't applied out of the blue.
        if (Date.now() - Date.parse(m.created_at) > 15 * 60_000) {
          handledTools.current.add(o.id)
          void call('chat:tool-applied', m.id, o.id, { applied: false })
          continue
        }
        if (tab !== 'notes') {
          setTab('notes')
          return
        }
        const editor = editorRef.current
        if (!editor) return
        handledTools.current.add(o.id)
        const args = o.args as { textToReplace: string; newText: string }
        const ok = applyNoteEdit(editor, args.textToReplace, args.newText)
        if (!ok) showToast('error', "Couldn't apply an edit from chat: that part of your notes changed.")
        void call('chat:tool-applied', m.id, o.id, { applied: ok })
      }
    }
  }, [chatMessages, tab, editorReady, showToast])

  const revertEdit = useCallback(
    (message: ChatMessage, o: ToolCallOutput, undo: boolean) => {
      const editor = editorRef.current
      const args = o.args as { textToReplace: string; newText: string }
      if (!editor) {
        setTab('notes')
        showToast('info', 'Open My notes, then try again.')
        return
      }
      const ok = undo ? applyNoteEdit(editor, args.newText, args.textToReplace) : applyNoteEdit(editor, args.textToReplace, args.newText)
      if (!ok) return showToast('error', `Can't ${undo ? 'undo' : 'reapply'} this edit: the notes have changed since.`)
      void call('chat:tool-applied', message.id, o.id, { reverted: undo })
    },
    [showToast]
  )

  if (missing)
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-secondary">
        This note was deleted.
        <button type="button" className="ml-1 cursor-default underline" onClick={() => navigate('/')}>
          Go home
        </button>
      </div>
    )
  if (!doc) return <div className="h-full" />

  const activePanel = notePanels.find((p) => p.id === panelId) ?? notePanels[notePanels.length - 1] ?? null
  const hasTranscript = chunks.length > 0
  const kind = doc.mode === 'lecture' ? 'lecture' : 'meeting'
  const selectedSlug = doc.selected_template ?? defaultTemplateFor(doc.mode, settings) ?? AUTO_TEMPLATE_SLUG
  const generating = notePanels.some((p) => !p.generation_finished_at && !p.generation_failed_at)
  const canGenerate = !isRecordingHere && !isStartingHere && !generating && notePanels.length === 0 && Boolean(hasTranscript || doc.notes_plain.trim())
  const enhanceLabel = (doc.notes_plain?.length ?? 0) > 20 ? 'Enhance notes' : 'Generate notes'
  const visibleTab: Tab = tab === 'enhanced' && !activePanel ? 'notes' : tab

  const tabs: SegmentedTab<Tab>[] = [
    { value: 'notes', label: 'My notes', icon: <NotebookPen size={16} /> },
    ...(activePanel ? [{ value: 'enhanced' as Tab, label: activePanel.title.length > 20 ? `${activePanel.title.slice(0, 19)}…` : activePanel.title, icon: <Sparkles size={16} />, tooltip: 'Enhanced notes', chevron: true }] : [])
  ]
  const enhancedMarkdown = (): string => (activePanel ? (enhancedEditor.current?.markdown() ?? activePanel.content) : '')
  const openQuote = (chunkId: string): void => {
    setTranscriptFocus({ chunkId, nonce: Date.now() })
    setChatState('transcript')
  }

  const actions: OutputActions = {
    onRevertEdit: (o, undo) => {
      const message = chatMessages.find((m) => m.outputs.some((x) => x.type === 'tool_call' && x.id === o.id))
      if (message) revertEdit(message, o, undo)
    }
  }

  const copyMarkdown = (): void => {
    const md = `# ${doc.title || 'Untitled'}\n\n${visibleTab === 'enhanced' && activePanel ? enhancedMarkdown() : doc.notes_markdown}`
    void navigator.clipboard.writeText(md)
    showToast('info', 'Copied as Markdown')
  }

  return (
    <SpeakersProvider doc={doc} chunks={chunks} onChange={setDoc} onJump={openQuote}>
      <div className="@container/view relative flex h-full min-w-0">
        <ToolbarContent>
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-ink-secondary">
            <button type="button" onClick={() => navigate('/')} className="no-drag shrink-0 cursor-default rounded-md px-1 py-0.5 hover:text-ink-primary">
              My notes
            </button>
            <span className="text-ink-tertiary">/</span>
            <span className={cn('min-w-0 truncate text-ink-primary transition-opacity duration-200', scrolled ? 'opacity-100' : 'opacity-0')}>{title || 'New note'}</span>
          </div>
          <div className="no-drag ml-auto flex shrink-0 items-center gap-1.5">
            <Menu
              align="end"
              trigger={
                <IconButton label="Share" data-testid="share-button">
                  <Share size={16} />
                </IconButton>
              }
            >
              <MenuItem onClick={copyMarkdown}>
                <Copy size={16} /> Copy as Markdown
              </MenuItem>
              <MenuItem
                disabled={!hasTranscript}
                onClick={() => {
                  const speakers = resolveSpeakers(chunks, { mode: doc.mode, people: doc.people, assignments: doc.speakers, profile: settings?.profile ?? {} })
                  void navigator.clipboard.writeText(formatTranscript(chunks, { speakers }))
                  showToast('info', 'Transcript copied')
                }}
              >
                <Copy size={16} /> Copy transcript
              </MenuItem>
            </Menu>
            <Menu
              align="end"
              trigger={
                <IconButton label="More">
                  <MoreHorizontal size={16} />
                </IconButton>
              }
            >
              <MenuItem disabled={!hasTranscript || isRecordingHere} onClick={() => setConfirm('transcript')}>
                <Trash2 size={16} /> Delete transcript
              </MenuItem>
              <MenuSeparator />
              <MenuItem danger onClick={() => setConfirm('note')}>
                <Trash2 size={16} /> Delete note
              </MenuItem>
            </Menu>
          </div>
        </ToolbarContent>

        <main className="relative flex h-full min-w-[300px] flex-1 flex-col overflow-x-hidden pt-11">
          <ChromeItem zone="top" entrance="fade" show={isRecordingHere && recording.warnings.length > 0}>
            <div className="mx-auto w-full max-w-2xl px-7 pt-2">
              <div className="rounded-xl bg-surface-sunken px-4 py-3 text-sm text-ink-secondary ring ring-hairline">{recording.warnings.join(' · ')}</div>
            </div>
          </ChromeItem>

          <div
            ref={scroller}
            data-testid="note-scroller"
            onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 40)}
            className="@container-[size] relative min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          >
            {scrolled && <div className="pointer-events-none sticky top-0 z-10 -mb-12 h-12 bg-linear-to-b from-surface to-transparent" />}
            <div className="flex px-4 pt-3">
              <div className="mx-auto w-full max-w-2xl px-1">
                <TitleInput
                  value={title}
                  placeholder={doc.calendar_event?.title ?? 'New note'}
                  onChange={(v) => {
                    setTitle(v)
                    queueSave({ title: v })
                  }}
                  onEnter={() => editorRef.current?.commands.focus('start')}
                />
                <div role="group" aria-label="Note options" data-testid="note-options" className="scrollbar-hide mt-2 flex min-w-0 flex-nowrap items-start gap-2 overflow-x-auto px-1 py-1 text-sm text-ink-secondary">
                  {activePanel && (
                    <div className="shrink-0">
                      <SegmentedTabs
                        tabs={tabs}
                        value={visibleTab}
                        onChange={setTab}
                        wrapActive={(value, button) =>
                          value === 'enhanced' ? (
                            <EnhancedMenu
                              trigger={button}
                              panels={notePanels}
                              panel={activePanel}
                              templates={templates}
                              onSelect={setPanelId}
                              onRegenerate={(slug) => void enhance(slug)}
                              onFlush={() => enhancedEditor.current?.flush()}
                              content={enhancedMarkdown}
                              onDeleted={() => {
                                removePanel(id, activePanel.id)
                                const rest = notePanels.filter((p) => p.id !== activePanel.id)
                                setPanelId(rest[rest.length - 1]?.id ?? null)
                                if (!rest.length) setTab('notes')
                              }}
                            />
                          ) : (
                            button
                          )
                        }
                      />
                    </div>
                  )}
                  <MetaChips doc={doc} onChange={setDoc} recording={isRecordingHere} selectedSlug={selectedSlug} />
                </div>
              </div>
            </div>
            <div className="mt-2 px-4 pb-48">
              <div className={cn('mx-auto w-full max-w-2xl px-1', visibleTab !== 'notes' && 'hidden')}>
                <Notepad
                  documentId={id}
                  initial={doc.notes}
                  onReady={(editor) => {
                    editorRef.current = editor
                    setEditorReady((n) => n + 1)
                  }}
                  placeholder={isRecordingHere ? 'Jot down anything important. Cereal is listening and will fill in the rest.' : 'Write notes…'}
                  onChange={(c) => queueSave(c)}
                />
              </div>
              {visibleTab === 'enhanced' && activePanel && (
                <div className="mx-auto w-full max-w-2xl px-1">
                  <EnhancedView
                    panel={activePanel}
                    chunks={chunks}
                    mode={doc.mode}
                    recording={isRecordingHere}
                    editor={enhancedEditor}
                    notesMarkdown={doc.notes_markdown}
                    notesPlain={doc.notes_plain}
                    onRetry={() => void enhance(activePanel.template_slug)}
                    onOpenQuote={openQuote}
                  />
                </div>
              )}
            </div>
          </div>

          <FloatingChatPanel
            session={chat}
            surface="meeting"
            documentId={id}
            title={`Ask about this ${kind}`}
            state={chatState}
            onStateChange={setChatState}
            actions={actions}
            above={
              <ChromeItem show={canGenerate} itemKey="generate">
                <div className="pointer-events-auto relative z-0 pb-2">
                  <MorphButton contentKey="generate" variant="accent" size="lg" onClick={() => void enhance(selectedSlug)} className="group/chroma shadow-bottom-bar" data-testid="enhance-button">
                    <Sparkles size={16} />
                    <span className="chroma-label" data-label={enhanceLabel}>
                      <span>{enhanceLabel}</span>
                    </span>
                  </MorphButton>
                </div>
              </ChromeItem>
            }
            widget={({ merged }) => (
              <RecordingWidget
                live={isRecordingHere}
                starting={isStartingHere}
                hasTranscript={hasTranscript}
                busyElsewhere={recording.status !== 'idle' && recording.document_id !== id}
                open={chatState === 'transcript'}
                merged={merged}
                onToggle={() => setChatState((s) => (s === 'transcript' ? 'idle' : 'transcript'))}
                onStart={() => void start()}
                onStop={() => {
                  void stop()
                  setChatState((s) => (s === 'transcript' ? 'idle' : s))
                }}
              />
            )}
            transcript={() => (
              <TranscriptPanel chunks={chunks} mode={doc.mode} live={isRecordingHere} starting={isStartingHere} focus={transcriptFocus} onClose={() => setChatState('idle')} />
            )}
            empty={
              <p className="px-1 text-sm leading-relaxed text-ink-tertiary">
                Ask anything about this {kind}, or type / for recipes like {kind === 'lecture' ? 'a TL;DR' : 'a follow-up email'}. Attach files, or @ another note to bring it in. Cereal can also edit your notes when
                you ask.
              </p>
            }
            composer={{
              onSend: sendChat,
              selectedText: visibleTab === 'notes' ? selectedText : null,
              onClearSelectedText: () => setSelectedText(null)
            }}
          />
        </main>

        <ConfirmDialog
          open={confirm === 'note'}
          onOpenChange={(o) => !o && setConfirm(null)}
          title="Delete this note?"
          description="Its transcript and enhanced notes are deleted too."
          confirmLabel="Delete note"
          danger
          onConfirm={async () => {
            await call('documents:delete', id)
            navigate('/')
          }}
        />
        <ConfirmDialog
          open={confirm === 'transcript'}
          onOpenChange={(o) => !o && setConfirm(null)}
          title="Delete this transcript?"
          description="Your notes and enhanced notes are kept."
          confirmLabel="Delete transcript"
          danger
          onConfirm={async () => {
            await call('transcript:clear', id)
            await loadTranscript(id)
          }}
        />
      </div>
    </SpeakersProvider>
  )
}

/** The note title: display serif, wraps onto more lines, Enter moves into the notes. */
function TitleInput({ value, placeholder, onChange, onEnter }: { value: string; placeholder: string; onChange: (v: string) => void; onEnter: () => void }): ReactNode {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={placeholder}
        aria-label="Title"
        onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onEnter()
          }
        }}
        className="block w-full resize-none overflow-hidden bg-transparent px-1 text-h3 font-normal text-ink-primary outline-none placeholder:text-ink-tertiary"
    />
  )
}
