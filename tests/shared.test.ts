import { describe, expect, it } from 'vitest'
import { compareChunks, deletePartialChunks, finalizeChunks, formatTranscript, groupChunks, groupTurns, maxNumHeadings, mergeTranscriptChunks, transcriptLabels } from '@shared/transcript'
import { docToMarkdown, docToPlainText, extractUrls } from '@shared/markdown'
import { computeGeneratedLines } from '@shared/attribution'
import type { TranscriptChunk } from '@shared/types'

const t0 = Date.parse('2026-10-19T15:00:00.000Z')
function chunk(id: string, startS: number, endS: number, text: string, opts: Partial<TranscriptChunk> = {}): TranscriptChunk {
  return {
    id,
    document_id: 'd1',
    source: 'microphone',
    text,
    start_timestamp: new Date(t0 + startS * 1000).toISOString(),
    end_timestamp: new Date(t0 + endS * 1000).toISOString(),
    is_final: true,
    ...opts
  }
}

describe('transcript merge (Granola mergeTranscriptChunks semantics)', () => {
  it('replaces an interim chunk in place when the final arrives with the same id', () => {
    let list = mergeTranscriptChunks([], [chunk('a', 0, 1, 'hel', { is_final: false })])
    list = mergeTranscriptChunks(list, [chunk('a', 0, 2, 'hello there', { is_final: false })])
    list = mergeTranscriptChunks(list, [chunk('a', 0, 2, 'Hello there.', { is_final: true })])
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'a', text: 'Hello there.', is_final: true })
  })

  it('keeps chunks from both sources sorted by start, end, id', () => {
    const list = mergeTranscriptChunks(
      [chunk('b', 5, 6, 'second', { source: 'system' })],
      [chunk('a', 1, 2, 'first'), chunk('c', 5, 7, 'third'), chunk('0', 5, 6, 'tie')]
    )
    expect(list.map((c) => c.id)).toEqual(['a', '0', 'b', 'c'])
    expect([...list].sort(compareChunks)).toEqual(list)
  })

  it('drops chunks whose text became empty', () => {
    const list = mergeTranscriptChunks([chunk('a', 0, 1, 'uh', { is_final: false })], [chunk('a', 0, 1, '', { is_final: true })])
    expect(list).toEqual([])
  })

  it('deletes partials for one source and finalizes the rest', () => {
    const list = [chunk('a', 0, 1, 'x', { is_final: false }), chunk('b', 1, 2, 'y', { is_final: false, source: 'system' }), chunk('c', 2, 3, 'z')]
    expect(deletePartialChunks(list, 'microphone').map((c) => c.id)).toEqual(['b', 'c'])
    expect(finalizeChunks(list).every((c) => c.is_final)).toBe(true)
  })
})

describe('transcript bubbles (Granola chunk grouping)', () => {
  it('keeps one source in one bubble until a chunk ends with a full stop', () => {
    const groups = groupChunks([
      chunk('1', 0, 1, 'so the budget'),
      chunk('2', 1, 2, 'is fifty k.'),
      chunk('3', 2, 3, 'And we ship in Q3'),
      chunk('4', 3, 4, 'maybe', { is_final: false })
    ])
    expect(groups.map((g) => g.map((c) => c.id))).toEqual([['1', '2'], ['3', '4']])
  })

  it('starts a new bubble when the speaker changes and skips blank chunks', () => {
    const groups = groupChunks([chunk('1', 0, 1, 'Hi'), chunk('2', 1, 2, '  '), chunk('3', 1, 2, 'Hello', { source: 'system' }), chunk('4', 2, 3, 'there', { source: 'system' })])
    expect(groups.map((g) => g.map((c) => c.id))).toEqual([['1'], ['3', '4']])
  })
})

