import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { ArrowUp, Mic, Paperclip, Square, X } from 'lucide-react'
import { ATTACHMENT_ACCEPT, ATTACHMENT_LIMITS } from '@shared/attachments'
import { chatPlaceholder, detectTrigger, exactRecipe, rankRecipes, type ChatSurface, type Trigger } from '@shared/chatbar'
import type { ChatSendRequest } from '@shared/ipc'
import type { ChatMessage, Recipe } from '@shared/types'
import { call, errorMessage } from '../../lib/api'
import { navigate } from '../../lib/router'
import { useApp } from '../../store'
import { AnimatePresence, IconButton, MOD, Tooltip, cn, motion } from '../oats'
import { ChipRow, fileChip, type ChipItem } from './Chips'
import { DictationBar, useDictation } from './Dictation'
import { ChatKeymap, MentionNode, RecipeNode, insertPlainText, serialize, textBeforeCursor, type ChatKeyHandlers } from './extensions'
import { MentionMenu, RecipeMenu, recipeOrder, type MentionCandidate } from './Menus'
import { ModelPicker, useModelChoice } from './ModelPicker'
import { useAttachments } from './useAttachments'
import { NOTE_DRAG_TYPE } from './drag'

export type ComposerSend = Omit<ChatSendRequest, 'threadId' | 'documentId'>

export interface ComposerHandle {
  focus(): void
  /** Replace the text (e.g. "/" for "All recipes", or a suggestion). */
  setText(text: string): void
  /** Edit a sent message: its text and files go back in the bar, with the overwrite warning. */
  edit(message: ChatMessage): void
  insertNote(note: { id: string; title: string }): void
}

export interface ComposerProps {
  surface: ChatSurface
  documentId: string | null
  threadId: string | null
  /** floating: the pill at the bottom of a page; compact: in the sidebar and on the Chat page. */
  variant: 'floating' | 'compact'
  /** Which saved model choice this bar uses: one meeting, or across notes. */
  modelScope: 'single' | 'multi'
  hideModelSelect?: boolean
  placeholder?: string
  disabled?: boolean
  disabledMessage?: string
  /** The answer being written, if any. */
  streaming: ChatMessage | null
  hasMessages: boolean
  /** The floating bar with its panel closed. */
  collapsed?: boolean
  /** Text selected in the note, offered as context. */
  selectedText?: string | null
  onClearSelectedText?: () => void
  autoFocus?: boolean
  /** Whether this bar answers Ctrl+T (one bar per page does). */
  shortcuts?: boolean
  onSend(req: ComposerSend): Promise<void>
  onStop?(): void
  onFocusChange?(focused: boolean): void
  /** Esc with nothing else to close. */
  onEscape?(): void
  /** A press on the collapsed bar (it expands, as in Granola). */
  onActivate?(): void
  /** Shown inside the collapsed bar, before the buttons. */
  accessory?: ReactNode
  className?: string
}

