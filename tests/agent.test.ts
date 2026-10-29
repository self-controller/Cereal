import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyAgentEvent, outputsText, type AgentOutput, type ToolCallOutput } from '@shared/agent'
import { lastToolResults, makeAgent, type ScriptStep } from './agent-harness'
import type { Store } from '../src/main/db/store'

function seedMeeting(store: Store, title = 'Budget review'): string {
  const doc = store.createDocument({ title })
  store.updateDocument(doc.id, { notes_markdown: '- budget 50k\n- ship in Q3', notes_plain: 'budget 50k\nship in Q3' })
  store.upsertChunks([
    { id: `${doc.id}-a`, document_id: doc.id, source: 'microphone', text: 'Our budget is fifty thousand.', start_timestamp: '2026-10-19T15:00:00Z', end_timestamp: '2026-10-19T15:00:03Z', is_final: true },
    { id: `${doc.id}-b`, document_id: doc.id, source: 'system', text: 'We can ship in Q3 if legal signs off.', start_timestamp: '2026-10-19T15:00:04Z', end_timestamp: '2026-10-19T15:00:08Z', is_final: true }
  ])
  return doc.id
}

const tools = (outputs: AgentOutput[]): ToolCallOutput[] => outputs.filter((o): o is ToolCallOutput => o.type === 'tool_call')