describe('transcript formatting', () => {
  it('groups consecutive chunks by speaker and labels You/Them with relative timestamps', () => {
    const chunks = [chunk('1', 0, 2, 'Hi, thanks for joining.'), chunk('2', 2, 4, 'Let us start.'), chunk('3', 65, 70, 'Sounds good.', { source: 'system' })]
    expect(groupTurns(chunks)).toHaveLength(2)
    expect(formatTranscript(chunks)).toBe('[00:00] You: Hi, thanks for joining. Let us start.\n[01:05] Them: Sounds good.')
    expect(formatTranscript(chunks, { timestamps: false, labels: { microphone: 'Ana (me)' } })).toBe('Ana (me): Hi, thanks for joining. Let us start.\nThem: Sounds good.')
  })

  it('breaks a long monologue into turns of at most a minute', () => {
    // Five minutes of back-to-back 10 s chunks from one source, as in a lecture.
    const lecture = Array.from({ length: 30 }, (_, i) => chunk(String(i).padStart(2, '0'), i * 10, i * 10 + 10, `Point ${i}.`))
    const turns = groupTurns(lecture)
    expect(turns).toHaveLength(5)
    expect(turns.every((t) => Date.parse(t.end) - Date.parse(t.start) <= 60_000)).toBe(true)
    expect(turns.flatMap((t) => t.chunkIds)).toHaveLength(30)
    expect(formatTranscript(lecture, { labels: transcriptLabels('lecture') }).split('\n')[1]).toBe('[01:00] Speaker: Point 6. Point 7. Point 8. Point 9. Point 10. Point 11.')
  })

  it('labels the microphone by note mode', () => {
    expect(transcriptLabels('meeting')).toEqual({ microphone: 'You', system: 'Them' })
    expect(transcriptLabels('lecture').microphone).toBe('Speaker')
  })

  it('ignores interim chunks when formatting for prompts', () => {
    expect(formatTranscript([chunk('1', 0, 1, 'draft', { is_final: false })])).toBe('')
  })

  it('computes the heading budget from transcript length', () => {
    expect(maxNumHeadings(100)).toBe(4)
    expect(maxNumHeadings(10_000)).toBe(5)
    expect(maxNumHeadings(45_000)).toBe(5)
    expect(maxNumHeadings(79_999)).toBe(8)
    expect(maxNumHeadings(500_000)).toBe(8)
  })
})

describe('notepad markdown', () => {
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Agenda' }] },
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Pricing ' }, { type: 'text', text: 'v2', marks: [{ type: 'bold' }] }] },
              { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'annual discount' }] }] }] }
            ]
          },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'see docs', marks: [{ type: 'link', attrs: { href: 'https://x.dev/a' } }] }] }] }
        ]
      },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'send deck' }] }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Plain ' }, { type: 'text', text: 'code', marks: [{ type: 'code' }] }] }
    ]
  }

  it('serialises headings, nested lists, tasks and marks', () => {
    expect(docToMarkdown(doc)).toBe(
      ['## Agenda', '', '- Pricing **v2**', '  - annual discount', '- [see docs](https://x.dev/a)', '', '- [x] send deck', '', 'Plain `code`'].join('\n')
    )
  })

  it('extracts plain text lines and urls', () => {
    expect(docToPlainText(doc)).toBe('Agenda\nPricing v2\nannual discount\nsee docs\nsend deck\nPlain code')
    expect(extractUrls('see https://a.com/x and (https://b.org).')).toEqual(['https://a.com/x', 'https://b.org'])
    expect(docToMarkdown(null)).toBe('')
  })
})

describe('generated line attribution', () => {
  it('marks lines that come from the user notes as user-authored', () => {
    const notes = '- budget is 50k\n- ship in Q3\n- Ana owns hiring'
    const output = ['### Budget', '- Budget is $50k for the pilot', '- Finance needs sign-off by Friday', '', '### Timeline', '- Ship in Q3', '- ana owns hiring plan'].join('\n')
    expect(computeGeneratedLines(output, notes)).toEqual([0, 2, 4])
  })

  it('treats user headings as user-authored', () => {
    expect(computeGeneratedLines('## Agenda\n- new point', '## Agenda')).toEqual([1])
  })

  it('marks everything generated when there are no notes', () => {
    expect(computeGeneratedLines('### A\n- b', '')).toEqual([0, 1])
  })
})
