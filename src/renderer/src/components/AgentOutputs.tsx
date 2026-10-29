import { useState, type ReactNode } from 'react'
import { CalendarPlus, Check, ChevronRight, CircleAlert, Copy, ExternalLink, Mail, PenLine, Redo2, ShieldQuestion, Sparkles, Undo2, Workflow } from 'lucide-react'
import { TASK_STATUS_LABELS, type AgentOutput, type AgentThread, type ToolCallOutput } from '@shared/agent'
import { call, errorMessage } from '../lib/api'
import { navigate } from '../lib/router'
import { useApp } from '../store'
import { Markdown } from './Markdown'
import { Button, Spinner } from './oats'

// What an agent message shows, in order: its reasoning (collapsed), runs of tool activity ("Searched meetings ·
// Read meetings"), cards for tools the user acts on (drafts, note edits, approvals, tasks) and the answer text.

export interface OutputActions {
  onCite?: (n: number) => void
  /** Undo or reapply a note edit (note chat). */
  onRevertEdit?: (call: ToolCallOutput, undo: boolean) => void
  /** Live state of tasks, keyed by id, for task cards. */
  tasks?: Record<string, AgentThread>
}

/** Tools shown as their own card rather than in an activity row. */
const CARD_TOOLS = new Set(['draftEmail', 'draftCalendarEvent', 'editMeetingNotes', 'rewriteMeetingNotes', 'startTask', 'publishResult'])

type Item = { kind: 'output'; output: AgentOutput; key: string } | { kind: 'activity'; calls: ToolCallOutput[]; key: string }

function group(outputs: AgentOutput[]): Item[] {
  const items: Item[] = []
  outputs.forEach((o, i) => {
    const plain = o.type === 'tool_call' && !CARD_TOOLS.has(o.name) && o.approval?.status !== 'pending'
    const last = items[items.length - 1]
    if (plain && last?.kind === 'activity') last.calls.push(o)
    else if (plain) items.push({ kind: 'activity', calls: [o], key: o.id })
    else items.push({ kind: 'output', output: o, key: o.type === 'tool_call' ? o.id : `${o.type}-${i}` })
  })
  return items
}

export function AgentOutputs({ outputs, streaming, actions = {} }: { outputs: AgentOutput[]; streaming?: boolean; actions?: OutputActions }): ReactNode {
  const items = group(outputs)
  return (
    <div className="space-y-2.5">
      {items.map((item, i) => {
        if (item.kind === 'activity') return <ActivityRow key={item.key} calls={item.calls} />
        const o = item.output
        if (o.type === 'text')
          return <Markdown key={item.key} text={o.text} reveal={streaming && i === items.length - 1 ? 'blur-in' : 'none'} onCite={actions.onCite} className="text-base [&_.prose-heading]:before:hidden" />
        if (o.type === 'reasoning') return <Reasoning key={item.key} text={o.text} live={!!streaming && i === items.length - 1} />
        return <ToolCard key={item.key} call={o} actions={actions} />
      })}
    </div>
  )
}

