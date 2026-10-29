import type { ToolContext } from '@shared/agent'
import type { AgentTool } from '../tool'
import { getUpcomingCalendarEvents, listFolders, listMeetings, readMeetings, readTranscript, searchCalendar, searchMeetings } from './meetings'
import { editMeetingNotes, rewriteMeetingNotes } from './notes'
import { draftCalendarEvent, draftEmail } from './drafts'
import { editFile, listFiles, readFile, readSkill, writeFile } from './files'
import { createRoutine, deleteRoutine, listRoutines, listTasks, messageTask, publishHome, publishResult, readTaskResult, startTask, stopTask } from './assistant'

/** Every tool, in a fixed order (the tool list is part of the cached prompt prefix, so it must be stable). */
export const TOOLS: AgentTool[] = [
  searchMeetings,
  listMeetings,
  readMeetings,
  readTranscript,
  getUpcomingCalendarEvents,
  searchCalendar,
  listFolders,
  readSkill,
  editMeetingNotes,
  rewriteMeetingNotes,
  draftEmail,
  draftCalendarEvent,
  listFiles,
  readFile,
  writeFile,
  editFile,
  startTask,
  messageTask,
  stopTask,
  readTaskResult,
  listTasks,
  publishHome,
  createRoutine,
  listRoutines,
  deleteRoutine,
  publishResult
] as AgentTool[]

export function toolsFor(context: ToolContext): AgentTool[] {
  return TOOLS.filter((t) => t.contexts.includes(context))
}

export function findTool(name: string, context: ToolContext): AgentTool | undefined {
  return toolsFor(context).find((t) => t.name === name)
}
