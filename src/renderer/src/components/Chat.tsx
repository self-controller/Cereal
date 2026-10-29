import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, Copy, FileText, MessageSquarePlus, Pencil, RotateCcw, Square, WandSparkles } from 'lucide-react'
import { call, errorMessage, useEvent } from '../lib/api'
import { navigate } from '../lib/router'
import { useApp } from '../store'
import { AgentOutputs, type OutputActions } from './AgentOutputs'
import { Markdown } from './Markdown'
import { ChipRow, fileChip, type ChipItem } from './chat/Chips'
import { AnimatePresence, Button, IconButton, LoopMark, Spinner, Tooltip, cn, motion } from './oats'
import type { ChatMessage, Recipe } from '@shared/types'

/** Messages for one thread, kept live from `chat:message` events. */
export function useThreadMessages(threadId: string | null): ChatMessage[] {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  useEffect(() => {
    let live = true
    if (!threadId) return setMessages([])
    void call('chat:messages', threadId).then((m) => live && setMessages(m))
    return () => {
      live = false
    }
  }, [threadId])
  useEvent('chat:message', (m) => {
    if (m.thread_id !== threadId) return
    setMessages((list) => (list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m]))
  })
  return messages
}

/** The answer currently being written in a thread, if any. */
export function streamingMessage(messages: ChatMessage[]): ChatMessage | null {
  const last = messages[messages.length - 1]
  return last?.role === 'assistant' && last.status === 'in_progress' ? last : null
}

/** Granola's three jumping dots, for the live transcript's "Listening". `step` staggers the dots (the transcript uses 0.25s). */
export function JumpingDots({ className, step = 0.15, label = 'Thinking' }: { className?: string; step?: number; label?: string }): ReactNode {
  return (
    <span className={cn('inline-flex h-4 items-center space-x-1', className)} aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span key={i} className="inline-block size-1 animate-jumping-dots rounded-full bg-current" style={{ animationDelay: `${i * step}s` }} />
      ))}
    </span>
  )
}

/** Cereal's thinking mark beside what the agent is doing, in shimmering text; a new status cross-fades in. */
export function ThinkingIndicator({ text = 'Thinking…', className }: { text?: string; className?: string }): ReactNode {
  return (
    <div role="status" className={cn('flex items-center gap-2 text-sm text-ink-secondary', className)}>
      <LoopMark />
      <span className="grid-pile items-center">
        <span aria-hidden className="pointer-events-none invisible select-none">
          {text}
        </span>
        <AnimatePresence mode="wait">
          <motion.span key={text} className="shimmer-text" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.15 } }} transition={{ duration: 0.4, ease: 'easeOut' }}>
            {text}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  )
}

export function UserBubble({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="flex justify-end">
      <div className="selectable max-w-[85%] rounded-2xl rounded-br-md bg-fill-highlight px-3.5 py-2 text-base leading-relaxed whitespace-pre-wrap text-ink-primary">{children}</div>
    </div>
  )
}

/** A sent question: what it referred to (files, notes, selected text) as chips, then the text, then Copy and Edit. */
function UserMessage({ message: m, onEdit }: { message: ChatMessage; onEdit?: (m: ChatMessage) => void }): ReactNode {
  const chips: ChipItem[] = [
    ...(m.context?.selectedText ? [{ type: 'selection' as const, key: 'selection', text: m.context.selectedText }] : []),
    ...(m.context?.mentions ?? []).map((n) => ({ type: 'note' as const, key: `note-${n.id}`, id: n.id, title: n.title })),
    ...m.attachments.map(fileChip)
  ]
  return (
    <div className="group/user flex flex-col items-end gap-1.5" data-testid="user-message">
      {chips.length > 0 && <ChipRow items={chips} align="end" className="w-[70%]" />}
      {m.content && <UserBubble>{m.content}</UserBubble>}
      <div className="flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-75 group-hover/user:opacity-100 group-has-focus-visible/user:opacity-100">
        <Tooltip content="Copy" side="bottom">
          <IconButton size="sm" label="Copy message" onClick={() => void navigator.clipboard.writeText(m.content)}>
            <Copy size={14} />
          </IconButton>
        </Tooltip>
        {onEdit && (
          <Tooltip content="Edit" side="bottom">
            <IconButton size="sm" label="Edit message" onClick={() => onEdit(m)}>
              <Pencil size={14} />
            </IconButton>
          </Tooltip>
        )}
      </div>
    </div>
  )
}