/**
 * Granola's ChatInput (docs/granola-chat-bar.md §2–§7): a TipTap editor with "/" recipes and "@" notes, file and
 * image attachments (picker, paste, drop), a model picker, voice dictation, and one button that sends, stops or
 * dictates.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, ref) {
  const {
    surface,
    documentId,
    threadId,
    variant,
    modelScope,
    hideModelSelect,
    disabled,
    streaming,
    hasMessages,
    collapsed,
    selectedText,
    onClearSelectedText,
    autoFocus,
    shortcuts,
    onSend,
    onStop,
    onFocusChange,
    onEscape,
    onActivate,
    accessory,
    className
  } = props
  const settings = useApp((s) => s.settings)
  const showToast = useApp((s) => s.showToast)
  const enterKey = settings?.chat.enterKey ?? 'send'
  const [model, setModel] = useModelChoice(modelScope)
  const attachments = useAttachments({ documentId, threadId })
  const [focused, setFocused] = useState(false)
  const [empty, setEmpty] = useState(true)
  const [multiline, setMultiline] = useState(false)
  const [mentionsInDoc, setMentionsInDoc] = useState<{ id: string; title: string }[]>([])
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [notes, setNotes] = useState<{ query: string; items: MentionCandidate[]; loading: boolean }>({ query: '', items: [], loading: false })
  const [editing, setEditing] = useState<ChatMessage | null>(null)
  const [sending, setSending] = useState(false)
  const [drag, setDrag] = useState<'files' | 'note' | null>(null)
  const [now, setNow] = useState(Date.now())
  const [glow, setGlow] = useState<{ x: number; y: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const editorRef = useRef<Editor | null>(null)

  const thinkingSince = streaming && !streaming.outputs.some((o) => o.type === 'text' && o.text) ? Date.parse(streaming.created_at) : null
  const dictation = useDictation((text) => {
    const editor = editorRef.current
    if (!editor) return
    if (editor.isEmpty && !attachments.files.length) void submit(text)
    else {
      editor.chain().focus('end').insertContent(` ${text}`).run()
    }
  })

  const placeholder = chatPlaceholder({
    surface,
    disabled,
    disabledMessage: props.disabledMessage,
    override: props.placeholder,
    transcribing: dictation.state === 'transcribing',
    collapsed,
    streamingText: !!streaming && thinkingSince === null,
    thinkingSince,
    now,
    noteDragOver: drag === 'note',
    selectionPending: !!selectedText && !focused,
    hasMessages
  })
  const placeholderRef = useRef(placeholder)
  placeholderRef.current = placeholder

  // The rotating "thinking" words tick while the collapsed bar waits.
  useEffect(() => {
    if (!collapsed || thinkingSince === null) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [collapsed, thinkingSince])

  useEffect(() => {
    void call('recipes:list').then(setRecipes)
  }, [])

  // ------------------------------------------------------------------ menus

  const menuKey = trigger ? `${trigger.kind}:${trigger.query}` : null
  const menuOpen = !!trigger && dismissed !== menuKey && focused
  const recipeSections = useMemo(() => (trigger?.kind === 'recipe' ? rankRecipes(recipes, trigger.query) : null), [trigger, recipes])
  const recipeItems = recipeSections ? recipeOrder(recipeSections) : []
  const menuItems = trigger?.kind === 'recipe' ? recipeItems.length : trigger?.kind === 'mention' ? notes.items.length : 0

  useEffect(() => setActive(0), [menuKey])

  // Debounced title search for "@".
  useEffect(() => {
    if (trigger?.kind !== 'mention') return
    const q = trigger.query
    setNotes((n) => ({ ...n, loading: true }))
    const t = setTimeout(() => {
      void call(
        'chat:mention-search',
        q,
        mentionsInDoc.map((m) => m.id)
      )
        .then((items) => setNotes({ query: q, items, loading: false }))
        .catch(() => setNotes({ query: q, items: [], loading: false }))
    }, 200)
    return () => clearTimeout(t)
  }, [trigger, mentionsInDoc])

  const pickRecipe = (r: Recipe): void => {
    const editor = editorRef.current
    if (!editor) return
    const { $from } = editor.state.selection
    const start = $from.start()
    editor
      .chain()
      .focus()
      .deleteRange({ from: start, to: $from.pos })
      .insertContentAt(start, [{ type: 'recipe', attrs: { id: r.id, slug: r.slug } }, { type: 'text', text: ' ' }])
      .run()
  }

  const pickNote = (n: MentionCandidate): void => {
    const editor = editorRef.current
    if (!editor || trigger?.kind !== 'mention') return
    const { $from } = editor.state.selection
    const from = $from.pos - trigger.query.length - 1
    editor
      .chain()
      .focus()
      .deleteRange({ from, to: $from.pos })
      .insertContentAt(from, [{ type: 'mention', attrs: { id: n.id, title: n.title || 'New note' } }, { type: 'text', text: ' ' }])
      .run()
  }

  /** "/follow up email" typed out in full becomes the recipe itself when the menu closes. */
  const convertTypedRecipe = (): void => {
    const editor = editorRef.current
    if (!editor || trigger?.kind !== 'recipe') return
    const match = exactRecipe(trigger.query, recipes)
    if (match) pickRecipe(match)
  }

  // --------------------------------------------------------------- sending

  const submit = async (dictated?: string): Promise<void> => {
    const editor = editorRef.current
    if (!editor || sending || disabled) return
    if (attachments.loading) {
      showToast('info', 'Wait for your files to finish loading.')
      return
    }
    convertTypedRecipe()
    const { text, mentions } = dictated !== undefined ? { text: dictated, mentions: [] } : serialize(editor)
    if (!text && !attachments.ids.length) return
    setSending(true)
    try {
      await onSend({
        text,
        attachmentIds: attachments.ids,
        mentions,
        selectedText: selectedText || null,
        model,
        editMessageId: editing?.id ?? null
      })
      editor.commands.clearContent(true)
      attachments.clear()
      setEditing(null)
      onClearSelectedText?.()
    } catch (e) {
      showToast('error', errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  const handlers = useRef<ChatKeyHandlers | null>(null)
  handlers.current = {
    enter: ({ shift, mod }) => {
      if (menuOpen && menuItems > 0) {
        if (trigger?.kind === 'recipe') pickRecipe(recipeItems[active])
        else pickNote(notes.items[active])
        return true
      }
      if (dictation.state === 'recording') {
        dictation.send()
        return true
      }
      const sends = enterKey === 'send' ? !shift || mod : shift || mod
      if (!sends) return false
      if (streaming && onStop) {
        onStop()
        return true
      }
      void submit()
      return true
    },
    arrow: (dir) => {
      if (!menuOpen || !menuItems) return false
      setActive((a) => (dir === 'down' ? Math.min(menuItems - 1, a + 1) : Math.max(0, a - 1)))
      return true
    },
    tab: () => {
      if (!menuOpen || !menuItems) return false
      if (trigger?.kind === 'recipe') pickRecipe(recipeItems[active])
      else pickNote(notes.items[active])
      return true
    },
    escape: () => {
      if (menuOpen) {
        convertTypedRecipe()
        setDismissed(menuKey)
        return true
      }
      if (dictation.state === 'recording') {
        dictation.cancel()
        return true
      }
      if (editing) {
        cancelEdit()
        return true
      }
      editorRef.current?.commands.blur()
      onEscape?.()
      return true
    }
  }

  // ---------------------------------------------------------------- editor

  const refreshState = useCallback((ed: Editor) => {
    setEmpty(ed.isEmpty)
    setMultiline(ed.state.doc.childCount > 1 || ed.getText().includes('\n'))
    const found: { id: string; title: string }[] = []
    ed.state.doc.descendants((n) => {
      if (n.type.name === 'mention' && !found.some((m) => m.id === n.attrs.id)) found.push({ id: String(n.attrs.id), title: String(n.attrs.title) })
    })
    setMentionsInDoc((prev) => (prev.length === found.length && prev.every((p, i) => p.id === found[i].id) ? prev : found))
    setTrigger(ed.state.selection.empty ? detectTrigger(textBeforeCursor(ed)) : null)
  }, [])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
        codeBlock: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        horizontalRule: false,
        link: false,
        underline: false,
        dropcursor: false,
        trailingNode: false
      }),
      Placeholder.configure({ placeholder: () => placeholderRef.current, showOnlyCurrent: false }),
      RecipeNode,
      MentionNode,
      ChatKeymap.configure({ handlers: () => handlers.current })
    ],
    autofocus: autoFocus ? 'end' : false,
    editorProps: {
      attributes: { class: 'chat-editor w-full h-full grow text-ink-primary focus:outline-none break-words', spellcheck: 'false', 'aria-label': 'Chat message' },
      handlePaste: (_view, event) => {
        const data = event.clipboardData
        if (!data) return false
        const files = Array.from(data.files)
        if (files.length) {
          void attachments.add(files)
          return true
        }
        const text = data.getData('text/plain')
        if (!text) return false
        if (text.length > ATTACHMENT_LIMITS.pasteAsFileChars) attachments.addPastedText(text)
        else if (editorRef.current) insertPlainText(editorRef.current, text)
        return true
      },
      handleDrop: () => true
    },
    onUpdate: ({ editor }) => refreshState(editor),
    onSelectionUpdate: ({ editor }) => refreshState(editor),
    onFocus: () => {
      setFocused(true)
      onFocusChange?.(true)
    },
    onBlur: () => {
      setFocused(false)
      onFocusChange?.(false)
    }
  })
  editorRef.current = editor

  // The placeholder is read from a ref; a no-op transaction redraws it when it changes.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('placeholder', placeholder))
  }, [editor, placeholder])

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  const cancelEdit = (): void => {
    setEditing(null)
    editorRef.current?.commands.clearContent(true)
    attachments.clear()
  }

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.commands.focus('end'),
    setText: (text) => {
      editorRef.current?.chain().setContent({ type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] }).focus('end').run()
    },
    edit: (message) => {
      setEditing(message)
      const lines = message.content.split('\n')
      editorRef.current
        ?.chain()
        .setContent({ type: 'doc', content: lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] })) })
        .focus('end')
        .run()
      attachments.load(message.attachments)
    },
    insertNote: (note) => {
      editorRef.current
        ?.chain()
        .focus('end')
        .insertContent([{ type: 'mention', attrs: note }, { type: 'text', text: ' ' }])
        .run()
    }
  }))

  // Ctrl+T dictates (and sends a dictation in progress).
  useEffect(() => {
    if (!shortcuts || disabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 't' || e.shiftKey || e.altKey) return
      e.preventDefault()
      if (dictation.state === 'recording') dictation.send()
      else void dictation.start()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcuts, disabled, dictation])

  // ----------------------------------------------------------- drag & drop

  const dragKind = (e: React.DragEvent): 'files' | 'note' | null =>
    e.dataTransfer.types.includes(NOTE_DRAG_TYPE) ? 'note' : e.dataTransfer.types.includes('Files') ? 'files' : null
  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      const kind = dragKind(e)
      if (!kind || disabled) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      if (drag !== kind) setDrag(kind)
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!root.current?.contains(e.relatedTarget as Node | null)) setDrag(null)
    },
    onDrop: (e: React.DragEvent) => {
      const kind = dragKind(e)
      setDrag(null)
      if (!kind || disabled) return
      e.preventDefault()
      if (kind === 'files') void attachments.add(e.dataTransfer.files)
      else {
        try {
          const note = JSON.parse(e.dataTransfer.getData(NOTE_DRAG_TYPE)) as { id: string; title: string }
          if (note.id) editorRef.current?.chain().focus('end').insertContent([{ type: 'mention', attrs: { id: note.id, title: note.title || 'New note' } }, { type: 'text', text: ' ' }]).run()
        } catch {
          // not one of our notes
        }
      }
    }
  }

  // ------------------------------------------------------------------ view

  const chips: ChipItem[] = [
    ...(selectedText ? [{ type: 'selection' as const, key: 'selection', text: selectedText }] : []),
    ...mentionsInDoc.map((m) => ({ type: 'note' as const, key: `note-${m.id}`, id: m.id, title: m.title })),
    ...attachments.files.map(fileChip)
  ]
  const removeChip = (item: ChipItem): void => {
    if (item.type === 'selection') onClearSelectedText?.()
    else if (item.type === 'file') attachments.remove(item.key)
    else {
      const ed = editorRef.current
      if (!ed) return
      // Remove every mention of that note from the text.
      const ranges: { from: number; to: number }[] = []
      ed.state.doc.descendants((n, pos) => {
        if (n.type.name === 'mention' && n.attrs.id === item.id) ranges.push({ from: pos, to: pos + n.nodeSize })
      })
      const tr = ed.state.tr
      for (const r of ranges.reverse()) tr.delete(r.from, r.to)
      ed.view.dispatch(tr)
    }
  }

  const hasContent = !empty || attachments.files.length > 0
  const recording = dictation.state === 'recording'
  const compact = variant === 'compact'

  const buttons = (
    <>
      <Tooltip content="Upload files or images" side="top">
        <IconButton label="Upload files or images" data-testid="attach-file-button" disabled={disabled} onClick={() => fileInput.current?.click()} className="size-8 text-ink-secondary hover:text-ink-primary">
          <Paperclip size={16} />
        </IconButton>
      </Tooltip>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        data-testid="attach-file-input"
        onChange={(e) => {
          if (e.target.files) void attachments.add(e.target.files)
          e.target.value = ''
        }}
      />
      {!hideModelSelect && <ModelPicker value={model} onChange={setModel} side={compact ? 'bottom' : 'top'} />}
    </>
  )

  const sendButton = (
    <SendButton
      state={streaming && onStop ? 'stop' : hasContent ? 'send' : 'mic'}
      disabled={disabled || sending || (hasContent && attachments.loading) || dictation.state === 'transcribing'}
      enterKey={enterKey}
      onSend={() => void submit()}
      onStop={() => onStop?.()}
      onMic={() => void dictation.start()}
    />
  )

  return (
    <div className={cn('relative w-full', className)} ref={root} {...dropHandlers}>
      <AnimatePresence>
        {menuOpen && trigger?.kind === 'recipe' && recipeSections && (
          <RecipeMenu
            key="recipes"
            sections={recipeSections}
            query={trigger.query}
            active={active}
            onHover={setActive}
            onPick={pickRecipe}
            onCreate={() => navigate(`/recipes?new=${encodeURIComponent(trigger.query)}`)}
            onBrowse={() => navigate('/recipes')}
          />
        )}
        {menuOpen && trigger?.kind === 'mention' && (
          <MentionMenu key="notes" notes={notes.items} query={notes.query} loading={notes.loading} active={active} onHover={setActive} onPick={pickNote} />
        )}
      </AnimatePresence>
      <div
        id="chat-input"
        data-testid="chat-input"
        data-placeholder={placeholder}
        data-focused={focused || undefined}
        onMouseDown={(e) => {
          const target = e.target as HTMLElement
          if (target.closest('button, input, [role="menu"], [role="listbox"]')) return
          onActivate?.()
          if (!target.closest('.ProseMirror')) {
            e.preventDefault()
            editorRef.current?.commands.focus('end')
          }
        }}
        onMouseMove={(e) => {
          if (!collapsed || focused) return
          const box = e.currentTarget.getBoundingClientRect()
          setGlow({ x: e.clientX - box.left, y: e.clientY - box.top })
        }}
        onMouseLeave={() => setGlow(null)}
        className={cn(
          'group/chat-input relative flex w-full cursor-text flex-col overflow-hidden border bg-surface-elevated transition-[border-color,box-shadow,opacity]',
          compact ? 'rounded-[20px]' : 'min-h-14 rounded-[28px]',
          focused
            ? 'border-ink-accent ring-3 ring-ink-accent/20'
            : 'border-transparent shadow-[0px_0px_0px_0.5px_rgba(0,0,0,0.2),0px_4px_6px_-2px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_0px_0.5px_rgba(255,255,255,0.15),0px_4px_6px_-2px_rgba(0,0,0,0.3)]',
          drag === 'note' && 'shadow-[0_0_12px_rgba(61,123,255,0.45)]',
          disabled && 'pointer-events-none cursor-not-allowed opacity-50'
        )}
      >
        {collapsed && !focused && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 transition-opacity duration-300"
            style={{
              opacity: glow ? 1 : 0,
              background: glow ? `radial-gradient(1024px circle at ${glow.x}px ${glow.y}px, rgba(255,255,255,0.05), transparent 500px)` : undefined
            }}
          />
        )}
        <AnimatePresence initial={false}>
          {editing && (
            <motion.div
              key="editing"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.1 }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2 border-b border-hairline px-4 py-2 text-xs text-ink-secondary" data-testid="edit-banner">
                <span className="flex-1">Everything after the edited message will be overwritten</span>
                <IconButton size="sm" label="Cancel edit" onClick={cancelEdit}>
                  <X size={14} />
                </IconButton>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {chips.length > 0 && (
            <motion.div key="chips" initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} transition={{ duration: 0.1 }} className="overflow-hidden">
              <ChipRow items={chips} onRemove={removeChip} className={compact ? 'px-3 pt-2.5' : 'px-4 pt-2.5'} />
            </motion.div>
          )}
        </AnimatePresence>

        {recording ? (
          <DictationBar dictation={dictation} />
        ) : compact ? (
          <>
            <div className="max-h-[240px] min-h-[38px] overflow-y-auto pt-2.5 pr-3 pl-4 text-base">
              <EditorContent editor={editor} />
            </div>
            <div className="flex items-center gap-0.5 pr-2 pb-1.5 pl-1.5">
              {buttons}
              <div className="flex-1" />
              {sendButton}
            </div>
          </>
        ) : (
          <div className={cn('flex flex-wrap items-end py-1 pr-2 pl-5', multiline && 'pt-2.5')}>
            <div className={cn('max-h-[240px] min-w-0 flex-1 overflow-y-auto py-[13px] text-base', multiline && 'basis-full py-1')}>
              <EditorContent editor={editor} />
            </div>
            <div className={cn('flex min-h-[47px] shrink-0 items-center gap-0.5', multiline && 'ml-auto')}>
              {accessory}
              {buttons}
              {sendButton}
            </div>
          </div>
        )}

        <AnimatePresence>
          {drag === 'files' && (
            <motion.div
              key="drop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-3 bg-surface-elevated/95 text-sm text-ink-secondary"
              data-testid="drop-overlay"
            >
              <span className="relative flex h-7 w-12 items-center justify-center">
                {[-6, 0, 6].map((deg, i) => (
                  <span key={deg} className="absolute h-7 w-5 rounded-[4px] bg-surface ring ring-hairline" style={{ transform: `translateX(${(i - 1) * 10}px) rotate(${deg}deg)` }} />
                ))}
              </span>
              <span>
                <span className="block text-ink-primary">Drop files to ask about them</span>
                <span className="block text-xs text-ink-tertiary">PNG, JPEG, PDF, Word, Excel, Markdown, JSON or text</span>
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
})

