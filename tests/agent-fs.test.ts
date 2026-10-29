import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentFiles, parseFrontmatter } from '../src/main/agent/files'
import { assertTimezone, describeSchedule, nextFireAfter, parseSchedule } from '../src/main/agent/schedule'
import { writeFile } from '../src/main/agent/tools/files'
import { policyFor } from '../src/main/agent/tool'

function files(): AgentFiles {
  return new AgentFiles(mkdtempSync(join(tmpdir(), 'cereal-files-')))
}

describe('agent folder', () => {
  it('keeps every path inside the agent folder', () => {
    const f = files()
    const outside = mkdtempSync(join(tmpdir(), 'cereal-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(outside, join(f.root, 'files', 'link'))
    expect(() => f.resolve('../x')).toThrow(/outside/)
    expect(() => f.resolve('memory/../../x')).toThrow(/outside/)
    expect(() => f.resolve('/etc/passwd')).toThrow(/relative/)
    expect(() => f.read('files/link/secret.txt')).toThrow(/outside/)
    expect(() => f.write('files/link/new.txt', 'x')).toThrow(/outside/)
    expect(f.resolve('./memory/MEMORY.md')).toBe(join(f.root, 'memory', 'MEMORY.md'))
  })

  it('writes, reads, lists and edits with a unique match', () => {
    const f = files()
    expect(f.write('memory/MEMORY.md', '- Kim works at Acme\n- Kim likes tea')).toEqual({ created: true, path: 'memory/MEMORY.md' })
    expect(f.write('memory/MEMORY.md', '- Kim works at Acme\n- Kim likes tea\n- Bo is the CFO').created).toBe(false)
    expect(() => f.edit('memory/MEMORY.md', 'Kim', 'Kimberly')).toThrow(/more than once/)
    expect(() => f.edit('memory/MEMORY.md', 'Zed', 'x')).toThrow(/not found/)
    f.edit('memory/MEMORY.md', 'likes tea', 'likes coffee')
    expect(f.read('memory/MEMORY.md').content).toContain('Kim likes coffee')
    expect(f.list('memory').map((e) => e.path)).toEqual(['memory/MEMORY.md'])
    expect(f.list('.').map((e) => [e.name, e.dir])).toEqual([
      ['files', true],
      ['memory', true],
      ['skills', true]
    ])
    expect(f.memoryIndex()).toContain('Bo is the CFO')
    expect(() => f.write('files/big.txt', 'x'.repeat(1_000_001))).toThrow(/1 MB/)
  })

  it('needs approval to write outside memory/, even through ..', () => {
    expect(policyFor(writeFile, { path: 'memory/notes.md', content: '' })).toBe('allow')
    expect(policyFor(writeFile, { path: './memory/a/b.md', content: '' })).toBe('allow')
    expect(policyFor(writeFile, { path: 'memory/../files/x.md', content: '' })).toBe('ask')
    expect(policyFor(writeFile, { path: 'skills/x/SKILL.md', content: '' })).toBe('ask')
  })

  it('loads skills that follow the SKILL.md rules and reports the rest', () => {
    const f = files()
    f.seedStarterSkill()
    const skill = (dir: string, text: string): void => {
      mkdirSync(join(f.root, 'skills', dir), { recursive: true })
      writeFileSync(join(f.root, 'skills', dir, 'SKILL.md'), text)
    }
    skill('prep-brief', '---\nname: prep-brief\ndescription: "Prepare a brief before a meeting"\n---\nSteps…')
    skill('Bad_Name', '---\nname: Bad_Name\ndescription: x\n---\n')
    skill('mismatch', '---\nname: other\ndescription: x\n---\n')
    skill('no-front', 'just text')
    mkdirSync(join(f.root, 'skills', 'empty'))
    const { skills, errors } = f.skills()
    expect(skills.map((s) => s.name)).toEqual(['meeting-follow-up', 'prep-brief'])
    expect(skills[1].description).toBe('Prepare a brief before a meeting')
    expect(Object.fromEntries(errors.map((e) => [e.path, e.message]))).toEqual({
      'skills/Bad_Name/SKILL.md': expect.stringMatching(/lowercase/),
      'skills/mismatch/SKILL.md': 'name must match its folder',
      'skills/no-front/SKILL.md': expect.stringMatching(/frontmatter/),
      'skills/empty/SKILL.md': 'add a SKILL.md file'
    })
    expect(f.readSkill('prep-brief')).toContain('Steps…')
    expect(parseFrontmatter("---\nname: a\nlicense: 'MIT'\n---\n")).toEqual({ name: 'a', license: 'MIT' })
  })
})

describe('routine schedules', () => {
  it('parses at, rate and cron and rejects anything else', () => {
    expect(parseSchedule('rate(15 minutes)')).toMatchObject({ kind: 'rate', ms: 900_000 })
    expect(parseSchedule('rate(1 day)')).toMatchObject({ kind: 'rate', ms: 86_400_000 })
    expect(parseSchedule('cron(0 9 * * 1-5 *)')).toMatchObject({ kind: 'cron' })
    expect(() => parseSchedule('every day')).toThrow(/at\(/)
    expect(() => parseSchedule('rate(1 minute)')).toThrow(/5 minutes/)
    expect(() => parseSchedule('cron(61 * * * *)')).toThrow(/out of range/)
    expect(() => parseSchedule('cron(* * *)')).toThrow(/five fields/)
    expect(() => assertTimezone('Mars/Olympus')).toThrow(/timezone/)
  })

  it('computes the next fire in the routine timezone, across DST', () => {
    const after = new Date('2026-10-19T12:00:00Z') // a Monday
    // 09:00 on weekdays in New York (UTC-4 in October): it's 08:00 there, so later the same Monday, 13:00 UTC.
    expect(nextFireAfter('cron(0 9 * * 1-5)', after, 'America/New_York')!.toISOString()).toBe('2026-10-19T13:00:00.000Z')
    // From Friday evening, the next weekday is Monday.
    expect(nextFireAfter('cron(0 9 * * 1-5)', new Date('2026-10-23T22:00:00Z'), 'America/New_York')!.toISOString()).toBe('2026-10-26T13:00:00.000Z')
    // Sunday names and 7 = Sunday.
    expect(nextFireAfter('cron(30 8 * * sun)', after, 'UTC')!.toISOString()).toBe('2026-10-25T08:30:00.000Z')
    expect(nextFireAfter('cron(30 8 * * 7)', after, 'UTC')!.toISOString()).toBe('2026-10-25T08:30:00.000Z')
    // London leaves summer time on 2026-10-25: 09:00 local is 08:00 UTC before and 09:00 UTC after.
    expect(nextFireAfter('cron(0 9 * * *)', new Date('2026-10-24T09:00:00Z'), 'Europe/London')!.toISOString()).toBe('2026-10-25T09:00:00.000Z')
    expect(nextFireAfter('cron(*/15 * * * *)', new Date('2026-10-19T12:07:00Z'), 'UTC')!.toISOString()).toBe('2026-10-19T12:15:00.000Z')
    expect(nextFireAfter('cron(0 0 1 jan *)', after, 'UTC')!.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    // at() is wall-clock time in the timezone, and fires once.
    expect(nextFireAfter('at(2026-10-21T09:00)', after, 'Europe/Paris')!.toISOString()).toBe('2026-10-21T07:00:00.000Z')
    expect(nextFireAfter('at(2026-10-01T09:00)', after, 'UTC')).toBeNull()
    expect(nextFireAfter('rate(2 hours)', after, 'UTC')!.toISOString()).toBe('2026-10-19T14:00:00.000Z')
  })

  it('describes schedules for people', () => {
    expect(describeSchedule('rate(1 hour)', 'UTC')).toBe('Every hour')
    expect(describeSchedule('rate(30 minutes)', 'UTC')).toBe('Every 30 minutes')
    expect(describeSchedule('cron(0 9 * * 1-5)', 'UTC')).toBe('Weekdays at 09:00')
    expect(describeSchedule('cron(15 7 * * *)', 'UTC')).toBe('Every day at 07:15')
    expect(describeSchedule('at(2026-10-21T09:00)', 'Europe/Paris')).toBe('Once, 2026-10-21 at 09:00 (Europe/Paris)')
  })
})
