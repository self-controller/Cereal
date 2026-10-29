import { posix } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../tool'

// The Assistant's file tools (Granola's worker had read_file/write_file/edit_file in its sandbox). Cereal confines
// them to the agent folder; writing outside memory/ needs the user's approval.

const ASSISTANT = ['conversation', 'task'] as const
/** Whether a path stays inside memory/ once normalised (so memory/../x doesn't count). */
const inMemory = (path: string): boolean => posix.normalize(path.trim().replace(/\\/g, '/')).startsWith('memory/')

export const listFiles = defineTool({
  name: 'list_files',
  description: 'List a folder in your agent folder (memory/, skills/, files/).',
  input: z.object({ path: z.string().default('.') }),
  label: { active: 'Listing files', done: 'Listed files' },
  contexts: [...ASSISTANT],
  execute(args, env) {
    const entries = env.files.list(args.path)
    if (!entries.length) return { content: `${args.path} is empty.` }
    return { content: entries.map((e) => `${e.dir ? `${e.path}/` : e.path}${e.dir ? '' : ` (${e.size} bytes)`}`).join('\n') }
  }
})

export const readFile = defineTool({
  name: 'read_file',
  description: 'Read a text file from your agent folder.',
  input: z.object({ path: z.string(), offset: z.number().int().min(0).default(0).describe('Character offset to start from.') }),
  label: { active: 'Reading', done: 'Read' },
  contexts: [...ASSISTANT],
  execute(args, env) {
    const r = env.files.read(args.path, args.offset)
    return { content: r.truncated ? `${r.content}\n(… ${r.size - args.offset - r.content.length} more characters: read again with a larger offset.)` : r.content || '(empty file)' }
  }
})

export const writeFile = defineTool({
  name: 'write_file',
  description: 'Create or overwrite a text file in your agent folder. Use memory/ for durable facts about the user. Writing anywhere else needs the user to approve.',
  input: z.object({ path: z.string(), content: z.string() }),
  label: { active: 'Writing', done: 'Wrote' },
  contexts: [...ASSISTANT],
  affects: 'memory',
  policy: (args) => (inMemory(args.path) ? 'allow' : 'ask'),
  approval: (args) => ({ label: `Write ${args.path}`, detail: args.content.slice(0, 600) }),
  execute(args, env) {
    const r = env.files.write(args.path, args.content)
    env.emit({ type: 'memory_changed', path: r.path })
    return { content: `${r.created ? 'Created' : 'Updated'} ${r.path}.`, data: { path: r.path } }
  }
})

export const editFile = defineTool({
  name: 'edit_file',
  description: 'Replace one exact, unique passage of a text file in your agent folder. Read the file first. Editing outside memory/ needs the user to approve.',
  input: z.object({ path: z.string(), old_text: z.string(), new_text: z.string() }),
  label: { active: 'Editing', done: 'Edited' },
  contexts: [...ASSISTANT],
  affects: 'memory',
  policy: (args) => (inMemory(args.path) ? 'allow' : 'ask'),
  approval: (args) => ({ label: `Edit ${args.path}`, detail: `Replace:\n${args.old_text.slice(0, 300)}\nWith:\n${args.new_text.slice(0, 300)}` }),
  execute(args, env) {
    const r = env.files.edit(args.path, args.old_text, args.new_text)
    env.emit({ type: 'memory_changed', path: r.path })
    return { content: `Edited ${r.path}.`, data: { path: r.path } }
  }
})

export const readSkill = defineTool({
  name: 'readSkill',
  description: 'Load the full instructions of one of your skills (listed in the system prompt) before doing the task it covers.',
  input: z.object({ name: z.string() }),
  label: { active: 'Reading skill', done: 'Read skill' },
  contexts: ['note-chat', 'global-chat', 'conversation', 'task'],
  execute(args, env) {
    return { content: env.files.readSkill(args.name) }
  }
})