function Reasoning({ text, live }: { text: string; live: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return null
  return (
    <div className="text-sm text-ink-tertiary">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 transition-colors hover:text-ink-secondary">
        <ChevronRight size={13} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
        {live ? <span className="shimmer-text">Thinking…</span> : 'Thought about it'}
      </button>
      {open && <div className="selectable mt-1 border-l-2 border-hairline pl-3 whitespace-pre-wrap">{text}</div>}
    </div>
  )
}

/** A one-line hint of what a call was about. */
function argHint(c: ToolCallOutput): string {
  const a = c.args as Record<string, unknown>
  if (typeof a.query === 'string' && a.query) return `“${a.query}”`
  if (Array.isArray(a.meeting_ids)) return `${a.meeting_ids.length} meeting${a.meeting_ids.length === 1 ? '' : 's'}`
  if (typeof a.path === 'string') return a.path
  if (typeof a.time_range === 'string') return a.time_range.replace(/_/g, ' ')
  if (typeof a.name === 'string') return a.name
  if (typeof a.title === 'string') return a.title
  return ''
}

function resultHint(c: ToolCallOutput): string {
  if (c.error) return c.error
  const r = c.result as { count?: number; total?: number } | undefined
  if (r && typeof r.count === 'number') return `${r.count} result${r.count === 1 ? '' : 's'}`
  return ''
}

function ActivityRow({ calls }: { calls: ToolCallOutput[] }): ReactNode {
  const [open, setOpen] = useState(false)
  const running = calls.some((c) => !c.completed)
  const failed = calls.some((c) => c.error)
  // "Searched meetings ×2 · Read meetings"
  const counts = new Map<string, number>()
  for (const c of calls) counts.set(c.label, (counts.get(c.label) ?? 0) + 1)
  const summary = [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(' · ')
  return (
    <div className="text-sm">
      <button onClick={() => setOpen((o) => !o)} className="inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 text-ink-secondary transition-colors hover:text-ink-primary">
        {running ? <Spinner className="size-3 text-ink-accent" /> : failed ? <CircleAlert size={13} className="text-ink-danger" /> : <Check size={13} className="text-ink-tertiary" />}
        <span className={`truncate ${running ? 'shimmer-text' : ''}`}>{summary}</span>
        <ChevronRight size={13} className={`shrink-0 text-ink-tertiary transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="mt-1 ml-1.5 space-y-0.5 border-l-2 border-hairline pl-3 text-xs">
          {calls.map((c) => (
            <div key={c.id} className="flex gap-2">
              <span className="shrink-0 text-ink-secondary">{c.label}</span>
              <span className="min-w-0 truncate text-ink-tertiary">{argHint(c)}</span>
              <span className={`ml-auto shrink-0 ${c.error ? 'text-ink-danger' : 'text-ink-tertiary'}`} title={c.error}>
                {resultHint(c).slice(0, 80)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Card({ icon, title, right, children }: { icon: ReactNode; title: ReactNode; right?: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <div className="animate-chat-tool-swap-in rounded-2xl bg-surface-elevated p-3.5 ring ring-hairline dark:ring-inset">
      <div className="flex items-center gap-2 text-sm">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-surface-tint-accent text-ink-accent-strong">{icon}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {right}
      </div>
      {children && <div className="mt-2.5">{children}</div>}
    </div>
  )
}

function ToolCard({ call: c, actions }: { call: ToolCallOutput; actions: OutputActions }): ReactNode {
  if (c.approval?.status === 'pending') return <ApprovalCard call={c} />
  if (!c.completed) {
    return (
      <div className="inline-flex items-center gap-1.5 text-sm text-ink-secondary">
        <Spinner className="size-3 text-ink-accent" /> <span className="shimmer-text">{c.label}…</span>
      </div>
    )
  }
  if (c.error) {
    return (
      <div className="inline-flex items-start gap-1.5 text-sm text-ink-secondary">
        <CircleAlert size={13} className="mt-0.5 shrink-0 text-ink-danger" />
        <span>
          {c.label}: <span className="text-ink-danger">{c.approval?.status === 'denied' ? 'declined' : c.error}</span>
        </span>
      </div>
    )
  }
  switch (c.name) {
    case 'draftEmail':
      return <EmailDraftCard draft={c.result as EmailDraft} />
    case 'draftCalendarEvent':
      return <CalendarDraftCard draft={c.result as CalendarDraft} />
    case 'editMeetingNotes':
      return <EditCard call={c} onRevert={actions.onRevertEdit} />
    case 'rewriteMeetingNotes':
      return <Card icon={<Sparkles size={13} />} title="Rewriting your enhanced notes in a new tab" />
    case 'startTask':
      return <TaskCard taskId={(c.result as { taskThreadId: string }).taskThreadId} title={String(c.args.title ?? 'Task')} task={actions.tasks?.[(c.result as { taskThreadId: string }).taskThreadId]} />
    case 'publishResult':
      return <ResultCard args={c.args as { status: 'done' | 'needs_input' | 'failed'; summary: string; text: string }} onCite={actions.onCite} />
    default:
      return null
  }
}

function useCopy(): (text: string) => void {
  const showToast = useApp((s) => s.showToast)
  return (text) => {
    void navigator.clipboard.writeText(text)
    showToast('info', 'Copied')
  }
}

interface EmailDraft {
  to: string[]
  cc: string[]
  subject: string
  body: string
}

function EmailDraftCard({ draft }: { draft: EmailDraft }): ReactNode {
  const copy = useCopy()
  const mailto = `mailto:${draft.to.map(encodeURIComponent).join(',')}?${new URLSearchParams({ ...(draft.cc.length ? { cc: draft.cc.join(',') } : {}), subject: draft.subject, body: draft.body }).toString().replace(/\+/g, '%20')}`
  return (
    <Card icon={<Mail size={13} />} title="Email draft">
      <div className="space-y-0.5 text-xs text-ink-secondary">
        <div>
          <span className="text-ink-tertiary">To </span>
          {draft.to.join(', ') || <span className="text-ink-tertiary italic">add recipients</span>}
          {draft.cc.length > 0 && <span className="text-ink-tertiary"> · Cc {draft.cc.join(', ')}</span>}
        </div>
        <div className="font-medium text-ink-primary">{draft.subject}</div>
      </div>
      <div className="selectable mt-2 max-h-64 overflow-y-auto rounded-xl bg-fill-highlight px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap">{draft.body}</div>
      <div className="mt-2.5 flex gap-1.5">
        <Button size="sm" variant="soft" onClick={() => copy(`Subject: ${draft.subject}\n\n${draft.body}`)}>
          <Copy size={12} /> Copy
        </Button>
        <Button size="sm" variant="soft" onClick={() => void call('app:open-external', mailto)}>
          <ExternalLink size={12} /> Open in mail app
        </Button>
      </div>
    </Card>
  )
}

interface CalendarDraft {
  title: string
  start: string
  end: string
  attendees: string[]
  location: string
  description: string
  url: string
}

function CalendarDraftCard({ draft }: { draft: CalendarDraft }): ReactNode {
  const copy = useCopy()
  const start = new Date(draft.start)
  const end = new Date(draft.end)
  const when = `${start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}–${end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
  return (
    <Card icon={<CalendarPlus size={13} />} title={draft.title}>
      <div className="space-y-0.5 text-xs text-ink-secondary">
        <div>{when}</div>
        {draft.attendees.length > 0 && <div className="text-ink-tertiary">With {draft.attendees.join(', ')}</div>}
        {draft.location && <div className="text-ink-tertiary">{draft.location}</div>}
        {draft.description && <div className="selectable mt-1.5 whitespace-pre-wrap text-ink-primary">{draft.description}</div>}
      </div>
      <div className="mt-2.5 flex gap-1.5">
        <Button size="sm" variant="soft" onClick={() => void call('app:open-external', draft.url)}>
          <ExternalLink size={12} /> Open in Google Calendar
        </Button>
        <Button size="sm" variant="ghost" onClick={() => copy(`${draft.title}\n${when}${draft.attendees.length ? `\nWith ${draft.attendees.join(', ')}` : ''}`)}>
          <Copy size={12} /> Copy
        </Button>
      </div>
    </Card>
  )
}

function EditCard({ call: c, onRevert }: { call: ToolCallOutput; onRevert?: (call: ToolCallOutput, undo: boolean) => void }): ReactNode {
  const args = c.args as { textToReplace: string; newText: string }
  const state = c.applied === false ? "Couldn't apply this edit: the notes changed." : c.applied === null || c.applied === undefined ? 'Applying…' : c.reverted ? 'Undone' : 'Applied to your notes'
  return (
    <Card
      icon={<PenLine size={13} />}
      title="Edited your notes"
      right={
        c.applied && onRevert ? (
          <Button size="sm" variant="ghost" onClick={() => onRevert(c, !c.reverted)}>
            {c.reverted ? <Redo2 size={12} /> : <Undo2 size={12} />} {c.reverted ? 'Reapply' : 'Undo'}
          </Button>
        ) : undefined
      }
    >
      <div className="selectable space-y-1 text-sm leading-relaxed">
        {args.textToReplace && <div className="text-ink-secondary line-through decoration-danger/60">{args.textToReplace}</div>}
        {args.newText && <div className="whitespace-pre-wrap">{args.newText}</div>}
      </div>
      <div className={`mt-1.5 text-xs ${c.applied === false ? 'text-ink-danger' : 'text-ink-tertiary'}`}>{state}</div>
    </Card>
  )
}

function TaskCard({ taskId, title, task }: { taskId: string; title: string; task?: AgentThread }): ReactNode {
  const status = task?.status
  return (
    <button onClick={() => navigate(`/assistant/task/${taskId}`)} className="flex w-full items-center gap-2.5 rounded-2xl bg-surface-elevated px-3.5 py-2.5 text-left ring-1 ring-hairline transition-colors hover:bg-surface-sunken">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-surface-tint-accent text-ink-accent-strong">
        <Workflow size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{task?.title ?? title}</span>
        <span className="block truncate text-xs text-ink-tertiary">{status ? `${TASK_STATUS_LABELS[status]}${task?.summary ? ` · ${task.summary}` : ''}` : 'Task'}</span>
      </span>
      {status === 'active' ? <Spinner className="size-3 text-ink-accent" /> : <ChevronRight size={14} className="text-ink-tertiary" />}
    </button>
  )
}

function ResultCard({ args, onCite }: { args: { status: 'done' | 'needs_input' | 'failed'; summary: string; text: string }; onCite?: (n: number) => void }): ReactNode {
  const tone = args.status === 'done' ? 'text-ink-success' : args.status === 'failed' ? 'text-ink-danger' : 'text-ink-accent-strong'
  return (
    <div className="rounded-2xl bg-surface-elevated p-4 ring-1 ring-hairline">
      <div className="mb-2 flex items-center gap-2 text-sm">
        <span className={`font-medium ${tone}`}>{TASK_STATUS_LABELS[args.status]}</span>
        <span className="truncate text-ink-secondary">{args.summary}</span>
      </div>
      <Markdown text={args.text} onCite={onCite} className="text-base [&_.prose-heading]:before:hidden" />
    </div>
  )
}

function ApprovalCard({ call: c }: { call: ToolCallOutput }): ReactNode {
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  const showToast = useApp((s) => s.showToast)
  const decide = async (decision: 'approved' | 'denied'): Promise<void> => {
    setBusy(true)
    try {
      await call('agent:decide', c.approval!.id, decision, always)
    } catch (e) {
      showToast('error', errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="rounded-2xl bg-surface-tint-accent/50 p-3.5 ring-1 ring-ink-accent/30">
      <div className="flex items-center gap-2 text-sm">
        <ShieldQuestion size={15} className="shrink-0 text-ink-accent-strong" />
        <span className="font-medium">Approval needed</span>
      </div>
      <div className="mt-1.5 text-sm">{c.approval?.label ?? c.label}</div>
      {c.approval?.detail && <pre className="selectable mt-2 max-h-48 overflow-y-auto rounded-xl bg-surface-elevated px-3 py-2 font-sans text-xs whitespace-pre-wrap text-ink-secondary ring-1 ring-hairline">{c.approval.detail}</pre>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide('approved')}>
          <Check size={12} /> Approve
        </Button>
        <Button size="sm" variant="soft" disabled={busy} onClick={() => void decide('denied')}>
          Decline
        </Button>
        <label className="ml-2 inline-flex cursor-pointer items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="accent-[var(--accent)]" />
          Always allow {c.name}
        </label>
      </div>
    </div>
  )
}
