import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { History, Maximize2, SquarePen, X } from 'lucide-react'
import type { ChatSurface } from '@shared/chatbar'
import type { ChatMessage, ChatThread, Recipe } from '@shared/types'
import { call, useEvent } from '../lib/api'
import { dayLabel } from '../lib/format'
import { navigate } from '../lib/router'
import { ChatMessages, streamingMessage, useThreadMessages } from './Chat'
import type { OutputActions } from './AgentOutputs'
import { Composer, type ComposerHandle, type ComposerProps, type ComposerSend } from './chat/Composer'
import { AnimatePresence, IconButton, MOD, Menu, MenuItem, MenuLabel, Tooltip, cn, motion } from './oats'

// Granola's chat surfaces (docs/granola-chat-bar.md §8): the floating bar whose panel expands upward (notes), the
// docked chat sidebar (Home and folders, where the floating bar opens it), and the header they share.

/** Thread list and current thread for one chat context (a note, or all meetings). */
export function useChatThreads(documentId: string | null): {
  threads: ChatThread[]
  threadId: string | null
  setThreadId: (id: string | null) => void
  refresh: () => void
} {
  const [threads, setThreads] = useState<ChatThread[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const refresh = useCallback((): void => void call('chat:threads', documentId).then(setThreads), [documentId])
  useEffect(() => {
    let live = true
    void call('chat:threads', documentId).then((t) => {
      if (!live) return
      setThreads(t)
      if (documentId) setThreadId(t[0]?.id ?? null)
    })
    return () => {
      live = false
    }
  }, [documentId])
  // Titles arrive after the first answer.
  useEvent('chat:thread', (t) => {
    if (t.document_id === documentId) setThreads((list) => (list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list]))
  })
  return { threads, threadId, setThreadId, refresh }
}

/** Everything a chat surface needs: its threads, the current conversation, and send / stop / retry / edit. */
export function useChatSession(documentId: string | null) {
  const { threads, threadId, setThreadId, refresh } = useChatThreads(documentId)
  const messages = useThreadMessages(threadId)
  const streaming = streamingMessage(messages)
  const composer = useRef<ComposerHandle>(null)

  const send = useCallback(
    async (req: ComposerSend): Promise<string> => {
      const res = await call('chat:send', { ...req, threadId, documentId })
      setThreadId(res.threadId)
      refresh()
      return res.threadId
    },
    [threadId, documentId, setThreadId, refresh]
  )
  const stop = useCallback(() => {
    if (streaming) void call('chat:stop', streaming.id)
  }, [streaming])
  const retry = useCallback(() => {
    if (threadId) void call('chat:retry', threadId)
  }, [threadId])
  const newChat = useCallback(() => {
    setThreadId(null)
    composer.current?.focus()
  }, [setThreadId])
  const sayMore = useCallback(() => void send({ text: 'Can you provide more details', responseStyle: 'detailed' }), [send])
  const edit = useCallback((m: ChatMessage) => composer.current?.edit(m), [])

  return { threads, threadId, setThreadId, refresh, messages, streaming, composer, send, stop, retry, newChat, sayMore, edit }
}

export type ChatSession = ReturnType<typeof useChatSession>

/** Recent chats, New chat (Ctrl N) and Maximize (open the thread on the Chat page), plus an optional close. */
export function ChatHeader({ title, session, onClose, maximize = true }: { title: string; session: ChatSession; onClose?: () => void; maximize?: boolean }): ReactNode {
  const { threads, threadId, setThreadId, newChat } = session
  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 pr-2 pl-4">
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-primary">{(threadId && threads.find((t) => t.id === threadId)?.title) || title}</span>
      <Menu
        align="end"
        trigger={
          <IconButton size="sm" label="Recent chats" disabled={threads.length === 0}>
            <History size={16} />
          </IconButton>
        }
      >
        <MenuLabel>Recent chats</MenuLabel>
        {threads.map((t) => (
          <MenuItem key={t.id} onClick={() => setThreadId(t.id)} className={cn(t.id === threadId && 'bg-oats-off-black-a6 dark:bg-oats-off-white-a6')}>
            <span className="min-w-0 flex-1 truncate">{t.title || 'Chat'}</span>
            <span className="shrink-0 text-xs text-ink-tertiary">{dayLabel(t.updated_at)}</span>
          </MenuItem>
        ))}
      </Menu>
      <Tooltip content="New chat" kbd={`${MOD} N`}>
        <IconButton size="sm" label="New chat" onClick={newChat} disabled={!threadId}>
          <SquarePen size={16} />
        </IconButton>
      </Tooltip>
      {maximize && (
        <Tooltip content="Maximize">
          <IconButton size="sm" label="Maximize" disabled={!threadId} onClick={() => threadId && navigate(`/chat/${threadId}`)}>
            <Maximize2 size={15} />
          </IconButton>
        </Tooltip>
      )}
      {onClose && (
        <Tooltip content="Close chat">
          <IconButton size="sm" label="Close chat" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </Tooltip>
      )}
    </div>
  )
}