export interface ChatMessageActions {
  /** Edit a sent question (it and everything after it is replaced). */
  onEdit?: (m: ChatMessage) => void
  onRetry?: () => void
  onNewChat?: () => void
  /** "Say more" after the latest answer. */
  onSayMore?: () => void
}

export function ChatMessages({
  messages,
  empty,
  actions,
  chat
}: {
  messages: ChatMessage[]
  empty?: ReactNode
  actions?: OutputActions
  chat?: ChatMessageActions
}): ReactNode {
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // scrollIntoView returns a Promise in recent Chromium; never return it from an effect.
    void end.current?.scrollIntoView({ block: 'end' })
  }, [messages])
  if (messages.length === 0) return <>{empty}</>
  const busy = messages.some((m) => m.status === 'in_progress')
  const last = messages[messages.length - 1]
  return (
    <div className="space-y-4">
      {messages.map((m) => {
        if (m.role === 'user') return <UserMessage key={m.id} message={m} onEdit={busy ? undefined : chat?.onEdit} />
        const cite = (n: number): void => {
          const c = m.citations.find((x) => x.n === n)
          if (c) navigate(`/note/${c.document_id}`)
        }
        const streaming = m.status === 'in_progress'
        const isLast = m === last
        return (
          <div key={m.id} className="max-w-full animate-chat-tool-swap-in">
            {m.outputs.length > 0 ? (
              <AgentOutputs outputs={m.outputs} streaming={streaming} actions={{ ...actions, onCite: cite }} />
            ) : m.content ? (
              <Markdown text={m.content} reveal={streaming ? 'blur-in' : 'none'} className="text-base [&_.prose-heading]:before:hidden" onCite={cite} />
            ) : null}
            {streaming && !m.outputs.some((o) => o.type === 'text') && !m.outputs.some((o) => o.type === 'tool_call' && !o.completed) && <ThinkingIndicator className="mt-1" />}
            {m.status === 'cancelled' && <p className="mt-1 text-sm text-ink-tertiary">Reply stopped.</p>}
            {m.error && (
              <div role="alert" className="mt-2 rounded-xl bg-oats-red-50 px-3.5 py-2.5 text-sm text-oats-red-400 dark:bg-oats-red-400/15 dark:text-oats-red-200" data-testid="chat-error">
                <p>{m.error}</p>
                {isLast && (chat?.onRetry || chat?.onNewChat) && (
                  <div className="mt-2 flex gap-1.5">
                    {chat.onRetry && (
                      <Button size="sm" variant="soft" onClick={chat.onRetry}>
                        <RotateCcw size={12} /> Retry
                      </Button>
                    )}
                    {chat.onNewChat && (
                      <Tooltip content="Try starting a new chat or switching to a different model" side="bottom">
                        <Button size="sm" variant="ghost" onClick={chat.onNewChat}>
                          Start new chat
                        </Button>
                      </Tooltip>
                    )}
                  </div>
                )}
              </div>
            )}
            {m.citations.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.citations.map((c) => (
                  <button
                    key={c.document_id}
                    type="button"
                    onClick={() => navigate(`/note/${c.document_id}`)}
                    className="inline-flex h-6 cursor-default animate-chip-enter items-center gap-1 rounded-full bg-fill-soft px-2 text-xs text-ink-secondary hover:bg-fill-soft-hover hover:text-ink-primary"
                  >
                    <FileText size={12} /> {c.n}. {c.title}
                  </button>
                ))}
              </div>
            )}
            {isLast && m.status === 'completed' && !m.error && chat?.onSayMore && (
              <button
                type="button"
                onClick={chat.onSayMore}
                className="mt-2 inline-flex h-7 cursor-default animate-chip-enter items-center gap-1 rounded-full px-2.5 text-sm text-ink-secondary ring ring-hairline hover:bg-highlight hover:text-ink-primary dark:ring-inset"
              >
                <MessageSquarePlus size={14} /> Say more
              </button>
            )}
          </div>
        )
      })}
      <div ref={end} />
    </div>
  )
}

/**
 * The Assistant's message field. Granola's Assistant has its own plain textarea (its chat bar is the Composer in
 * components/chat): a 20px-rounded field with a hairline shadow at rest and an accent ring when focused. Typing
 * "/" suggests recipes when `recipes` is on. While an answer streams (`onStop` set), the send button stops it.
 */
