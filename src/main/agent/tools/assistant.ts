import { z } from 'zod'
import { TASK_STATUS_LABELS } from '@shared/agent'
import { assertTimezone, describeSchedule, parseSchedule } from '../schedule'
import { defineTool } from '../tool'

// The Assistant's orchestration tools, after Keto's actions: the conversation hands work to task threads
// (assistant.child.start/message/stop, result.read), keeps a Home briefing (task.home) and manages routines
// (schedule.create/list/delete). Tasks report back with publishResult (assistant.result.publish).

export const startTask = defineTool({
  name: 'startTask',
  description:
    'Hand a piece of work to a new task, which runs on its own with the same tools and reports back when done. Use it for anything that takes several steps (research across meetings, drafting follow-ups, preparing for a meeting). The handoff must contain everything the task needs; it cannot see this conversation.',
  input: z.object({
    title: z.string().min(1).max(120).describe('Short name shown in the task list.'),
    handoff: z.string().min(1).describe('Complete instructions and context for the task.'),
    lifetime: z.enum(['once', 'ongoing']).default('once').describe('ongoing tasks stay open for follow-up messages and routines.'),
    follows_task_id: z.string().optional().describe('An earlier task this one continues.')
  }),
  label: { active: 'Starting task', done: 'Started task' },
  contexts: ['conversation'],
  affects: 'tasks',
  execute(args, env) {
    const task = env.assistant.startTask(env.run.thread_id, { title: args.title, handoff: args.handoff, lifetime: args.lifetime, followsTaskId: args.follows_task_id })
    return { content: `Started task "${task.title}" (task_id: ${task.id}). It will report back when it's done; tell the user briefly.`, data: { taskThreadId: task.id } }
  }
})

export const messageTask = defineTool({
  name: 'messageTask',
  description: 'Send follow-up instructions or an answer to a task (for example when it needs input).',
  input: z.object({ task_id: z.string(), message: z.string().min(1) }),
  label: { active: 'Messaging task', done: 'Messaged task' },
  contexts: ['conversation'],
  affects: 'tasks',
  execute(args, env) {
    const task = env.assistant.messageTask(args.task_id, args.message)
    return { content: `Sent to "${task.title}".`, data: { taskThreadId: task.id } }
  }
})

export const stopTask = defineTool({
  name: 'stopTask',
  description: 'Stop a task that is no longer needed.',
  input: z.object({ task_id: z.string() }),
  label: { active: 'Stopping task', done: 'Stopped task' },
  contexts: ['conversation'],
  affects: 'tasks',
  execute(args, env) {
    const task = env.assistant.stopTask(args.task_id)
    return { content: `Stopped "${task.title}".`, data: { taskThreadId: task.id } }
  }
})

export const readTaskResult = defineTool({
  name: 'readTaskResult',
  description: "Read a task's status and the result it published.",
  input: z.object({ task_id: z.string() }),
  label: { active: 'Reading task', done: 'Read task' },
  contexts: ['conversation'],
  execute(args, env) {
    const t = env.assistant.task(args.task_id)
    if (!t) return { content: `No task with id ${args.task_id}.`, isError: true }
    const status = t.thread.status ? TASK_STATUS_LABELS[t.thread.status] : 'Unknown'
    return { content: `"${t.thread.title}" — ${status}${t.thread.summary ? `: ${t.thread.summary}` : ''}\n\n${t.result ?? '(No result yet.)'}`, data: { taskThreadId: t.thread.id } }
  }
})

export const listTasks = defineTool({
  name: 'listTasks',
  description: 'Your tasks in this conversation with their status, newest first.',
  input: z.object({}),
  label: { active: 'Checking tasks', done: 'Checked tasks' },
  contexts: ['conversation'],
  execute(_args, env) {
    const tasks = env.assistant.tasks(env.run.thread_id)
    if (!tasks.length) return { content: 'No tasks yet.' }
    return { content: tasks.map((t) => `- ${t.title} (task_id: ${t.id}) — ${t.status ? TASK_STATUS_LABELS[t.status] : ''}${t.summary ? `: ${t.summary}` : ''}`).join('\n') }
  }
})

