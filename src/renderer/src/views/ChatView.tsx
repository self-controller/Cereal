import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, History, MessageSquare, SquarePen, Trash2 } from 'lucide-react'
import { SAMPLE_QUESTIONS } from '@shared/chatbar'
import type { ChatThread } from '@shared/types'
import { call, useEvent } from '../lib/api'
import { navigate } from '../lib/router'
import { dayLabel } from '../lib/format'
import { useApp } from '../store'
import { ChatMessages, streamingMessage, useThreadMessages } from '../components/Chat'
import { Composer, type ComposerHandle, type ComposerSend } from '../components/chat/Composer'
import { useChatShortcuts, useSuggestedRecipes } from '../components/FloatingChat'
import { Button, Menu, MenuItem, MenuLabel, Tooltip, cn } from '../components/oats'
import { ToolbarContent } from '../components/shell/Toolbar'

/** Chat across all notes with retrieval and citations: Granola's full-page chat (docs/granola-chat-bar.md §8). */
export function ChatView({ threadId }: { threadId?: string }): ReactNode {
  const [threads, setThreads] = useState<ChatThread[]>([])
  const name = useApp((s) => s.settings?.profile.name?.split(' ')[0])
  const messages = useThreadMessages(threadId ?? null)
  const streaming = streamingMessage(messages)
  const composer = useRef<ComposerHandle>(null)
  const recipes = useSuggestedRecipes(6)
  // A sample question as the placeholder, picked once per visit.
  const sample = useMemo(() => SAMPLE_QUESTIONS[Math.floor(Math.random() * SAMPLE_QUESTIONS.length)], [])

  const refresh = (): void => void call('chat:threads', null).then(setThreads)
  useEffect(() => {
    refresh()
  }, [threadId])
  useEvent('chat:message', (m) => {
    if (!threads.some((t) => t.id === m.thread_id)) refresh()
  })
  useEvent('chat:thread', (t) => {
    if (!t.document_id) setThreads((list) => list.map((x) => (x.id === t.id ? t : x)))
  })
  useChatShortcuts({ onToggle: () => composer.current?.focus(), onNewChat: () => navigate('/chat') })

  const send = async (req: ComposerSend): Promise<void> => {
    const res = await call('chat:send', { ...req, threadId: threadId ?? null, documentId: null })
    if (res.threadId !== threadId) navigate(`/chat/${res.threadId}`)
  }

  const chatActions = {
    onEdit: (m: Parameters<ComposerHandle['edit']>[0]) => composer.current?.edit(m),
    onRetry: () => threadId && void call('chat:retry', threadId),
    onNewChat: () => navigate('/chat'),
    onSayMore: () => void send({ text: 'Can you provide more details', responseStyle: 'detailed' })
  }

  const composerEl = (
    <Composer
      ref={composer}
      autoFocus
      surface="global"
      documentId={null}
      threadId={threadId ?? null}
      variant="compact"
      modelScope="multi"
      placeholder={messages.length === 0 ? sample : undefined}
      streaming={streaming}
      hasMessages={messages.length > 0}
      shortcuts
      onSend={send}
      onStop={() => streaming && void call('chat:stop', streaming.id)}
      onEscape={() => (messages.length ? undefined : window.history.length > 1 ? window.history.back() : navigate('/'))}
    />
  )

  return (
    <div className="@container/chat relative flex h-full w-full flex-col overflow-hidden bg-surface select-none">
      <ToolbarContent>
        <Menu
          trigger={
            <button type="button" aria-label="Recent chats" className="no-drag ml-1 flex h-7 cursor-default items-center gap-1.5 rounded-full px-2 text-sm text-ink-primary transition-colors duration-75 outline-none hover:bg-highlight data-popup-open:bg-highlight">
              <History size={16} className="text-ink-secondary" />
              <span>History</span>
              <ChevronDown size={16} className="-ml-1 text-ink-tertiary" />
            </button>
          }
        >
          <MenuLabel>Recent chats</MenuLabel>
          {threads.length === 0 && <div className="px-2 py-1.5 text-sm text-ink-tertiary">No chats yet</div>}
          {threads.map((t) => (
            <MenuItem key={t.id} onClick={() => navigate(`/chat/${t.id}`)} className={cn('group/thread', t.id === threadId && 'bg-oats-off-black-a6 dark:bg-oats-off-white-a6')}>
              <span className="min-w-0 flex-1 truncate">{t.title || 'Chat'}</span>
              <span className="shrink-0 text-xs text-ink-tertiary group-data-[highlighted]/thread:hidden">{dayLabel(t.updated_at)}</span>
              <span
                role="button"
                aria-label="Delete chat"
                onClick={async (e) => {
                  e.stopPropagation()
                  await call('chat:delete-thread', t.id)
                  if (t.id === threadId) navigate('/chat')
                  refresh()
                }}
                className="hidden size-5 items-center justify-center rounded text-ink-tertiary group-data-[highlighted]/thread:flex hover:text-ink-danger"
              >
                <Trash2 size={14} />
              </span>
            </MenuItem>
          ))}
        </Menu>
        <div className="flex-1" />
        <Tooltip content="New chat" kbd="Ctrl N">
          <Button variant="outline" className="gap-1 pl-2.5" onClick={() => navigate('/chat')} disabled={!threadId}>
            <SquarePen size={16} className="text-ink-secondary" />
            New chat
          </Button>
        </Tooltip>
      </ToolbarContent>

      {messages.length === 0 ? (
        <div className="selectable min-h-0 flex-1 overflow-y-auto pt-11">
          <div className="mx-auto flex w-full max-w-2xl flex-col px-6 pb-8">
            <h1 className="mb-6 px-2 pt-[120px] text-h3 text-ink-primary">{name ? `Hi ${name}, ask anything` : 'Ask anything'}</h1>
            {composerEl}
            {recipes.length > 0 && (
              <div className="mt-6 px-2">
                <div className="mb-2 flex items-center text-xs text-ink-tertiary">
                  <span className="flex-1">Recipes</span>
                  <button type="button" onClick={() => navigate('/recipes')} className="cursor-default hover:text-ink-primary">
                    See all
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {recipes.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => void send({ text: `/${r.slug}` })}
                      className="h-8 cursor-default animate-fade-in rounded-full px-3 text-sm text-ink-secondary ring ring-hairline transition-colors hover:bg-highlight hover:text-ink-primary dark:ring-inset"
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {threads.length > 0 && (
              <div className="mt-8 px-1">
                <div className="mb-1 px-1 text-xs text-ink-tertiary">Recent chats</div>
                {threads.slice(0, 5).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => navigate(`/chat/${t.id}`)}
                    className="flex w-full cursor-default items-center gap-2 rounded-xl px-2 py-[7px] text-left text-sm hover:bg-highlight-faint"
                  >
                    <MessageSquare size={16} className="shrink-0 text-ink-tertiary" />
                    <span className="min-w-0 flex-1 truncate text-ink-primary">{t.title || 'Chat'}</span>
                    <span className="shrink-0 text-xs text-ink-tertiary">{dayLabel(t.updated_at)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="selectable min-h-0 flex-1 overflow-y-auto pt-11">
            <div className="mx-auto w-full max-w-2xl px-4 pb-8">
              <ChatMessages messages={messages} chat={chatActions} />
            </div>
          </div>
          <div className="relative z-20 shrink-0">
            <div className="mx-auto w-full max-w-2xl px-2 pb-4">{composerEl}</div>
          </div>
        </>
      )}
    </div>
  )
}
