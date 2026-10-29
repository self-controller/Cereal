import { describe, expect, it } from 'vitest'
import { dominance, identifiableSpeakers, oneOnOnePartner, resolveSpeakers, speakerKey, unnamedSpeakers, type SpeakerContext } from '@shared/speakers'
import { echoChunkIds } from '@shared/micBleed'
import { formatTranscript, groupChunks } from '@shared/transcript'
import type { Attendee, TranscriptChunk } from '@shared/types'

const t0 = Date.parse('2026-10-19T15:00:00.000Z')
function chunk(id: string, startS: number, text: string, opts: Partial<TranscriptChunk> = {}): TranscriptChunk {
  return {
    id,
    document_id: 'd1',
    source: 'system',
    text,
    start_timestamp: new Date(t0 + startS * 1000).toISOString(),
    end_timestamp: new Date(t0 + (startS + 2) * 1000).toISOString(),
    is_final: true,
    ...opts
  }
}
const mic = (id: string, startS: number, text: string, speaker?: string): TranscriptChunk =>
  chunk(id, startS, text, { source: 'microphone', ...(speaker === undefined ? {} : { speaker, speaker_session: 'r-microphone-0' }) })
const sys = (id: string, startS: number, text: string, speaker?: string): TranscriptChunk =>
  chunk(id, startS, text, speaker === undefined ? {} : { speaker, speaker_session: 'r-system-0' })

const me: Attendee = { name: 'Dana Lee', email: 'dana@acme.com', self: true }
const alex: Attendee = { name: 'Alex Kim', email: 'alex@other.com' }
const sam: Attendee = { name: 'Sam Roe', email: 'sam@other.com' }
const ctx = (over: Partial<SpeakerContext> = {}): SpeakerContext => ({ mode: 'meeting', people: [], assignments: {}, profile: { name: 'Dana Lee', email: 'dana@acme.com' }, ...over })
const x = (n: number): string => 'x'.repeat(n)

describe('speaker keys and dominance', () => {
  it('keys diarized chunks by source, session and label, and plain chunks by source', () => {
    expect(speakerKey(sys('a', 0, 'hi', '1'))).toBe('system:r-system-0:1')
    expect(speakerKey(mic('b', 0, 'hi'))).toBe('microphone')
  })

  it('needs a unique maximum of characters', () => {
    const d = dominance([sys('a', 0, x(30), '0'), sys('b', 2, x(10), '1')])
    expect(d.get('system|r-system-0')).toEqual({ label: '0', share: 0.75 })
    expect(dominance([sys('a', 0, x(10), '0'), sys('b', 2, x(10), '1')]).get('system|r-system-0')!.label).toBeNull()
  })

  it('finds the other attendee of a 1:1 that includes the note-taker', () => {
    expect(oneOnOnePartner([me, alex], {})).toEqual(alex)
    expect(oneOnOnePartner([{ ...me, self: false }, alex], { email: 'DANA@acme.com' })).toEqual(alex)
    expect(oneOnOnePartner([me, alex, sam], {})).toBeNull()
    expect(oneOnOnePartner([alex, sam], {})).toBeNull()
  })
})

