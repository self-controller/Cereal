import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Bot, CalendarClock, ChevronRight, CircleAlert, File, Folder, FolderOpen, MoreHorizontal, Pause, Play, RotateCcw, Sparkles, Square, Trash2 } from 'lucide-react'
import {
  applyAgentEvent,
  TASK_STATUS_LABELS,
  type AgentEventRecord,
  type AgentFileEntry,
  type AgentHome,
  type AgentMessage,
  type AgentRoutine,
  type AgentSkill,
  type AgentThread,
  type AssistantSnapshot
} from '@shared/agent'
import type { ChatCitation } from '@shared/types'
import { call, errorMessage, useEvent } from '../lib/api'
import { navigate } from '../lib/router'
import { dayLabel } from '../lib/format'
import { useApp } from '../store'
import { AgentOutputs, type OutputActions } from '../components/AgentOutputs'
import { AssistantInput } from '../components/Chat'
import { Markdown } from '../components/Markdown'
import { Button, ConfirmDialog, IconButton, Menu, MenuItem } from '../components/oats'
import { ThinkingIndicator } from '../components/Chat'

export type AssistantSection = 'conversation' | 'task' | 'routines' | 'skills' | 'files'

/** Fold a live event into a thread's messages, once (events at or below a message's applied sequence are already in it). */
function foldEvent(messages: AgentMessage[], r: AgentEventRecord): AgentMessage[] {
  const id = 'messageId' in r.event ? r.event.messageId : null
  if (!id) return messages
  return messages.map((m) => (m.id === id && m.run_id === r.run_id && r.sequence > m.applied_sequence ? { ...m, outputs: applyAgentEvent(m.outputs, r.event), applied_sequence: r.sequence } : m))
}

function upsertMessage(list: AgentMessage[], m: AgentMessage): AgentMessage[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i < 0) return [...list, m].sort((a, b) => a.sequence - b.sequence)
  // A stored copy may be behind what live events already showed; keep whichever is further along.
  if (m.status === 'in_progress' && list[i].applied_sequence > m.applied_sequence) return list
  return list.map((x) => (x.id === m.id ? m : x))
}

/** Messages of one thread, kept live from the Assistant's events (Keto's thread.read + keto-socket stream). */
function useThread(threadId: string | null): { messages: AgentMessage[]; thread: AgentThread | null; reload: () => void } {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [thread, setThread] = useState<AgentThread | null>(null)
  const showToast = useApp((s) => s.showToast)
  const load = useCallback(() => {
    if (!threadId) return
    void call('assistant:thread', threadId)
      .then(async ({ thread, messages }) => {
        setThread(thread)
        setMessages(messages)
        // Catch up on any run still streaming into this thread.
        for (const m of messages) {
          if (m.status !== 'in_progress' || !m.run_id) continue
          const missed = await call('agent:events', m.run_id, m.applied_sequence)
          setMessages((list) => missed.reduce(foldEvent, list))
        }
      })
      .catch((e) => showToast('error', errorMessage(e)))
  }, [threadId, showToast])
  useEffect(() => {
    setMessages([])
    setThread(null)
    load()
  }, [load])
  useEvent('agent:event', (r) => {
    if (r.thread_id === threadId) setMessages((list) => foldEvent(list, r))
  })
  useEvent('assistant:message', (m) => {
    if (m.thread_id === threadId) setMessages((list) => upsertMessage(list, m))
  })
  useEvent('assistant:thread', (t) => {
    if (t.id === threadId) setThread(t)
  })
  return { messages, thread, reload: load }
}

