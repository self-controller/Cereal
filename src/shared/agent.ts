// Agent types shared by main, the agent worker and the renderer.
// Shapes follow what Granola's agent bundles carry (docs/granola-findings.md §11): chat message `outputs`
// with tool calls and approvals, and the "Keto" assistant's conversation/task threads, runs and sequenced events.
import type { LlmProviderId } from './types'

/** Where a run's tools come from and what they may touch. */
export type ToolContext = 'note-chat' | 'global-chat' | 'conversation' | 'task'

export interface ToolApproval {
  id: string
  status: 'pending' | 'approved' | 'denied'
  /** What the user is asked to approve, e.g. "Write files/plan.md". */
  label?: string
  detail?: string | null
}

export interface ToolCallOutput {
  type: 'tool_call'
  id: string
  name: string
  /** Human label for the call, e.g. "Searched meetings". */
  label: string
  args: Record<string, unknown>
  /** Structured result for the UI (drafts, task links, edit status). */
  result?: unknown
  error?: string
  completed?: boolean
  startedAtMs?: number
  completedAtMs?: number
  /** What the tool changes, if anything. */
  affects?: 'notes' | 'memory' | 'tasks' | 'routines'
  /** Client-applied tools (editMeetingNotes): null until the editor has tried to apply the edit. */
  applied?: boolean | null
  /** The user undid this tool's effect. */
  reverted?: boolean
  approval?: ToolApproval
}

export interface TextOutput {
  type: 'text'
  text: string
}

export interface ReasoningOutput {
  type: 'reasoning'
  text: string
}

export type AgentOutput = TextOutput | ReasoningOutput | ToolCallOutput

export type MessageStatus = 'in_progress' | 'completed' | 'error' | 'cancelled'

// ------------------------------------------------------------------ assistant

export type TaskStatus = 'active' | 'needs_input' | 'done' | 'failed' | 'cancelled'

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  active: 'Working',
  needs_input: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Stopped'
}

export interface PendingApproval {
  id: string
  label: string
  detail: string | null
}

export interface AgentThread {
  id: string
  kind: 'conversation' | 'task'
  parent_thread_id: string | null
  follows_thread_id: string | null
  title: string | null
  summary: string | null
  /** Tasks only; null for the conversation. */
  status: TaskStatus | null
  lifetime: 'once' | 'ongoing' | null
  revision: number
  result_message_id: string | null
  pending_approval: PendingApproval | null
  created_at: string
  updated_at: string
}

/**
 * Who wrote a message: the user, the agent, or (in a task) the conversation that handed it work. Inputs from tasks,
 * routines and events reach the model but are not shown as messages, as in Keto.
 */
export type MessageAuthor = 'user' | 'agent' | 'parent'

export interface AgentMessage {
  id: string
  thread_id: string
  sequence: number
  author: MessageAuthor
  text: string
  outputs: AgentOutput[]
  status: MessageStatus
  error: string | null
  client_message_id: string | null
  /** Highest event sequence of the producing run already folded into `outputs`. */
  applied_sequence: number
  run_id: string | null
  created_at: string
  updated_at: string
}

export type RunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'

export const ACTIVE_RUN_STATUSES: RunStatus[] = ['queued', 'running', 'waiting']

export interface AgentHome {
  briefing: string
  groups: { title: string; taskIds: string[] }[]
  updated_at: string
}

export interface AgentRoutine {
  id: string
  task_thread_id: string | null
  message: string
  expression: string
  timezone: string
  delivery: 'immediate' | 'idle'
  enabled: boolean
  next_fire_at: string | null
  last_fired_at: string | null
  created_at: string
  /** Human description of the schedule, e.g. "Weekdays at 09:00". */
  description: string
}

export interface AgentSkill {
  name: string
  description: string
  path: string
}

export interface AgentFileEntry {
  path: string
  name: string
  dir: boolean
  size: number
  modified_at: string
}

/** Events a run emits, named after Keto's (`message.delta`, `tool.started`, `run.status`, …). */
export type AgentEvent =
  | { type: 'run.status'; status: RunStatus; error?: string }
  | { type: 'message.delta'; messageId: string; delta: string }
  | { type: 'reasoning.delta'; messageId: string; delta: string }
  | { type: 'tool.started'; messageId: string; toolCall: ToolCallOutput }
  | { type: 'tool.completed'; messageId: string; toolCall: ToolCallOutput }
  | { type: 'approval.requested'; messageId: string; toolCallId: string; approval: ToolApproval; label: string; detail: string | null }
  | { type: 'approval.decided'; messageId: string; toolCallId: string; approval: ToolApproval }
  /** One model request's tokens (see StepUsage); main records it for Settings → Usage. */
  | {
      type: 'model.usage'
      provider?: LlmProviderId
      model: string
      /** Set for requests that aren't the run's own turns. */
      purpose?: 'compaction'
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    }
  | { type: 'memory_changed'; path: string }

export interface AgentEventRecord {
  run_id: string
  thread_id: string
  sequence: number
  created_at: string
  event: AgentEvent
}

export interface AssistantSnapshot {
  enabled: boolean
  conversation: AgentThread
  messages: AgentMessage[]
  tasks: AgentThread[]
  home: AgentHome | null
  /** Runs still in progress, so the UI can catch up on their events. */
  activeRuns: { run_id: string; thread_id: string; message_id: string | null; status: RunStatus }[]
}

// -------------------------------------------------------------------- reducer

function upsertTool(outputs: AgentOutput[], call: ToolCallOutput): AgentOutput[] {
  const i = outputs.findIndex((o) => o.type === 'tool_call' && o.id === call.id)
  if (i < 0) return [...outputs, call]
  const next = outputs.slice()
  next[i] = { ...(outputs[i] as ToolCallOutput), ...call }
  return next
}

function patchTool(outputs: AgentOutput[], id: string, patch: Partial<ToolCallOutput>): AgentOutput[] {
  return outputs.map((o) => (o.type === 'tool_call' && o.id === id ? { ...o, ...patch } : o))
}

/** Fold one event into a message's outputs (used by main to persist messages and by the renderer to stream them). */
export function applyAgentEvent(outputs: AgentOutput[], e: AgentEvent): AgentOutput[] {
  switch (e.type) {
    case 'message.delta': {
      const last = outputs[outputs.length - 1]
      if (last?.type === 'text') return [...outputs.slice(0, -1), { type: 'text', text: last.text + e.delta }]
      return [...outputs, { type: 'text', text: e.delta }]
    }
    case 'reasoning.delta': {
      const last = outputs[outputs.length - 1]
      if (last?.type === 'reasoning') return [...outputs.slice(0, -1), { type: 'reasoning', text: last.text + e.delta }]
      return [...outputs, { type: 'reasoning', text: e.delta }]
    }
    case 'tool.started':
    case 'tool.completed':
      return upsertTool(outputs, e.toolCall)
    case 'approval.requested':
      return patchTool(outputs, e.toolCallId, { approval: { ...e.approval, label: e.label, detail: e.detail } })
    case 'approval.decided': {
      const call = outputs.find((o): o is ToolCallOutput => o.type === 'tool_call' && o.id === e.toolCallId)
      return patchTool(outputs, e.toolCallId, { approval: { ...call?.approval, ...e.approval } })
    }
    default:
      return outputs
  }
}

/** The plain answer text of a message: its text outputs, in order. */
export function outputsText(outputs: AgentOutput[]): string {
  return outputs
    .filter((o): o is TextOutput => o.type === 'text')
    .map((o) => o.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

export function eventMessageId(e: AgentEvent): string | null {
  return 'messageId' in e ? e.messageId : null
}