/** Recipe suggestions: the most used first, then built-ins (Granola's top suggestions, from local usage). */
export function useSuggestedRecipes(limit = 5): Recipe[] {
  const [recipes, setRecipes] = useState<Recipe[]>([])
  useEffect(() => {
    void call('recipes:list').then((list) =>
      setRecipes([...list].sort((a, b) => b.usage_count - a.usage_count || (a.last_used_at && !b.last_used_at ? -1 : 0) || Number(b.builtin) - Number(a.builtin)).slice(0, limit))
    )
  }, [limit])
  return recipes
}

const DEFAULT_PANEL_HEIGHT = 400
const MIN_PANEL_HEIGHT = 160
const HEIGHT_KEY = 'cereal.floatingChatHeight'
/** The toolbar the panel must stay below, plus a 4px gap. */
const TOP_CLEARANCE = 44 + 4

function loadPanelHeight(): number {
  try {
    const v = Number(localStorage.getItem(HEIGHT_KEY))
    return v >= MIN_PANEL_HEIGHT ? v : DEFAULT_PANEL_HEIGHT
  } catch {
    return DEFAULT_PANEL_HEIGHT
  }
}

function savePanelHeight(h: number): void {
  try {
    localStorage.setItem(HEIGHT_KEY, String(Math.round(h)))
  } catch {
    // Storage can be unavailable; the panel just won't remember its height.
  }
}

export type FloatingState = 'idle' | 'chat' | 'transcript'

/**
 * The floating chat on a note (docs/granola-chat-bar.md §8, docs/granola-ui.md §Note): a row at the bottom of the page
 * with the recording widget on the left of the chat input. The chat (from the input) or the transcript (from the
 * widget) opens as a resizable panel above the row, in one card with the part that opened it. `above` sits over the
 * bar while it is collapsed (Generate notes). Clicking outside the open panel collapses it.
 */