export function AssistantView({ section, taskId }: { section: AssistantSection; taskId?: string }): ReactNode {
  const [snap, setSnap] = useState<AssistantSnapshot | null>(null)
  const [tasks, setTasks] = useState<AgentThread[]>([])
  const [home, setHome] = useState<AgentHome | null>(null)
  const { settings, setSettings, showToast } = useApp()
  const [confirmReset, setConfirmReset] = useState(false)

  const refresh = useCallback(() => {
    void call('assistant:open').then((s) => {
      setSnap(s)
      setTasks(s.tasks)
      setHome(s.home)
    })
  }, [])
  useEffect(refresh, [refresh])
  useEvent('assistant:thread', (t) => {
    if (t.kind === 'task') setTasks((list) => (list.some((x) => x.id === t.id) ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list]))
  })
  useEvent('assistant:home', setHome)

  if (!snap || !settings) return <div className="h-full" />

  if (!settings.assistant.enabled) {
    return (
      <div className="flex h-full items-center justify-center pt-11">
        <div className="max-w-sm text-center">
          <Bot size={26} className="mx-auto text-ink-accent" />
          <h1 className="mt-4 text-h2">The Assistant is off</h1>
          <p className="mt-2 text-sm text-ink-secondary">Turn it on to hand Cereal multi-step work: research across your meetings, follow-ups, meeting prep and routines.</p>
          <Button size="lg" className="mt-5" onClick={() => void call('settings:update', { assistant: { enabled: true } }).then(setSettings)}>
            Turn on the Assistant
          </Button>
        </div>
      </div>
    )
  }

  const taskMap = Object.fromEntries(tasks.map((t) => [t.id, t]))
  return (
    <div className="flex h-full pt-11">
      <TaskSidebar
        section={section}
        taskId={taskId}
        tasks={tasks}
        home={home}
        onReset={() => setConfirmReset(true)}
      />
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Start a new conversation?"
        description="Current tasks are archived; memory, skills and routines stay."
        confirmLabel="Start new conversation"
        onConfirm={async () => {
          try {
            const s = await call('assistant:reset')
            setSnap(s)
            setTasks(s.tasks)
            setHome(s.home)
            navigate('/assistant')
          } catch (e) {
            showToast('error', errorMessage(e))
          }
        }}
      />
      <div className="min-w-0 flex-1">
        {section === 'conversation' && <ThreadPane key={snap.conversation.id} threadId={snap.conversation.id} tasks={taskMap} />}
        {section === 'task' && taskId && <ThreadPane key={taskId} threadId={taskId} tasks={taskMap} />}
        {section === 'routines' && <RoutinesPane />}
        {section === 'skills' && <SkillsPane />}
        {section === 'files' && <FilesPane />}
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- sidebar

const STATUS_DOT: Record<string, string> = {
  active: 'bg-ink-accent motion-safe:animate-pulse',
  needs_input: 'bg-amber-500',
  done: 'bg-ink-success',
  failed: 'bg-fill-danger',
  cancelled: 'bg-ink-tertiary'
}

function TaskRow({ task, active }: { task: AgentThread; active: boolean }): ReactNode {
  return (
    <button
      onClick={() => navigate(`/assistant/task/${task.id}`)}
      className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${active ? 'bg-highlight' : 'hover:bg-highlight'}`}
    >
      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${STATUS_DOT[task.status ?? 'active']}`} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{task.title ?? 'Task'}</span>
        <span className="block truncate text-xs text-ink-tertiary">
          {task.status ? TASK_STATUS_LABELS[task.status] : ''} · {dayLabel(task.updated_at)}
        </span>
      </span>
    </button>
  )
}

function TaskSidebar({ section, taskId, tasks, home, onReset }: { section: AssistantSection; taskId?: string; tasks: AgentThread[]; home: AgentHome | null; onReset: () => void }): ReactNode {
  const groups = useMemo(() => {
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]))
    const placed = new Set<string>()
    const out: { title: string; tasks: AgentThread[] }[] = []
    for (const g of home?.groups ?? []) {
      const list = g.taskIds.map((id) => byId[id]).filter(Boolean)
      list.forEach((t) => placed.add(t.id))
      if (list.length) out.push({ title: g.title, tasks: list })
    }
    const rest = tasks.filter((t) => !placed.has(t.id))
    const needs = rest.filter((t) => t.status === 'needs_input')
    const working = rest.filter((t) => t.status === 'active')
    const done = rest.filter((t) => t.status === 'done')
    const stopped = rest.filter((t) => t.status === 'failed' || t.status === 'cancelled')
    if (needs.length) out.unshift({ title: 'Needs you', tasks: needs })
    if (working.length) out.push({ title: 'In progress', tasks: working })
    if (done.length) out.push({ title: 'Completed', tasks: done })
    if (stopped.length) out.push({ title: 'Stopped or failed', tasks: stopped })
    return out
  }, [tasks, home])

  const nav = (id: AssistantSection, label: string, icon: ReactNode, path: string): ReactNode => (
    <button
      onClick={() => navigate(path)}
      className={`flex h-7 w-full items-center gap-2 rounded-lg px-2 text-sm transition-colors ${section === id ? 'bg-highlight text-ink-primary' : 'text-ink-secondary hover:bg-highlight hover:text-ink-primary'}`}
    >
      <span className="flex w-4 justify-center">{icon}</span>
      {label}
    </button>
  )

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r">
      <div className="flex h-9 shrink-0 items-center justify-between pr-2 pl-4">
        <span className="text-sm font-medium">Assistant</span>
        <Menu
          align="end"
          trigger={
            <IconButton size="sm" label="More">
              <MoreHorizontal size={16} />
            </IconButton>
          }
        >
          <MenuItem onClick={onReset}>
            <RotateCcw size={16} /> New conversation
          </MenuItem>
        </Menu>
      </div>
      <div className="space-y-px px-2">
        {nav('conversation', 'Conversation', <Bot size={14} />, '/assistant')}
        {nav('routines', 'Routines', <CalendarClock size={14} />, '/assistant/routines')}
        {nav('skills', 'Skills', <Sparkles size={14} />, '/assistant/skills')}
        {nav('files', 'Memory & files', <FolderOpen size={14} />, '/assistant/files')}
      </div>
      <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {home?.briefing && (
          <div className="mb-4 rounded-xl bg-surface-elevated px-3 py-2.5 ring-1 ring-hairline">
            <Markdown text={home.briefing} className="text-sm leading-relaxed [&_.prose-heading]:before:hidden" />
          </div>
        )}
        {groups.length === 0 && <p className="px-2 text-xs leading-relaxed text-ink-tertiary">Tasks will appear here as the Assistant works. Ask it to research something, prepare for a meeting or draft follow-ups.</p>}
        {groups.map((g) => (
          <section key={g.title} className="mb-3">
            <div className="px-2 pb-1 text-xs text-ink-tertiary">
              {g.title} · {g.tasks.length}
            </div>
            {g.tasks.map((t) => (
              <TaskRow key={t.id} task={t} active={section === 'task' && taskId === t.id} />
            ))}
          </section>
        ))}
      </div>
    </aside>
  )
}

