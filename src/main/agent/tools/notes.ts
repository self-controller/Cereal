import { z } from 'zod'
import { defineTool } from '../tool'

// Tools that change the open note, only offered in a note's chat. Like Granola's editMeetingNotes, the edit is
// checked here and applied by the editor in the renderer, which can undo it; rewriteMeetingNotes writes a new
// enhanced-notes tab with the user's instructions.

export const editMeetingNotes = defineTool({
  name: 'editMeetingNotes',
  description:
    "Change the user's own notes for this meeting by replacing an exact passage. Copy textToReplace character for character from the notes as plain text (no Markdown symbols). To add to the end of the notes, pass an empty textToReplace. Use separate calls for separate passages.",
  input: z.object({
    textToReplace: z.string().describe('The exact text to replace, copied from the notes; empty to append at the end.'),
    newText: z.string().describe('What to put there. Use new lines for separate lines; no Markdown.')
  }),
  label: { active: 'Editing notes', done: 'Edited notes' },
  contexts: ['note-chat'],
  affects: 'notes',
  clientApplied: true,
  execute(args, env) {
    const doc = env.documentId ? env.store.getDocument(env.documentId) : null
    if (!doc) return { content: 'There is no open note to edit.', isError: true }
    if (args.textToReplace && !doc.notes_plain.includes(args.textToReplace)) {
      return {
        content: "textToReplace was not found in the notes. Copy it exactly from the user's notes as plain text (without Markdown symbols such as - or #).",
        isError: true
      }
    }
    if (!args.textToReplace && !args.newText.trim()) return { content: 'Nothing to change.', isError: true }
    return { content: 'The edit was sent to the editor and is shown to the user, who can undo it.', data: { status: 'sent' } }
  }
})

export const rewriteMeetingNotes = defineTool({
  name: 'rewriteMeetingNotes',
  description: "Write a new version of this meeting's enhanced notes following the user's instructions (for example shorter, in another language, or focused on decisions). It appears as a new tab.",
  input: z.object({ rewriteInstructions: z.string().min(1).describe('How the notes should be rewritten.') }),
  label: { active: 'Rewriting notes', done: 'Rewrote notes' },
  contexts: ['note-chat'],
  affects: 'notes',
  execute(args, env) {
    if (!env.documentId) return { content: 'There is no open note.', isError: true }
    const panel = env.rewriteNotes(env.documentId, args.rewriteInstructions)
    return { content: `A rewritten version is being generated in a new tab called "${panel.title}". Tell the user it's on its way; don't repeat its content.`, data: { newPanelId: panel.id } }
  }
})