export function FloatingChatPanel({
  session,
  surface,
  documentId,
  title,
  state,
  onStateChange,
  above,
  widget,
  transcript,
  actions,
  empty,
  composer
}: {
  session: ChatSession
  surface: ChatSurface
  documentId: string | null
  title: string
  state: FloatingState
  onStateChange: (s: FloatingState) => void
  above?: ReactNode
  /** The recording widget, shown left of the input except while the chat is open. `merged` while the transcript is. */
  widget?: (ctx: { merged: boolean }) => ReactNode
  /** The transcript panel's contents (header and scroller). */
  transcript?: () => ReactNode
  actions?: OutputActions
  empty?: ReactNode
  composer?: Partial<ComposerProps>
}): ReactNode {
  const [height, setHeight] = useState(loadPanelHeight)
  const [limit, setLimit] = useState(Infinity)
  const [resizing, setResizing] = useState(false)
  const bar = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const recipes = useSuggestedRecipes(5)
  const open = state !== 'idle'
  const { messages, streaming } = session
  const panelHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(height, limit))

  // The tallest the panel can be: the page height, less the toolbar and everything in the bar besides the panel.
  const measureLimit = useCallback((): number => {
    const el = bar.current
    const host = el?.parentElement
    if (!el || !host) return Infinity
    const rest = el.offsetHeight - (panel.current?.offsetHeight ?? 0)
    return Math.max(MIN_PANEL_HEIGHT, host.clientHeight - TOP_CLEARANCE - rest)
  }, [])

  useEffect(() => {
    const host = bar.current?.parentElement
    if (!open || !host) return
    const ro = new ResizeObserver(() => setLimit(measureLimit()))
    ro.observe(host)
    return () => ro.disconnect()
  }, [open, measureLimit])

  // The bar's height, for page content that has to sit clear of it (the enhance status pill sticks just above).
  useEffect(() => {
    const el = bar.current
    const host = el?.parentElement
    if (!el || !host) return
    const ro = new ResizeObserver(() => host.style.setProperty('--floating-chat-h', `${el.offsetHeight}px`))
    ro.observe(el)
    return () => {
      ro.disconnect()
      host.style.removeProperty('--floating-chat-h')
    }
  }, [])

  // A press outside the open panel collapses it and still does what it was aimed at (a toolbar button, a tab, the
  // notes). Granola covers the page with a layer that swallows that first press; the user chose not to.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as HTMLElement
      if (bar.current?.contains(target) || target.closest('[data-base-ui-portal], [role="menu"], [role="dialog"]')) return
      onStateChange('idle')
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [open, onStateChange])

  const onResizeStart = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = panelHeight
    const max = measureLimit()
    let next = startHeight
    setResizing(true)
    const move = (ev: PointerEvent): void => {
      next = Math.min(max, Math.max(MIN_PANEL_HEIGHT, startHeight + startY - ev.clientY))
      setHeight(next)
    }
    const up = (): void => {
      setResizing(false)
      savePanelHeight(next)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const send = async (req: ComposerSend): Promise<void> => {
    onStateChange('chat')
    await session.send(req)
  }

  const spring = { type: 'spring', duration: 0.2, bounce: 0.2 } as const
  return (
    <div
      ref={bar}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center px-2 pb-4 [anchor-name:--floating-chat]"
      data-testid="floating-chat"
      data-state={state}
    >
      {!open && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-surface from-30% to-transparent" />}
      {!open && above && <div className="relative flex w-full max-w-[min(100cqw-16px,43rem)] flex-col items-center">{above}</div>}
      <motion.div
        layout
        transition={{ type: 'spring', duration: 0.2, bounce: open ? 0.2 : 0 }}
        data-testid="floating-chat-panel"
        className={cn(
          'floating-chat-panel relative flex w-full max-w-[min(100cqw-16px,43rem)] min-w-60 origin-bottom flex-col',
          open && 'pointer-events-auto overflow-hidden rounded-[32px] bg-surface-elevated shadow-lg ring-[0.5px] ring-hairline dark:ring-inset'
        )}
      >
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              ref={panel}
              key="panel"
              initial={{ opacity: 0, height: 0, scale: 0.98 }}
              animate={{ opacity: 1, height: panelHeight, scale: 1 }}
              exit={{ opacity: 0, height: 0, scale: 0.98, transition: { ...spring, bounce: 0 } }}
              transition={resizing ? { duration: 0 } : spring}
              className="relative flex min-h-0 flex-col"
              style={{ height: panelHeight }}
            >
              <div onPointerDown={onResizeStart} className="group/resize absolute inset-x-0 top-0 z-10 mx-auto flex h-4 w-48 cursor-ns-resize items-start justify-center pt-1.5" aria-label="Resize panel">
                <span className={cn('h-1 w-9 rounded-full bg-oats-off-black-a12 opacity-0 transition-opacity group-hover/resize:opacity-100 dark:bg-oats-off-white-a15', resizing && 'opacity-100')} />
              </div>
              {state === 'transcript' && transcript ? (
                transcript()
              ) : (
                <>
                  <ChatHeader title={title} session={session} onClose={() => onStateChange('idle')} />
                  <div className="selectable min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-4">
                    <ChatMessages
                      messages={messages}
                      actions={actions}
                      chat={{ onEdit: session.edit, onRetry: session.retry, onNewChat: session.newChat, onSayMore: session.sayMore }}
                      empty={
                        <div className="pt-4">
                          {empty}
                          {recipes.length > 0 && (
                            <div className="mt-3 flex flex-col gap-0.5">
                              {recipes.slice(0, 3).map((r) => (
                                <button
                                  key={r.id}
                                  type="button"
                                  onClick={() => void send({ text: `/${r.slug}` })}
                                  className="flex cursor-default items-center gap-2 rounded-xl px-2 py-1.5 text-left text-sm text-ink-secondary hover:bg-highlight hover:text-ink-primary"
                                >
                                  <span className="text-ink-tertiary">/</span>
                                  {r.name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      }
                    />
                  </div>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        <div className={cn('flex w-full flex-wrap items-end justify-center gap-2', state === 'chat' && 'px-2 pb-2')}>
          {widget && state !== 'chat' && widget({ merged: state === 'transcript' })}
          {/* Hidden rather than unmounted while the transcript is open, so a draft and its files survive. */}
          <div className={cn('pointer-events-auto min-w-0 grow basis-3/5', state === 'transcript' && 'hidden')}>
            <Composer
              ref={session.composer}
              surface={surface}
              documentId={documentId}
              threadId={session.threadId}
              variant="floating"
              modelScope={documentId ? 'single' : 'multi'}
              streaming={streaming}
              hasMessages={messages.length > 0}
              collapsed={state !== 'chat'}
              shortcuts
              onSend={send}
              onStop={session.stop}
              onActivate={() => state !== 'chat' && messages.length > 0 && onStateChange('chat')}
              onEscape={() => onStateChange('idle')}
              {...composer}
            />
          </div>
        </div>
      </motion.div>
      {state === 'chat' && recipes.length > 0 && messages.length > 0 && (
        <div className="pointer-events-auto mt-2 flex w-full max-w-[min(100cqw-16px,43rem)] flex-wrap justify-center gap-1 overflow-hidden" style={{ maxHeight: 32 }}>
          {recipes.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => void send({ text: `/${r.slug}` })}
              className="h-7 cursor-default rounded-full px-2.5 text-sm text-ink-secondary hover:bg-highlight hover:text-ink-primary"
            >
              {r.name}
            </button>
          ))}
          <button type="button" onClick={() => session.composer.current?.setText('/')} className="h-7 cursor-default rounded-full px-2.5 text-sm text-ink-tertiary hover:bg-highlight hover:text-ink-primary">
            All recipes
          </button>
        </div>
      )}
      <p className="pointer-events-auto mt-1.5 text-[11px] text-ink-tertiary">Cereal uses AI and can make mistakes.</p>
    </div>
  )
}

const SIDEBAR_MIN = 330
const SIDEBAR_WITH_MESSAGES = 440
const SIDEBAR_MAX = 720

/**
 * The docked chat sidebar (`aside#multi-chat-sidebar`): 330px, 440px once there are messages, resizable from its
 * left edge up to 720px. It docks beside the page from 64rem; below that it floats over the page as a card.
 */
export function ChatSidebar({
  open,
  session,
  surface,
  documentId,
  title,
  onClose,
  empty
}: {
  open: boolean
  session: ChatSession
  surface: ChatSurface
  documentId: string | null
  title: string
  onClose: () => void
  empty?: ReactNode
}): ReactNode {
  const { messages, streaming } = session
  const [width, setWidth] = useState<number | null>(null)
  const auto = messages.length > 0 ? SIDEBAR_WITH_MESSAGES : SIDEBAR_MIN
  const current = width ?? auto
  const aside = useRef<HTMLElement>(null)

  // Outside clicks close a floating (undocked) sidebar.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const el = aside.current
      if (!el || el.contains(e.target as Node)) return
      if ((e.target as HTMLElement).closest('[data-base-ui-portal], [role="menu"], [role="dialog"]')) return
      if (getComputedStyle(el).position === 'absolute') onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  const onResizeStart = (e: React.PointerEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const start = current
    const move = (ev: PointerEvent): void => setWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, start + startX - ev.clientX)))
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          ref={aside}
          key="chat-sidebar"
          id="multi-chat-sidebar"
          initial={{ opacity: 0, x: 12, scale: 0.98 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 12, scale: 0.98 }}
          transition={{ type: 'spring', bounce: 0, duration: 0.25 }}
          style={{ originX: 1, ['--chat-sidebar-width' as string]: `${current}px` }}
          className="absolute top-11 right-0 bottom-0 z-40 flex w-80 max-w-full flex-row pt-px pr-2 pb-2 [anchor-name:--multi-chat-sidebar] @5xl/view:relative @5xl/view:top-0 @5xl/view:z-auto @5xl/view:w-(--chat-sidebar-width) @5xl/view:pt-11"
        >
          <div onPointerDown={onResizeStart} className="group/resize hidden h-full w-2 shrink-0 cursor-ew-resize place-items-center pt-6 pb-8 @5xl/view:grid" aria-label="Resize chat">
            <span className="h-8 w-[3px] rounded-full bg-transparent transition-colors group-hover/resize:bg-oats-off-black-a12 dark:group-hover/resize:bg-oats-off-white-a15" />
          </div>
          <div className="@container/chat flex h-full min-w-0 flex-1 origin-right flex-col overflow-hidden rounded-[20px] bg-surface-elevated shadow-lg ring-[0.5px] ring-hairline dark:ring-inset @5xl/view:shadow-none">
            <ChatHeader title={title} session={session} onClose={onClose} />
            <div className="selectable min-h-0 flex-1 overflow-y-auto px-4 pt-1 pb-4">
              <ChatMessages messages={messages} empty={empty} chat={{ onEdit: session.edit, onRetry: session.retry, onNewChat: session.newChat, onSayMore: session.sayMore }} />
            </div>
            <div className="px-2 pb-2 @lg/chat:px-4 @lg/chat:pb-4">
              <Composer
                ref={session.composer}
                autoFocus
                surface={surface}
                documentId={documentId}
                threadId={session.threadId}
                variant="compact"
                modelScope="multi"
                streaming={streaming}
                hasMessages={messages.length > 0}
                shortcuts
                onSend={async (req) => void (await session.send(req))}
                onStop={session.stop}
                onEscape={onClose}
              />
            </div>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

/** Chat on Home and in folders: the floating bar; sending (or Ctrl+J) opens the conversation in the sidebar. */
export function FloatingChat({ surface, title, disabled, disabledMessage }: { surface: ChatSurface; title: string; disabled?: boolean; disabledMessage?: string }): ReactNode {
  const session = useChatSession(null)
  const [open, setOpen] = useState(false)
  const recipes = useSuggestedRecipes(1)
  useChatShortcuts({ onToggle: () => setOpen((o) => !o), onNewChat: () => (setOpen(true), session.newChat()) })
  const send = async (req: ComposerSend): Promise<void> => {
    setOpen(true)
    await session.send(req)
  }
  const chip = recipes[0]
  return (
    <>
      <ChatSidebar
        open={open}
        session={session}
        surface={surface}
        documentId={null}
        title="Ask Cereal"
        onClose={() => setOpen(false)}
        empty={<p className="mt-8 px-2 text-center text-sm leading-relaxed text-ink-tertiary">Ask about {title}. Type / for recipes, or @ to point at a note.</p>}
      />
      {!open && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center px-2 pb-4" data-testid="floating-chat" data-state="idle">
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-linear-to-t from-surface from-30% to-transparent" />
          <div className="pointer-events-auto relative w-full min-w-60 max-w-[min(100cqw-16px,43rem)]">
            <Composer
              ref={session.composer}
              surface={surface}
              documentId={null}
              threadId={session.threadId}
              variant="floating"
              modelScope="multi"
              streaming={session.streaming}
              hasMessages={session.messages.length > 0}
              collapsed
              disabled={disabled}
              disabledMessage={disabledMessage}
              shortcuts
              onSend={send}
              onStop={session.stop}
              onActivate={() => session.messages.length > 0 && setOpen(true)}
              accessory={
                chip && (
                  <button
                    type="button"
                    onClick={() => void send({ text: `/${chip.slug}` })}
                    className="mr-1 hidden h-9 cursor-default items-center rounded-full border border-hairline px-3 text-sm text-ink-secondary hover:bg-highlight hover:text-ink-primary sm:flex"
                  >
                    {chip.name}
                  </button>
                )
              }
            />
          </div>
          <p className="pointer-events-auto relative mt-1.5 text-[11px] text-ink-tertiary">Cereal uses AI and can make mistakes.</p>
        </div>
      )}
    </>
  )
}

/** Ctrl+J toggles the chat and Ctrl+N starts a new one, while a page with a chat bar is open. */
export function useChatShortcuts({ onToggle, onNewChat }: { onToggle: () => void; onNewChat?: () => void }): void {
  const ref = useRef({ onToggle, onNewChat })
  ref.current = { onToggle, onNewChat }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'j') {
        e.preventDefault()
        ref.current.onToggle()
      } else if (key === 'n' && ref.current.onNewChat && document.activeElement?.closest('#chat-input, #multi-chat-sidebar, [data-testid="floating-chat"]')) {
        // Inside a chat, Ctrl+N is a new chat rather than a new note.
        e.preventDefault()
        e.stopImmediatePropagation()
        ref.current.onNewChat()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}