/** One button that sends, stops the answer, or starts dictation when the bar is empty. */
function SendButton({
  state,
  disabled,
  enterKey,
  onSend,
  onStop,
  onMic
}: {
  state: 'send' | 'stop' | 'mic'
  disabled: boolean
  enterKey: 'send' | 'newline'
  onSend: () => void
  onStop: () => void
  onMic: () => void
}): ReactNode {
  const tooltip = state === 'send' ? 'Send' : state === 'stop' ? 'Stop' : 'Ask by voice'
  const kbd = state === 'send' ? (enterKey === 'send' ? '↵' : `${MOD} ↵`) : state === 'mic' ? `${MOD} T` : undefined
  return (
    <Tooltip content={tooltip} kbd={kbd} side="top">
      <IconButton
        label={state === 'send' ? 'Send message' : state === 'stop' ? 'Stop' : 'Start dictation'}
        variant={state === 'send' ? 'accent' : 'soft'}
        disabled={disabled && state !== 'stop'}
        data-testid="send-button"
        onClick={state === 'send' ? onSend : state === 'stop' ? onStop : onMic}
        className="size-8 shrink-0 disabled:opacity-40"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={state} initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.5, opacity: 0 }} transition={{ duration: 0.1 }} className="flex">
            {state === 'send' ? <ArrowUp size={16} /> : state === 'stop' ? <Square size={10} fill="currentColor" /> : <Mic size={16} />}
          </motion.span>
        </AnimatePresence>
      </IconButton>
    </Tooltip>
  )
}