export function AssistantInput({
  placeholder,
  onSend,
  onStop,
  autoFocus,
  recipes: withRecipes = true,
  className
}: {
  placeholder: string
  onSend: (text: string) => Promise<void> | void
  onStop?: () => void
  autoFocus?: boolean
  recipes?: boolean
  className?: string
}): ReactNode {
  const [text, setText] = useState('')
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [active, setActive] = useState(0)
  const [busy, setBusy] = useState(false)
  const [focused, setFocused] = useState(false)
  const showToast = useApp((s) => s.showToast)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (withRecipes) void call('recipes:list').then(setRecipes)
  }, [withRecipes])

  const slash = text.match(/^\/([a-z0-9-]*)$/i)
  const suggestions = slash ? recipes.filter((r) => r.slug.startsWith(slash[1].toLowerCase()) || r.name.toLowerCase().includes(slash[1].toLowerCase())) : []

  const resize = (el: HTMLTextAreaElement): void => {
    el.style.height = 'auto'
    el.style.height = `${Math.min(240, el.scrollHeight)}px`
  }

  const submit = async (value = text): Promise<void> => {
    if (!value.trim() || busy || onStop) return
    setBusy(true)
    try {
      await onSend(value)
      setText('')
      if (ref.current) {
        ref.current.value = ''
        resize(ref.current)
      }
    } catch (e) {
      showToast('error', errorMessage(e))
    } finally {
      setBusy(false)
      ref.current?.focus()
    }
  }

  return (
    <div className={cn('relative', className)}>
      <AnimatePresence>
        {suggestions.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 2 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute bottom-full left-0 z-30 mb-2 w-full overflow-hidden rounded-xl bg-surface-elevated p-1 shadow-lg ring-[0.5px] ring-hairline dark:ring-inset"
          >
            <div className="px-2 pt-1.5 pb-1 text-xs text-oats-neutral-500 dark:text-oats-neutral-400">Recipes</div>
            {suggestions.map((r, i) => (
              <button
                key={r.id}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => void submit(`/${r.slug}`)}
                className={cn('flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm', i === active && 'bg-oats-off-black-a6 dark:bg-oats-off-white-a6')}
              >
                <WandSparkles size={16} className="text-ink-secondary" />
                <span className="text-ink-primary">{r.name}</span>
                <span className="text-ink-tertiary">/{r.slug}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      <div
        data-testid="assistant-input"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault()
            ref.current?.focus()
          }
        }}
        className={cn(
          'group/chat-input relative flex w-full cursor-text items-end overflow-hidden rounded-[20px] border bg-surface-elevated transition-[border-color,box-shadow]',
          focused
            ? 'border-ink-accent ring-3 ring-ink-accent/20'
            : 'border-transparent shadow-[0px_0px_0px_0.5px_rgba(0,0,0,0.2),0px_4px_6px_-2px_rgba(0,0,0,0.05)] dark:shadow-[0px_0px_0px_0.5px_rgba(255,255,255,0.15),0px_4px_6px_-2px_rgba(0,0,0,0.3)]'
        )}
      >
        <textarea
          ref={ref}
          autoFocus={autoFocus}
          rows={1}
          value={text}
          placeholder={placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => {
            setText(e.target.value)
            setActive(0)
            resize(e.target)
          }}
          onKeyDown={(e) => {
            if (suggestions.length) {
              if (e.key === 'ArrowDown') return void (e.preventDefault(), setActive((a) => Math.min(suggestions.length - 1, a + 1)))
              if (e.key === 'ArrowUp') return void (e.preventDefault(), setActive((a) => Math.max(0, a - 1)))
              if (e.key === 'Enter' || e.key === 'Tab') return void (e.preventDefault(), void submit(`/${suggestions[active].slug}`))
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          className="max-h-[240px] min-h-[45px] flex-1 resize-none bg-transparent py-[13px] pl-5 text-base leading-[19px] text-ink-primary outline-none placeholder:text-ink-tertiary"
        />
        <div className="mr-1.5 mb-[7.5px] flex shrink-0 items-center">
          {onStop ? (
            <button type="button" onClick={onStop} className="flex size-8 cursor-default items-center justify-center rounded-full bg-fill-primary text-ink-primary-inverse hover:bg-fill-primary-hover" aria-label="Stop">
              <Square size={10} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!text.trim() || busy}
              className="flex size-8 cursor-default items-center justify-center rounded-full bg-fill-primary text-ink-primary-inverse transition-opacity hover:bg-fill-primary-hover disabled:opacity-25"
              aria-label="Send"
            >
              {busy ? <Spinner className="size-3.5 border-[1.5px]" /> : <ArrowUp size={16} />}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