describe('resolveSpeakers', () => {
  it('names the call audio after the other attendee of a 1:1 when one voice dominates (≥ 0.75)', () => {
    const chunks = [mic('m', 0, 'Morning!', '0'), sys('a', 1, x(75), '0'), sys('b', 3, x(25), '1')]
    const view = resolveSpeakers(chunks, ctx({ people: [me, alex] }))
    expect(chunks.map(view.labelOf)).toEqual(['You', 'Alex Kim', 'Alex Kim'])
    expect(view.speakerOf(chunks[1])).toMatchObject({ origin: 'calendar', email: 'alex@other.com' })
    expect(view.attributed).toBe(true)
  })

  it('numbers the voices of a 1:1 when none dominates enough', () => {
    const chunks = [mic('m', 0, 'Morning!', '0'), sys('a', 1, x(74), '0'), sys('b', 3, x(26), '1')]
    expect(chunks.map(resolveSpeakers(chunks, ctx({ people: [me, alex] })).labelOf)).toEqual(['You', 'Speaker 1', 'Speaker 2'])
  })

  it('numbers remote voices in a group call by first appearance', () => {
    const chunks = [sys('a', 0, 'One.', '1'), mic('m', 1, 'Me.', '0'), sys('b', 3, 'Two.', '0'), sys('c', 5, 'One again.', '1')]
    const view = resolveSpeakers(chunks, ctx({ people: [me, alex, sam] }))
    expect(chunks.map(view.labelOf)).toEqual(['Speaker 1', 'You', 'Speaker 2', 'Speaker 1'])
    expect(unnamedSpeakers(view).map((s) => s.label)).toEqual(['Speaker 1', 'Speaker 2'])
    expect(identifiableSpeakers(view)).toHaveLength(2)
  })

  it('treats the dominant mic voice as the note-taker at 0.9 (0.75 in a 1:1)', () => {
    const room = [mic('a', 0, x(85), '0'), mic('b', 2, x(15), '1'), sys('s', 4, 'Hello.')]
    expect(room.map(resolveSpeakers(room, ctx()).labelOf)).toEqual(['Speaker 1', 'Speaker 2', 'Them'])
    const enough = [mic('a', 0, x(90), '0'), mic('b', 2, x(10), '1')]
    expect(enough.map(resolveSpeakers(enough, ctx()).labelOf)).toEqual(['You', 'Speaker 1'])
    const oneOnOne = [mic('a', 0, x(80), '0'), mic('b', 2, x(20), '1'), sys('s', 4, 'Hi.', '0')]
    expect(oneOnOne.map(resolveSpeakers(oneOnOne, ctx({ people: [me, alex] })).labelOf)).toEqual(['You', 'Speaker 1', 'Alex Kim'])
  })

  it('numbers every mic voice in a lecture', () => {
    const chunks = [mic('a', 0, x(95), '0'), mic('b', 2, x(5), '1')]
    expect(chunks.map(resolveSpeakers(chunks, ctx({ mode: 'lecture' })).labelOf)).toEqual(['Speaker 1', 'Speaker 2'])
    expect(resolveSpeakers([mic('c', 0, 'hi')], ctx({ mode: 'lecture' })).labelOf(mic('c', 0, 'hi'))).toBe('Speaker')
  })

  it('falls back to stream labels without diarization, still naming a 1:1', () => {
    const chunks = [mic('m', 0, 'Hi.'), sys('s', 1, 'Hello.')]
    const plain = resolveSpeakers(chunks, ctx())
    expect(chunks.map(plain.labelOf)).toEqual(['You', 'Them'])
    expect(plain.attributed).toBe(false)
    expect(identifiableSpeakers(plain)).toHaveLength(0)
    const named = resolveSpeakers(chunks, ctx({ people: [me, alex] }))
    expect(chunks.map(named.labelOf)).toEqual(['You', 'Alex Kim'])
    expect(identifiableSpeakers(named).map((s) => s.label)).toEqual(['Alex Kim'])
  })

  it('lets user names win, keeps numbering stable, and merges same-named voices', () => {
    const chunks = [sys('a', 0, 'One', '0'), sys('c', 2, 'three', '2'), sys('b', 4, 'two', '1'), sys('d', 6, 'four', '3')]
    const view = resolveSpeakers(
      chunks,
      ctx({ assignments: { 'system:r-system-0:0': { name: 'Priya' }, 'system:r-system-0:2': { name: 'Priya' }, 'system:r-system-0:1': { name: 'x', self: true } }, selfLabel: 'Dana (me)' })
    )
    expect(chunks.map(view.labelOf)).toEqual(['Priya', 'Priya', 'Dana (me)', 'Speaker 4'])
    expect(view.speakerOf(chunks[1])).toMatchObject({ origin: 'user', autoLabel: 'Speaker 2' })
    expect(groupChunks(chunks, view.labelOf).map((g) => g.map((c) => c.id))).toEqual([['a', 'c'], ['b'], ['d']])
  })

  it('picks each speaker’s longest final chunk as their sample', () => {
    const chunks = [sys('a', 0, 'Short.', '0'), sys('b', 2, 'A much longer line.', '0'), chunk('c', 4, 'Longest line of all, still typing', { speaker: '0', speaker_session: 'r-system-0', is_final: false })]
    expect(resolveSpeakers(chunks, ctx()).speakers[0].sampleChunkId).toBe('b')
  })
})

describe('mic echo guard', () => {
  it('hides mic chunks that repeat overlapping call audio', () => {
    const chunks = [sys('s', 10, 'We should ship the release on Friday.'), mic('echo', 10.5, 'we should ship the release Friday'), mic('mine', 10.5, 'Sounds good to me, Friday works.'), mic('later', 30, 'we should ship the release on Friday')]
    expect([...echoChunkIds(chunks)]).toEqual(['echo'])
  })

  it('ignores short mic chunks and interims', () => {
    const chunks = [sys('s', 0, 'Yes okay sure.'), mic('short', 0, 'Yes okay'), mic('interim', 0, 'Yes okay sure.', undefined)]
    chunks[2].is_final = false
    expect(echoChunkIds(chunks).size).toBe(0)
  })

  it('leaves echoes out of resolved speakers and formatted transcripts', () => {
    const chunks = [sys('s', 0, 'Can everyone see my screen now?', '0'), mic('echo', 0.2, 'can everyone see my screen now'), mic('m', 3, 'Yes, I can.')]
    const view = resolveSpeakers(chunks, ctx())
    expect(view.echo.has('echo')).toBe(true)
    expect(formatTranscript(chunks, { speakers: view, timestamps: false })).toBe('Speaker 1: Can everyone see my screen now?\nYou: Yes, I can.')
  })
})
