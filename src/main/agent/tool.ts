import { z } from 'zod'
import type { AgentEvent, AgentHome, AgentRoutine, AgentThread, ToolCallOutput, ToolContext } from '@shared/agent'
import type { CalendarEvent, Panel, Settings } from '@shared/types'
import type { Store } from '../db/store'
import type { AgentRun, AgentStore } from '../db/agent-store'
import type { ToolSpec } from '../llm/provider'
import type { AgentFiles } from './files'

/** What a tool returns: `content` goes to the model, `data` is kept on the tool call for the UI. */
export interface ToolResult {
  content: string
  data?: unknown
  isError?: boolean
}

/** Assistant operations the conversation and task tools need (implemented by the Assistant). */
export interface AssistantOps {
  startTask(conversationId: string, init: { title: string; handoff: string; lifetime: 'once' | 'ongoing'; followsTaskId?: string }): AgentThread
  messageTask(taskId: string, message: string): AgentThread
  stopTask(taskId: string): AgentThread
  task(taskId: string): { thread: AgentThread; result: string | null } | null
  tasks(conversationId: string): AgentThread[]
  publishResult(taskId: string, result: { status: 'done' | 'needs_input' | 'failed'; summary: string; text: string }): AgentThread
  publishHome(home: Omit<AgentHome, 'updated_at'>): AgentHome
  createRoutine(init: { message: string; expression: string; timezone: string; taskId: string | null }): AgentRoutine
  routines(): AgentRoutine[]
  deleteRoutine(id: string): void
}

/** Everything a tool can use while it runs (in the main process). */
export interface ToolEnv {
  store: Store
  agentStore: AgentStore
  files: AgentFiles
  settings: Settings
  run: AgentRun
  /** The note a note chat is about. */
  documentId: string | null
  calendarBetween(from: string, to: string): CalendarEvent[]
  /** Start a new enhanced-notes panel with extra instructions (Granola's rewriteMeetingNotes). */
  rewriteNotes(documentId: string, instructions: string): Panel
  assistant: AssistantOps
  emit(event: AgentEvent): void
}

type Policy = 'allow' | 'ask'

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  input: S
  label: { active: string; done: string }
  contexts: ToolContext[]
  affects?: ToolCallOutput['affects']
  /** 'ask' pauses the run until the user approves the call; may depend on the arguments. */
  policy?: Policy | ((args: z.infer<S>) => Policy)
  /** How the call is described in the approval prompt. */
  approval?: (args: z.infer<S>) => { label: string; detail?: string }
  /** The renderer applies the result after the call completes (note edits). */
  clientApplied?: boolean
  execute(args: z.infer<S>, env: ToolEnv): ToolResult | Promise<ToolResult>
}

export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> {
  return tool
}

const specs = new WeakMap<AgentTool, ToolSpec>()

/** JSON Schema for the model. Defaults make fields optional (zod's "input" view). */
export function toolSpec(tool: AgentTool): ToolSpec {
  let spec = specs.get(tool)
  if (!spec) {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>
    spec = { name: tool.name, description: tool.description, parameters }
    specs.set(tool, spec)
  }
  return spec
}

export function policyFor(tool: AgentTool, args: unknown): Policy {
  if (!tool.policy) return 'allow'
  return typeof tool.policy === 'function' ? tool.policy(args) : tool.policy
}

/** Validate model-supplied arguments; the message goes back to the model so it can retry. */
export function parseArgs(tool: AgentTool, args: unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  if (args && typeof args === 'object' && '__unparsed' in args) {
    return { ok: false, message: JSON.stringify({ INVALID_JSON: (args as { __unparsed: string }).__unparsed }) }
  }
  const parsed = tool.input.safeParse(args ?? {})
  if (parsed.success) return { ok: true, value: parsed.data }
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
  return { ok: false, message: `Invalid arguments for ${tool.name}: ${issues}` }
}