// ------------------------------------------------------------------ thread

function ThreadPane({ threadId, tasks }: { threadId: string; tasks: Record<string, AgentThread> }): ReactNode {
  const { messages, thread } = useThread(threadId)
  const showToast = useApp((s) => s.showToast)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void end.current?.scrollIntoView({ block: 'end' })
  }, [messages])
  const isTask = thread?.kind === 'task'
  const busy = messages.some((m) => m.status === 'in_progress')
  // Citation numbers are per thread; refresh them as answers come in.
  const [sources, setSources] = useState<ChatCitation[]>([])
  const settled = messages.filter((m) => m.status !== 'in_progress').length
  useEffect(() => void call('agent:sources', threadId).then(setSources), [threadId, settled])
  const actions: OutputActions = {
    tasks,
    onCite: (n) => {
      const s = sources.find((x) => x.n === n)
      if (s) navigate(`/note/${s.document_id}`)
    }
  }

  const send = async (text: string): Promise<void> => {
    await call('assistant:send', { threadId: isTask ? threadId : null, text, clientMessageId: crypto.randomUUID() })
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-4">
        {isTask && (
          <IconButton label="Back to the conversation" onClick={() => navigate('/assistant')}>
            <ArrowLeft size={16} />
          </IconButton>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{isTask ? thread?.title : 'Conversation'}</span>
        {isTask && thread?.status && <span className="text-xs text-ink-tertiary">{TASK_STATUS_LABELS[thread.status]}</span>}
        {isTask && (thread?.status === 'active' || thread?.status === 'needs_input') && (
          <Button size="sm" variant="ghost" onClick={() => void call('assistant:task-stop', threadId).catch((e) => showToast('error', errorMessage(e)))}>
            <Square size={10} fill="currentColor" /> Stop task
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl px-8 py-8">
          {messages.length === 0 && !isTask && (
            <div className="pt-[8vh] text-center">
              <Bot size={26} className="mx-auto text-ink-accent" />
              <h1 className="mt-4 text-h1">Your Assistant</h1>
              <p className="mx-auto mt-3 max-w-md text-sm text-ink-secondary">
                Hand it work and it runs tasks in the background: research across meetings, follow-up drafts, meeting prep, recurring summaries. It remembers what you tell it.
              </p>
            </div>
          )}
          <div className="space-y-5">
            {messages.map((m) => (
              <MessageView key={m.id} message={m} actions={actions} />
            ))}
          </div>
          <div ref={end} />
        </div>
      </div>
      <div className="mx-auto w-full max-w-2xl px-8 pb-6">
        <AssistantInput
          autoFocus
          recipes={false}
          placeholder={isTask ? 'Message this task…' : 'Ask your Assistant to do something…'}
          onSend={send}
          onStop={busy ? () => void call('assistant:stop', threadId) : undefined}
        />
      </div>
    </div>
  )
}

function MessageView({ message: m, actions }: { message: AgentMessage; actions: OutputActions }): ReactNode {
  if (m.author === 'user') {
    return (
      <div className="flex justify-end">
        <div className="selectable max-w-[85%] rounded-2xl rounded-br-md bg-fill-highlight px-3.5 py-2 text-base leading-relaxed whitespace-pre-wrap">{m.text}</div>
      </div>
    )
  }
  if (m.author === 'parent') {
    return (
      <div className="rounded-2xl bg-fill-highlight px-4 py-3">
        <div className="mb-1 text-xs text-ink-tertiary">From the conversation</div>
        <Markdown text={m.text} className="text-sm [&_.prose-heading]:before:hidden" />
      </div>
    )
  }
  const streaming = m.status === 'in_progress'
  return (
    <div>
      {m.outputs.length > 0 && <AgentOutputs outputs={m.outputs} streaming={streaming} actions={actions} />}
      {streaming && !m.outputs.some((o) => o.type === 'text' || (o.type === 'tool_call' && !o.completed)) && (
        <ThinkingIndicator text="Working…" className="mt-1" />
      )}
      {m.status === 'cancelled' && <p className="mt-1 text-sm text-ink-tertiary">Stopped.</p>}
      {m.error && (
        <p className="mt-1 inline-flex items-start gap-1.5 text-sm text-ink-danger">
          <CircleAlert size={13} className="mt-0.5 shrink-0" /> {m.error}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- routines

function RoutinesPane(): ReactNode {
  const [routines, setRoutines] = useState<AgentRoutine[] | null>(null)
  const [deleting, setDeleting] = useState<AgentRoutine | null>(null)
  const showToast = useApp((s) => s.showToast)
  const load = useCallback(() => void call('assistant:routines').then(setRoutines), [])
  useEffect(load, [load])
  useEvent('assistant:routines-changed', load)
  return (
    <Pane title="Routines" description="Things the Assistant does on a schedule. Ask it to create one, like “every Monday at 9, summarise last week's meetings”.">
      {routines?.length === 0 && <p className="text-sm text-ink-tertiary">No routines yet.</p>}
      <div className="space-y-2">
        {routines?.map((r) => (
          <div key={r.id} className="rounded-2xl bg-surface-elevated p-4 ring-1 ring-hairline">
            <div className="flex items-center gap-2">
              <CalendarClock size={14} className="text-ink-accent" />
              <span className="flex-1 text-sm font-medium">{r.description}</span>
              <IconButton
                label={r.enabled ? 'Pause' : 'Resume'}
                onClick={() => void call('assistant:routine-update', r.id, { enabled: !r.enabled }).catch((e) => showToast('error', errorMessage(e)))}
              >
                {r.enabled ? <Pause size={14} /> : <Play size={14} />}
              </IconButton>
              <IconButton label="Delete" onClick={() => setDeleting(r)}>
                <Trash2 size={14} />
              </IconButton>
            </div>
            <p className="mt-1.5 text-sm whitespace-pre-wrap text-ink-secondary">{r.message}</p>
            <p className="mt-1.5 text-xs text-ink-tertiary">
              {r.enabled ? (r.next_fire_at ? `Next: ${new Date(r.next_fire_at).toLocaleString()}` : 'Finished') : 'Paused'}
              {r.last_fired_at && ` · Last ran ${new Date(r.last_fired_at).toLocaleString()}`} · {r.timezone}
            </p>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this routine?"
        confirmLabel="Delete"
        danger
        onConfirm={() => deleting && void call('assistant:routine-delete', deleting.id)}
      />
    </Pane>
  )
}

// ------------------------------------------------------------------ skills

function SkillsPane(): ReactNode {
  const [data, setData] = useState<{ skills: AgentSkill[]; errors: { path: string; message: string }[] } | null>(null)
  const showToast = useApp((s) => s.showToast)
  useEffect(() => void call('assistant:skills').then(setData), [])
  return (
    <Pane
      title="Skills"
      description="Playbooks the Assistant (and chat) load when a task calls for them: one folder per skill in skills/, each with a SKILL.md that starts with a name and a description. Ask the Assistant to write one, or edit them yourself."
      action={
        <Button size="sm" variant="soft" onClick={() => void call('assistant:open-folder', 'skills').catch((e) => showToast('error', errorMessage(e)))}>
          <FolderOpen size={13} /> Open skills folder
        </Button>
      }
    >
      <div className="space-y-2">
        {data?.skills.length === 0 && <p className="text-sm text-ink-tertiary">No skills yet.</p>}
        {data?.skills.map((s) => (
          <div key={s.name} className="rounded-2xl bg-surface-elevated p-4 ring-1 ring-hairline">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Sparkles size={14} className="text-ink-accent" /> {s.name}
            </div>
            <p className="mt-1 text-sm text-ink-secondary">{s.description}</p>
          </div>
        ))}
        {data?.errors.map((e) => (
          <div key={e.path} className="flex items-start gap-2 rounded-xl px-3 py-2 text-xs text-ink-danger ring-1 ring-ink-danger/25">
            <CircleAlert size={13} className="mt-0.5 shrink-0" />
            <span>
              <code className="font-mono">{e.path}</code>: {e.message}
            </span>
          </div>
        ))}
      </div>
    </Pane>
  )
}

// ------------------------------------------------------------------- files

function FilesPane(): ReactNode {
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<AgentFileEntry[]>([])
  const [open, setOpen] = useState<{ path: string; content: string; truncated: boolean } | null>(null)
  const showToast = useApp((s) => s.showToast)
  const load = useCallback(() => {
    void call('assistant:files', path)
      .then(setEntries)
      .catch((e) => showToast('error', errorMessage(e)))
  }, [path, showToast])
  useEffect(load, [load])
  useEvent('agent:event', (r) => {
    if (r.event.type === 'memory_changed') load()
  })
  const crumbs = path === '.' ? [] : path.split('/')
  return (
    <Pane
      title="Memory & files"
      description="The Assistant's own folder. memory/MEMORY.md is what it knows about you; it can only read and write inside this folder, and asks before writing outside memory/."
      action={
        <Button size="sm" variant="soft" onClick={() => void call('assistant:open-folder', path === '.' ? undefined : path).catch((e) => showToast('error', errorMessage(e)))}>
          <FolderOpen size={13} /> Open folder
        </Button>
      }
    >
      <div className="mb-2 flex items-center gap-1 text-sm text-ink-secondary">
        <button className="hover:text-ink-primary" onClick={() => (setPath('.'), setOpen(null))}>
          agent
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight size={12} className="text-ink-tertiary" />
            <button className="hover:text-ink-primary" onClick={() => (setPath(crumbs.slice(0, i + 1).join('/')), setOpen(null))}>
              {c}
            </button>
          </span>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl bg-surface-elevated ring-1 ring-hairline">
        {entries.length === 0 && <p className="px-4 py-3 text-sm text-ink-tertiary">This folder is empty.</p>}
        {entries.map((e) => (
          <button
            key={e.path}
            onClick={() => {
              if (e.dir) {
                setPath(e.path)
                setOpen(null)
              } else void call('assistant:file-read', e.path).then((r) => setOpen({ path: e.path, ...r }))
            }}
            className={`flex w-full items-center gap-2 border-b border-hairline px-4 py-2 text-left text-sm last:border-b-0 hover:bg-surface-sunken ${open?.path === e.path ? 'bg-highlight' : ''}`}
          >
            {e.dir ? <Folder size={14} className="text-ink-accent" /> : <File size={14} className="text-ink-tertiary" />}
            <span className="flex-1 truncate">{e.name}</span>
            {!e.dir && <span className="text-xs text-ink-tertiary">{e.size < 1024 ? `${e.size} B` : `${Math.round(e.size / 1024)} KB`}</span>}
          </button>
        ))}
      </div>
      {open && (
        <div className="mt-4 rounded-2xl bg-surface-elevated p-4 ring-1 ring-hairline">
          <div className="mb-2 font-mono text-xs text-ink-tertiary">{open.path}</div>
          {/\.md$/i.test(open.path) ? (
            <Markdown text={open.content} className="text-sm" />
          ) : (
            <pre className="selectable font-mono text-xs whitespace-pre-wrap">{open.content}</pre>
          )}
          {open.truncated && <p className="mt-2 text-xs text-ink-tertiary">Showing the start of the file.</p>}
        </div>
      )}
    </Pane>
  )
}

function Pane({ title, description, action, children }: { title: string; description: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 pt-12 pb-10">
        <div className="mb-6 flex items-start gap-4">
          <div className="flex-1">
            <h1 className="text-h2">{title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink-secondary">{description}</p>
          </div>
          {action}
        </div>
        {children}
      </div>
    </div>
  )
}
