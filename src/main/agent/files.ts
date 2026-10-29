import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { AgentFileEntry, AgentSkill } from '@shared/agent'

// The Assistant's own folder (<userData>/agent): memory/ for what it learns about the user, skills/ for SKILL.md
// playbooks (Granola's skill-library format) and files/ for anything else it writes. Agent tools can't reach
// anything outside it.

export const MAX_FILE_BYTES = 1_000_000
const READ_LIMIT_CHARS = 60_000
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export class AgentFiles {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
    for (const d of ['memory', 'skills', 'files']) mkdirSync(join(this.root, d), { recursive: true })
  }

  /** Resolve a path the model gave, refusing anything that leaves the agent folder (including through symlinks). */
  resolve(path: string): string {
    const clean = path.trim().replace(/^\.\/+/, '') || '.'
    if (isAbsolute(clean) || clean.includes('\0')) throw new Error('Use a path relative to the agent folder, like memory/MEMORY.md.')
    const target = resolve(this.root, clean)
    const rel = relative(this.root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('That path is outside the agent folder.')
    // The lexical check above can be fooled by a symlink inside the folder; check the real location too.
    const realRoot = realpathSync(this.root)
    let existing = target
    while (!existsSync(existing)) existing = dirname(existing)
    const realRel = relative(realRoot, realpathSync(existing))
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error('That path is outside the agent folder.')
    return target
  }

  relative(abs: string): string {
    return relative(this.root, abs).split(sep).join('/') || '.'
  }

  list(path = '.'): AgentFileEntry[] {
    const dir = this.resolve(path)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${path} is not a folder.`)
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.'))
      .map((d) => {
        const abs = join(dir, d.name)
        const st = statSync(abs)
        return { path: this.relative(abs), name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, modified_at: st.mtime.toISOString() }
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  }

  read(path: string, offset = 0, limit = READ_LIMIT_CHARS): { content: string; truncated: boolean; size: number } {
    const abs = this.resolve(path)
    if (!existsSync(abs)) throw new Error(`${path} doesn't exist.`)
    if (statSync(abs).isDirectory()) throw new Error(`${path} is a folder; list it instead.`)
    const text = readFileSync(abs, 'utf8')
    const content = text.slice(offset, offset + limit)
    return { content, truncated: offset + limit < text.length, size: text.length }
  }

  write(path: string, content: string): { created: boolean; path: string } {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new Error('Files are limited to 1 MB.')
    const abs = this.resolve(path)
    if (existsSync(abs) && statSync(abs).isDirectory()) throw new Error(`${path} is a folder.`)
    const created = !existsSync(abs)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
    return { created, path: this.relative(abs) }
  }

  /** Replace one exact, unique occurrence of `oldText`. */
  edit(path: string, oldText: string, newText: string): { path: string } {
    const abs = this.resolve(path)
    if (!existsSync(abs)) throw new Error(`${path} doesn't exist.`)
    if (!oldText) throw new Error('old_text must not be empty.')
    const text = readFileSync(abs, 'utf8')
    const first = text.indexOf(oldText)
    if (first < 0) throw new Error(`old_text was not found in ${path}. Read the file and copy the text exactly.`)
    if (text.indexOf(oldText, first + 1) >= 0) throw new Error(`old_text appears more than once in ${path}. Include more surrounding text so it is unique.`)
    const next = text.slice(0, first) + newText + text.slice(first + oldText.length)
    if (Buffer.byteLength(next) > MAX_FILE_BYTES) throw new Error('Files are limited to 1 MB.')
    writeFileSync(abs, next, 'utf8')
    return { path: this.relative(abs) }
  }

  /** What the Assistant knows about the user: memory/MEMORY.md plus the names of other memory files. */
  memoryIndex(maxChars = 8_000): string {
    const index = join(this.root, 'memory', 'MEMORY.md')
    const body = existsSync(index) ? readFileSync(index, 'utf8').slice(0, maxChars) : ''
    const others = existsSync(join(this.root, 'memory'))
      ? readdirSync(join(this.root, 'memory')).filter((f) => f !== 'MEMORY.md' && !f.startsWith('.'))
      : []
    return [body.trim() || '(memory/MEMORY.md is empty.)', others.length ? `Other memory files: ${others.map((f) => `memory/${f}`).join(', ')}` : ''].filter(Boolean).join('\n\n')
  }

  /** Skills in skills/<name>/SKILL.md, validated like Granola's skill library. Invalid ones are reported, not loaded. */
  skills(): { skills: AgentSkill[]; errors: { path: string; message: string }[] } {
    const dir = join(this.root, 'skills')
    const skills: AgentSkill[] = []
    const errors: { path: string; message: string }[] = []
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      const path = `skills/${d.name}/SKILL.md`
      const file = join(dir, d.name, 'SKILL.md')
      if (!existsSync(file)) {
        errors.push({ path, message: 'add a SKILL.md file' })
        continue
      }
      try {
        const meta = parseFrontmatter(readFileSync(file, 'utf8'))
        const name = meta.name ?? ''
        const description = (meta.description ?? '').trim()
        if (!SKILL_NAME.test(name) || name.length > 64) throw new Error('name must be lowercase words joined by hyphens, at most 64 characters')
        if (name !== d.name) throw new Error('name must match its folder')
        if (!description || description.length > 1024) throw new Error('description must be 1–1024 characters')
        skills.push({ name, description, path })
      } catch (e) {
        errors.push({ path, message: (e as Error).message })
      }
    }
    return { skills: skills.sort((a, b) => a.name.localeCompare(b.name)), errors }
  }

  readSkill(name: string): string {
    const skill = this.skills().skills.find((s) => s.name === name)
    if (!skill) throw new Error(`There is no skill called "${name}".`)
    return readFileSync(join(this.root, skill.path), 'utf8')
  }

  /** Give a new agent folder one example skill so the format is discoverable. */
  seedStarterSkill(): void {
    const file = join(this.root, 'skills', 'meeting-follow-up', 'SKILL.md')
    const marker = join(this.root, '.seeded')
    if (existsSync(marker)) return
    writeFileSync(marker, new Date().toISOString())
    if (existsSync(file)) return
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, STARTER_SKILL, 'utf8')
  }
}

/** Minimal YAML frontmatter: `key: value` scalars between leading --- lines. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!m) throw new Error('add frontmatter with name and description')
  const out: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/)
    if (!kv) continue
    out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

const STARTER_SKILL = `---
name: meeting-follow-up
description: Draft a follow-up email after a meeting, with decisions, owners and next steps.
---

# Meeting follow-up

1. Find the meeting with searchMeetings or listMeetings, then readMeetings for its notes and summary.
2. Pull out what was decided, who owns each next step and any dates. Check the transcript with readTranscript when the notes are thin.
3. Draft the email with draftEmail: a one-line thank-you, a short "What we agreed" list, "Next steps" with owners, and a friendly close.
   Address it to the other attendees (not the user). Keep it under 150 words.
4. If you can't tell who the email should go to, say so and leave "to" empty rather than guessing.
`