export const publishHome = defineTool({
  name: 'publishHome',
  description: "Update the user's Assistant home: a short briefing (what's going on, what needs them) and the tasks grouped under headings. Replace the whole home each time.",
  input: z.object({
    briefing: z.string().max(8000).describe('A few short Markdown lines.'),
    groups: z.array(z.object({ title: z.string().min(1).max(100), task_ids: z.array(z.string()).max(100) })).max(20)
  }),
  label: { active: 'Updating home', done: 'Updated home' },
  contexts: ['conversation'],
  execute(args, env) {
    const home = env.assistant.publishHome({ briefing: args.briefing, groups: args.groups.map((g) => ({ title: g.title, taskIds: g.task_ids })) })
    return { content: 'Home updated.', data: { groups: home.groups.length } }
  }
})

export const createRoutine = defineTool({
  name: 'createRoutine',
  description:
    'Schedule a routine: at each time, the message is delivered to you (or to a task) as if from the scheduler, and you act on it. schedule is at(2026-10-21T09:00) for once, rate(1 day) / rate(30 minutes) for repeats, or cron(0 9 * * 1-5) for minute hour day month weekday. Needs the user to approve.',
  input: z.object({
    message: z.string().min(1).max(10000).describe('What to do each time, written as an instruction to yourself.'),
    schedule: z.string().describe('at(...), rate(...) or cron(...)'),
    timezone: z.string().optional().describe("IANA timezone; defaults to the user's."),
    task_id: z.string().optional().describe('Deliver to this ongoing task instead of the conversation.')
  }),
  label: { active: 'Creating routine', done: 'Created routine' },
  contexts: ['conversation', 'task'],
  affects: 'routines',
  policy: 'ask',
  approval: (args) => ({ label: `Create a routine: ${describeSchedule(args.schedule, args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone)}`, detail: args.message.slice(0, 600) }),
  execute(args, env) {
    const timezone = args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    parseSchedule(args.schedule)
    assertTimezone(timezone)
    const taskId = args.task_id ?? (env.run.context === 'task' ? env.run.thread_id : null)
    const r = env.assistant.createRoutine({ message: args.message, expression: args.schedule, timezone, taskId })
    return { content: `Routine created (routine_id: ${r.id}): ${describeSchedule(r.expression, r.timezone)}. Next run: ${r.next_fire_at ?? 'never'}.`, data: { routineId: r.id } }
  }
})

export const listRoutines = defineTool({
  name: 'listRoutines',
  description: 'Your scheduled routines.',
  input: z.object({}),
  label: { active: 'Checking routines', done: 'Checked routines' },
  contexts: ['conversation', 'task'],
  execute(_args, env) {
    const all = env.assistant.routines()
    if (!all.length) return { content: 'No routines.' }
    return {
      content: all
        .map((r) => `- ${describeSchedule(r.expression, r.timezone)} (routine_id: ${r.id}${r.enabled ? '' : ', paused'}${r.task_thread_id ? `, task_id: ${r.task_thread_id}` : ''}): ${r.message.slice(0, 200)}`)
        .join('\n')
    }
  }
})

export const deleteRoutine = defineTool({
  name: 'deleteRoutine',
  description: 'Delete a routine.',
  input: z.object({ routine_id: z.string() }),
  label: { active: 'Deleting routine', done: 'Deleted routine' },
  contexts: ['conversation', 'task'],
  affects: 'routines',
  execute(args, env) {
    env.assistant.deleteRoutine(args.routine_id)
    return { content: 'Routine deleted.' }
  }
})

export const publishResult = defineTool({
  name: 'publishResult',
  description:
    'Finish your task by publishing its result to the conversation: status done (finished), needs_input (you need the user to decide or tell you something; say exactly what) or failed (you could not do it; say why). Call this once, as your last step.',
  input: z.object({
    status: z.enum(['done', 'needs_input', 'failed']),
    summary: z.string().min(1).max(200).describe('One line for the task list.'),
    text: z.string().min(1).describe('The result in Markdown: findings, the draft you made, or the question for the user.')
  }),
  label: { active: 'Publishing result', done: 'Published result' },
  contexts: ['task'],
  affects: 'tasks',
  execute(args, env) {
    env.assistant.publishResult(env.run.thread_id, args)
    return { content: 'Result published. Stop now.' }
  }
})