describe('agent loop (chat)', () => {
  it('answers a global question by searching and reading meetings, with citations', async () => {
    const a = makeAgent((_o, i): ScriptStep => {
      if (i === 0) return { reasoning: 'Look it up.', calls: [{ name: 'searchMeetings', args: { query: 'budget' } }] }
      if (i === 1) return { calls: [{ name: 'readMeetings', args: { meeting_ids: [id] } }] }
      return { text: 'The pilot budget is 50k [1].' }
    })
    const id = seedMeeting(a.store)
    const { threadId, messageId } = a.chat.send({ text: 'What is the budget?' })
    await a.settle()

    const reply = a.store.getMessage(messageId)!
    expect(reply.status).toBe('completed')
    expect(reply.content).toBe('The pilot budget is 50k [1].')
    expect(reply.citations).toEqual([{ n: 1, document_id: id, title: 'Budget review' }])
    expect(reply.outputs.map((o) => o.type)).toEqual(['reasoning', 'tool_call', 'tool_call', 'text'])
    expect(tools(reply.outputs).map((t) => [t.name, t.label, t.completed])).toEqual([
      ['searchMeetings', 'Searched meetings', true],
      ['readMeetings', 'Read meetings', true]
    ])

    // The model saw numbered, citable results and the meeting content.
    expect(lastToolResults(a.provider.steps[1]).searchMeetings).toMatch(/^1 meeting:\n\[1\] Budget review/)
    expect(lastToolResults(a.provider.steps[2]).readMeetings).toContain('My notes:\n- budget 50k')
    // Global chat gets read tools but not the note-editing ones.
    expect(a.provider.steps[0].tools).toContain('searchMeetings')
    expect(a.provider.steps[0].tools).not.toContain('editMeetingNotes')
    expect(a.provider.steps[0].system).toContain('Most recent:\n- Budget review')

    // The transcript is append-only and alternates model turns with tool results.
    const transcript = a.agentStore.transcript(threadId)
    expect(transcript.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant'])
    // Streaming broadcast the message several times before it completed.
    expect(a.chatMessages.filter((m) => m.id === messageId).length).toBeGreaterThan(2)
  })

  it('gives note chats the note itself, lecture semantics, recipes and note tools', async () => {
    const a = makeAgent(() => ({ text: 'Entropy measures disorder.' }))
    const doc = a.store.createDocument({ mode: 'lecture', title: 'Thermo' })
    a.store.updateDocument(doc.id, { notes_markdown: '- entropy', notes_plain: 'entropy' })
    a.store.upsertChunks([{ id: 'x', document_id: doc.id, source: 'microphone', text: 'Entropy measures disorder.', start_timestamp: '2026-10-19T15:00:00Z', end_timestamp: '2026-10-19T15:00:03Z', is_final: true }])
    const { threadId } = a.chat.send({ documentId: doc.id, text: '/tldr please' })
    await a.settle()
    const step = a.provider.steps[0]
    expect(step.system).toContain("one of the user's lectures")
    expect(step.system).toContain('Speaker: Entropy measures disorder.')
    expect(step.tools).toEqual(expect.arrayContaining(['editMeetingNotes', 'rewriteMeetingNotes', 'searchMeetings']))
    const last = step.messages[step.messages.length - 1]
    expect(last).toEqual({ role: 'user', content: 'Give me a three-bullet TL;DR of this meeting.\n\nplease', messageId: expect.any(String) })
    // The open note is source [1] of its chat.
    expect(a.agentStore.sources(threadId)).toEqual([{ n: 1, document_id: doc.id, title: 'Thermo' }])
  })

  it('reports invalid tool arguments back to the model and keeps going', async () => {
    const a = makeAgent((_o, i) => (i === 0 ? { calls: [{ name: 'readMeetings', args: { meeting_ids: 'nope' } }] } : { text: 'Sorry.' }))
    const { messageId } = a.chat.send({ text: 'Read it' })
    await a.settle()
    expect(lastToolResults(a.provider.steps[1]).readMeetings).toMatch(/^Invalid arguments for readMeetings: meeting_ids:/)
    const call = tools(a.store.getMessage(messageId)!.outputs)[0]
    expect(call.error).toMatch(/Invalid arguments/)
    expect(a.store.getMessage(messageId)!.status).toBe('completed')
  })

  it('sends note edits to the editor, which reports them applied and can undo them', async () => {
    const a = makeAgent((_o, i) =>
      i === 0 ? { calls: [{ name: 'editMeetingNotes', args: { textToReplace: 'budget 50k', newText: 'budget $50,000' } }, { name: 'editMeetingNotes', args: { textToReplace: 'not there', newText: 'x' } }] } : { text: 'Done.' }
    )
    const id = seedMeeting(a.store)
    const { messageId } = a.chat.send({ documentId: id, text: 'Spell out the budget' })
    await a.settle()
    const [ok, missing] = tools(a.store.getMessage(messageId)!.outputs)
    expect(ok).toMatchObject({ name: 'editMeetingNotes', applied: null, affects: 'notes' })
    expect(missing.error).toMatch(/was not found/)
    expect(missing.applied).toBeUndefined()
    a.chat.toolApplied(messageId, ok.id, { applied: true })
    a.chat.toolApplied(messageId, ok.id, { reverted: true })
    expect(tools(a.store.getMessage(messageId)!.outputs)[0]).toMatchObject({ applied: true, reverted: true })
  })

  it('rewrites the enhanced notes into a new panel', async () => {
    const a = makeAgent((_o, i) => (i === 0 ? { calls: [{ name: 'rewriteMeetingNotes', args: { rewriteInstructions: 'In Spanish' } }] } : { text: 'On its way.' }))
    const id = seedMeeting(a.store)
    const { messageId } = a.chat.send({ documentId: id, text: 'Rewrite in Spanish' })
    await a.settle()
    expect(a.rewrites).toEqual([{ documentId: id, instructions: 'In Spanish' }])
    const call = tools(a.store.getMessage(messageId)!.outputs)[0]
    expect((call.result as { newPanelId: string }).newPanelId).toBe(a.store.listPanels(id)[0].id)
  })

  it('stops a streaming answer and keeps the transcript complete', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const a = makeAgent((_o, i) => (i === 0 ? { calls: [{ name: 'listFolders', args: {} }] } : { until: gate, text: 'never' }))
    const { threadId, messageId } = a.chat.send({ text: 'Folders?' })
    await new Promise((r) => setTimeout(r, 30))
    a.chat.stop(messageId)
    await a.settle()
    release()
    const reply = a.store.getMessage(messageId)!
    expect(reply.status).toBe('cancelled')
    expect(a.agentStore.transcript(threadId).map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(() => a.chat.send({ threadId, text: 'Again' })).not.toThrow()
  })

  it('seeds the transcript of chats from before the agent', async () => {
    const a = makeAgent(() => ({ text: 'ok' }))
    const thread = a.store.createThread(null, 'old')
    a.store.addMessage(thread.id, 'user', 'Old question')
    const old = a.store.addMessage(thread.id, 'assistant', '')
    a.store.updateMessage(old.id, { content: 'Old answer' })
    a.chat.send({ threadId: thread.id, text: 'New question' })
    await a.settle()
    expect(a.provider.steps[0].messages).toEqual([
      { role: 'user', content: 'Old question', messageId: expect.any(String) },
      { role: 'assistant', blocks: [{ type: 'text', text: 'Old answer' }] },
      { role: 'user', content: 'New question', messageId: expect.any(String) }
    ])
  })

  it('compacts long transcripts into a new epoch without replaying thinking', async () => {
    const a = makeAgent(() => ({ text: 'x'.repeat(400) }), { maxInputChars: 1_000 })
    const { threadId } = a.chat.send({ text: 'q1' })
    await a.settle()
    a.chat.send({ threadId, text: 'q2' })
    await a.settle()
    a.chat.send({ threadId, text: 'q3' })
    await a.settle()
    expect(a.provider.generated.length).toBeGreaterThan(0)
    const t = a.agentStore.transcript(threadId)
    expect(t[0]).toMatchObject({ role: 'user', content: expect.stringContaining('Summary of the earlier conversation') })
    expect(t.some((m) => m.role === 'assistant' && m.replay)).toBe(false)
  })
})

describe('chat bar', () => {
  async function attach(a: ReturnType<typeof makeAgent>, name: string, text: string, type = 'text/plain'): Promise<string> {
    const added = await a.attachments.add({ documentId: null, name, type, bytes: new TextEncoder().encode(text) })
    expect(await a.attachments.settled(added.id)).toMatchObject({ status: 'ready' })
    return added.id
  }

  it('sends attached files with the question and keeps them on the user message', async () => {
    const a = makeAgent(() => ({ text: 'The plan ships in Q3.' }))
    const id = await attach(a, 'plan.md', '# Plan\nShip in Q3.')
    const { threadId } = a.chat.send({ text: 'When does it ship?', attachmentIds: [id] })
    await a.settle()
    const last = a.provider.steps[0].messages.at(-1)
    expect(last).toMatchObject({ role: 'user', content: 'When does it ship?', attachments: [{ id, name: 'plan.md', kind: 'text', mime: 'text/markdown' }] })
    expect(a.provider.steps[0].files).toEqual([{ name: 'plan.md', text: '# Plan\nShip in Q3.', bytes: 18 }])
    const [user] = a.store.listMessages(threadId)
    expect(user.attachments).toMatchObject([{ id, thread_id: threadId, message_id: user.id }])
    // A sent file can't be sent again as a draft.
    expect(() => a.chat.send({ threadId, text: 'Again', attachmentIds: [id] })).toThrow(/no longer available/)
  })

  it('refuses to send while a file is still loading or failed', async () => {
    const a = makeAgent(() => ({ text: 'ok' }))
    const pending = await a.attachments.add({ documentId: null, name: 'big.md', type: 'text/markdown', bytes: new TextEncoder().encode('x') })
    expect(() => a.chat.send({ text: 'q', attachmentIds: [pending.id] })).toThrow(/Wait for big.md/)
    await a.attachments.settled(pending.id)
    expect(() => a.chat.send({ text: '', attachmentIds: [pending.id] })).not.toThrow()
    await a.settle()
    expect(a.provider.steps[0].messages.at(-1)).toMatchObject({ content: 'Look at the attached files.' })
  })

  it('gives @-mentioned notes source numbers and passes selected text', async () => {
    const a = makeAgent(() => ({ text: 'See [1].' }))
    const doc = seedMeeting(a.store, 'Acme kickoff')
    const { threadId } = a.chat.send({ text: 'Summarise', mentions: [{ id: doc, title: 'Acme kickoff' }], selectedText: 'ship in Q3' })
    await a.settle()
    const last = a.provider.steps[0].messages.at(-1) as { content: string }
    expect(last.content).toContain(`[1] Acme kickoff (meeting_id: ${doc})`)
    expect(last.content).toContain('<selected_text>\nship in Q3\n</selected_text>')
    expect(last.content.endsWith('Summarise')).toBe(true)
    expect(a.store.listMessages(threadId)[0].context).toEqual({ mentions: [{ id: doc, title: 'Acme kickoff' }], selectedText: 'ship in Q3', responseStyle: null })
    expect(a.store.listMessages(threadId)[1].citations).toEqual([{ n: 1, document_id: doc, title: 'Acme kickoff' }])
  })

  it('answers with the model picked for the chat and remembers it on the thread', async () => {
    const a = makeAgent(() => ({ text: 'ok' }))
    const { threadId } = a.chat.send({ text: 'q1', model: 'gemini/gemini-3.5-flash' })
    await a.settle()
    expect(a.configs.at(-1)).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash', fastModel: 'gemini-3.5-flash' })
    expect(a.store.getThread(threadId)?.model).toBe('gemini/gemini-3.5-flash')
    // Follow-ups keep the thread's model unless another is picked.
    a.chat.send({ threadId, text: 'q2' })
    await a.settle()
    expect(a.configs.at(-1)).toMatchObject({ provider: 'gemini', model: 'gemini-3.5-flash' })
    a.chat.send({ threadId, text: 'q3', model: 'auto' })
    await a.settle()
    expect(a.configs.at(-1)).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5-5' })
  })

  it('titles a thread after its first answer', async () => {
    const a = makeAgent(() => ({ text: 'Q3.' }))
    const { threadId } = a.chat.send({ text: 'When do we ship the new billing page?' })
    await a.settle()
    await new Promise((r) => setTimeout(r, 0))
    expect(a.store.getThread(threadId)?.title).toBe('summary of earlier turns')
    expect(a.chatThreads.at(-1)).toEqual({ id: threadId, title: 'summary of earlier turns' })
  })

  it('edits a sent message: drops it and what came after, and replays only the turns before it', async () => {
    const a = makeAgent((_o, i) => ({ text: `answer ${i}` }))
    const keep = await attach(a, 'keep.md', 'kept')
    const drop = await attach(a, 'drop.md', 'dropped')
    const { threadId } = a.chat.send({ text: 'first' })
    await a.settle()
    a.chat.send({ threadId, text: 'second', attachmentIds: [keep, drop] })
    await a.settle()
    a.chat.send({ threadId, text: 'third' })
    await a.settle()
    const second = a.store.listMessages(threadId)[2]
    expect(second.content).toBe('second')

    a.chat.send({ threadId, editMessageId: second.id, text: 'second, edited', attachmentIds: [keep] })
    await a.settle()
    const messages = a.store.listMessages(threadId)
    expect(messages.map((m) => m.content)).toEqual(['first', 'answer 0', 'second, edited', 'answer 3'])
    expect(messages[2].id).toBe(second.id)
    expect(messages[2].attachments.map((f) => f.name)).toEqual(['keep.md'])
    expect(a.store.getAttachment(drop)).toBeNull()
    const replayed = a.provider.steps.at(-1)!.messages
    expect(replayed.map((m) => (m.role === 'user' ? m.content : m.role))).toEqual(['first', 'assistant', 'second, edited'])
  })

  it('retries the last question after an error', async () => {
    let fail = true
    const a = makeAgent(() => {
      if (fail) throw new Error('boom')
      return { text: 'worked' }
    })
    const { threadId } = a.chat.send({ text: 'q' })
    await a.settle()
    expect(a.store.listMessages(threadId)[1]).toMatchObject({ status: 'error', error: 'boom' })
    fail = false
    a.chat.retry(threadId)
    await a.settle()
    expect(a.store.listMessages(threadId).map((m) => [m.role, m.content, m.status])).toEqual([
      ['user', 'q', 'completed'],
      ['assistant', 'worked', 'completed']
    ])
  })

  it('asks for more detail with "Say more"', async () => {
    const a = makeAgent(() => ({ text: 'ok' }))
    a.chat.send({ text: 'Can you provide more details', responseStyle: 'detailed' })
    await a.settle()
    expect((a.provider.steps[0].messages.at(-1) as { content: string }).content).toContain('more detailed answer')
  })

  it('removes a deleted thread’s files and their provider copies', async () => {
    const a = makeAgent(() => ({ text: 'ok' }))
    const id = await attach(a, 'a.md', 'x')
    const { threadId } = a.chat.send({ text: 'q', attachmentIds: [id] })
    await a.settle()
    a.store.recordUpload(id, 'gemini', { remoteId: 'files/abc' })
    a.chat.deleteThread(threadId)
    expect(a.store.getAttachment(id)).toBeNull()
    await new Promise((r) => setImmediate(r))
    expect(a.remoteDeletes).toEqual([{ provider: 'gemini', remoteId: 'files/abc' }])
  })

  it('counts recipe uses', async () => {
    const a = makeAgent(() => ({ text: 'ok' }))
    a.chat.send({ text: '/tldr' })
    await a.settle()
    expect(a.store.listRecipes().find((r) => r.slug === 'tldr')).toMatchObject({ usage_count: 1, last_used_at: expect.any(String) })
  })
})

describe('Assistant', () => {
  it('delegates to a task, which publishes a result the conversation relays; home and events are kept', async () => {
    const a = makeAgent((opts): ScriptStep => {
      const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')
      const content = lastUser && lastUser.role === 'user' ? lastUser.content : ''
      const isTask = opts.system.includes('You are working on one task')
      const hadTool = opts.messages[opts.messages.length - 1].role === 'tool'
      if (isTask) {
        if (!hadTool) return { calls: [{ name: 'draftEmail', args: { to: ['kim@acme.com'], subject: 'Follow-up', body: 'Thanks!' } }] }
        if (lastToolResults({ system: '', tools: [], messages: opts.messages }).draftEmail) return { calls: [{ name: 'publishResult', args: { status: 'done', summary: 'Drafted the follow-up', text: 'Here is the draft.' } }] }
        return { text: 'Published.' }
      }
      if (content.startsWith('[Task')) {
        if (!hadTool) return { calls: [{ name: 'publishHome', args: { briefing: 'All done.', groups: [{ title: 'Done', task_ids: [taskIds()[0]] }] } }] }
        return { text: 'Your follow-up is drafted.' }
      }
      if (!hadTool) return { text: 'On it.', calls: [{ name: 'startTask', args: { title: 'Follow-up email', handoff: 'Draft a follow-up to Kim.' } }] }
      return { text: 'Started a task.' }
    })
    const taskIds = (): string[] => a.agentStore.listTasks(a.agentStore.conversation().id).map((t) => t.id)
    const userMsg = a.assistant.send({ text: 'Write a follow-up to Kim', clientMessageId: 'c1' })
    expect(userMsg).toMatchObject({ author: 'user', client_message_id: 'c1' })
    await a.settle()

    const snap = a.assistant.open()
    expect(snap.tasks).toHaveLength(1)
    const task = snap.tasks[0]
    expect(task).toMatchObject({ kind: 'task', title: 'Follow-up email', status: 'done', summary: 'Drafted the follow-up' })
    expect(a.assistant.task(task.id)!.result).toBe('Here is the draft.')

    // Conversation: user message, the agent's reply that started the task, then its reply to the task result.
    expect(snap.messages.map((m) => [m.author, m.text])).toEqual([
      ['user', 'Write a follow-up to Kim'],
      ['agent', 'On it.\n\nStarted a task.'],
      ['agent', 'Your follow-up is drafted.']
    ])
    expect((tools(snap.messages[1].outputs)[0].result as { taskThreadId: string }).taskThreadId).toBe(task.id)
    expect(snap.home).toMatchObject({ briefing: 'All done.', groups: [{ title: 'Done', taskIds: [task.id] }] })

    // The task thread shows the handoff from the conversation and the draft card.
    const { messages } = a.assistant.readThread(task.id)
    expect(messages[0]).toMatchObject({ author: 'parent', text: 'Draft a follow-up to Kim.' })
    const draft = tools(messages[1].outputs).find((t) => t.name === 'draftEmail')!
    expect(draft.result).toMatchObject({ kind: 'email', to: ['kim@acme.com'], subject: 'Follow-up' })
    expect(a.notifications.map((n) => n.title)).toContain('Task done: Follow-up email')

    // Each run's events are numbered 1..n, and a client can resume after any sequence number.
    const runId = messages[1].run_id!
    const all = a.agentStore.eventsSince(runId, 0)
    expect(all.map((e) => e.sequence)).toEqual(all.map((_, i) => i + 1))
    expect(a.agentStore.eventsSince(runId, 3).map((e) => e.sequence)[0]).toBe(4)
    expect(all[0].event).toEqual({ type: 'run.status', status: 'running' })
    // Replaying the log reproduces the stored message.
    expect(outputsText(all.reduce((o, r) => applyAgentEvent(o, r.event), [] as AgentOutput[]))).toBe(messages[1].text)
    expect(messages[1].applied_sequence).toBeGreaterThanOrEqual(all.length - 1)
  })

  it('pauses a task for approval and resumes once the user approves', async () => {
    const a = makeAgent((opts): ScriptStep => {
      const isTask = opts.system.includes('You are working on one task')
      const last = opts.messages[opts.messages.length - 1]
      if (!isTask) return last.role === 'tool' || (last.role === 'user' && last.content.startsWith('[Task')) ? { text: 'ok' } : { calls: [{ name: 'startTask', args: { title: 'Save notes', handoff: 'Save it.' } }] }
      if (last.role !== 'tool') return { calls: [{ name: 'write_file', args: { path: 'files/notes.md', content: '# Notes' } }, { name: 'write_file', args: { path: 'memory/MEMORY.md', content: '- Kim is at Acme' } }] }
      if (lastToolResults({ system: '', tools: [], messages: opts.messages }).write_file) return { calls: [{ name: 'publishResult', args: { status: 'done', summary: 'Saved', text: 'Saved.' } }] }
      return { text: 'done' }
    })
    a.assistant.send({ text: 'Save my notes' })
    await a.settle()
    const task = a.assistant.open().tasks[0]
    expect(task.status).toBe('needs_input')
    expect(task.pending_approval).toMatchObject({ label: 'Write files/notes.md', detail: '# Notes' })
    // The memory write didn't need approval and already happened; the other waits.
    expect(readFileSync(join(a.files.root, 'memory/MEMORY.md'), 'utf8')).toBe('- Kim is at Acme')
    expect(existsSync(join(a.files.root, 'files/notes.md'))).toBe(false)
    expect(a.agentStore.lastRunForThread(task.id)!.status).toBe('waiting')
    expect(a.notifications[0].title).toBe('Cereal Assistant needs your approval')

    a.backend.decide(task.pending_approval!.id, 'approved', true)
    await a.settle()
    expect(readFileSync(join(a.files.root, 'files/notes.md'), 'utf8')).toBe('# Notes')
    expect(a.agentStore.getThread(task.id)).toMatchObject({ status: 'done', pending_approval: null })
    expect(a.settings.get().assistant.alwaysAllow).toEqual(['write_file'])
    const results = a.provider.steps.find((s, i) => i > 0 && s.system.includes('one task') && lastToolResults(s).write_file)!
    expect(lastToolResults(results).write_file).toBe('Created files/notes.md.')
  })

  it('tells the model when the user declines an action', async () => {
    const a = makeAgent((opts, i) =>
      i === 0 ? { calls: [{ name: 'createRoutine', args: { message: 'Summarise my week', schedule: 'cron(0 9 * * 1)' } }] } : opts.messages[opts.messages.length - 1].role === 'tool' ? { text: 'Okay, no routine.' } : { text: '?' }
    )
    a.assistant.send({ text: 'Every Monday summarise my week' })
    await a.settle()
    const msg = a.assistant.open().messages[1]
    const call = tools(msg.outputs)[0]
    expect(call.approval?.status).toBe('pending')
    a.backend.decide(call.approval!.id, 'denied')
    await a.settle()
    expect(lastToolResults(a.provider.steps[1]).createRoutine).toMatch(/declined/)
    expect(a.assistant.routines()).toEqual([])
    expect(tools(a.agentStore.getMessage(msg.id)!.outputs)[0]).toMatchObject({ approval: { status: 'denied', label: expect.stringContaining('Create a routine') }, completed: true, error: 'Declined' })
  })

  it('creates routines that fire into the inbox on schedule', async () => {
    const a = makeAgent((opts, i) => {
      if (i === 0) return { calls: [{ name: 'createRoutine', args: { message: 'Check my calendar', schedule: 'rate(1 hour)', timezone: 'Europe/London' } }] }
      return { text: opts.messages[opts.messages.length - 1].role === 'user' ? 'Checked.' : 'Routine set.' }
    }, { settings: { assistant: { alwaysAllow: ['createRoutine'] } } })
    a.assistant.send({ text: 'Check my calendar hourly' })
    await a.settle()
    const [routine] = a.assistant.routines()
    expect(routine).toMatchObject({ expression: 'rate(1 hour)', timezone: 'Europe/London', enabled: true, description: 'Every hour' })
    a.assistant.tick(new Date(Date.parse(routine.next_fire_at!) + 1_000))
    await a.settle()
    const input = a.provider.steps[a.provider.steps.length - 1].messages.at(-1)
    expect(input).toMatchObject({ role: 'user', content: expect.stringMatching(/^\[Routine .*: Every hour, .*\] Check my calendar$/) })
    expect(Date.parse(a.assistant.routines()[0].next_fire_at!)).toBeGreaterThan(Date.parse(routine.next_fire_at!))
  })

  it('holds idle and batched inbox items until they are due', () => {
    const a = makeAgent(() => ({ text: 'ok' }))
    const conv = a.agentStore.conversation()
    a.agentStore.enqueue({ threadId: conv.id, source: 'event', message: 'idle', delivery: 'idle' })
    expect(a.agentStore.readyInboxThreads(new Date().toISOString(), false)).toEqual([])
    expect(a.agentStore.readyInboxThreads(new Date().toISOString(), true)).toEqual([conv.id])
    const other = a.agentStore.createThread({ kind: 'task', parentId: conv.id, title: 't', status: 'active' })
    a.agentStore.enqueue({ threadId: other.id, source: 'event', message: 'b', delivery: 'batch', delaySeconds: 60 })
    expect(a.agentStore.readyInboxThreads(new Date().toISOString(), false)).toEqual([])
    expect(a.agentStore.readyInboxThreads(new Date(Date.now() + 61_000).toISOString(), false)).toEqual([other.id])
  })

  it('fails runs interrupted by a restart but keeps runs waiting for approval', () => {
    const a = makeAgent(() => ({ text: 'ok' }))
    a.backend.host = null
    const conv = a.agentStore.conversation()
    const m1 = a.agentStore.addMessage(conv.id, { author: 'agent', status: 'in_progress' })
    const running = a.agentStore.createRun({ kind: 'assistant', threadId: conv.id, messageId: m1.id, context: 'conversation' })
    a.agentStore.updateRun(running.id, { status: 'running' })
    const waiting = a.agentStore.createRun({ kind: 'assistant', threadId: conv.id, messageId: m1.id, context: 'conversation' })
    a.agentStore.updateRun(waiting.id, { status: 'waiting', pending: { results: [], waiting: [] } })
    a.backend.recover()
    expect(a.agentStore.getRun(running.id)).toMatchObject({ status: 'failed', error: 'Cereal was closed before this finished.' })
    expect(a.agentStore.getRun(waiting.id)!.status).toBe('waiting')
    expect(a.agentStore.getMessage(m1.id)!.status).toBe('error')
  })

  it('archives the conversation on reset', async () => {
    const a = makeAgent(() => ({ text: 'hi' }))
    a.assistant.send({ text: 'hello' })
    await a.settle()
    const before = a.assistant.open().conversation.id
    const after = a.assistant.reset()
    expect(after.conversation.id).not.toBe(before)
    expect(after.messages).toEqual([])
  })
})
