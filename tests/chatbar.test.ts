import { describe, expect, it } from 'vitest'
import { THINKING_ROTATE_MS, THINKING_WORDS, chatPlaceholder, detectTrigger, exactRecipe, fuzzyScore, rankRecipes, titleCaseSlug } from '@shared/chatbar'
import { choiceLabel, parseModelChoice } from '@shared/models'
import { missingEnvSections } from '../src/main/settings.pure'
import type { Recipe } from '@shared/types'

const recipe = (slug: string, extra: Partial<Recipe> = {}): Recipe => ({
  id: `id-${slug}`,
  slug,
  name: titleCaseSlug(slug),
  prompt: 'p',
  description: '',
  builtin: true,
  updated_at: '2026-10-01T00:00:00Z',
  usage_count: 0,
  last_used_at: null,
  ...extra
})

describe('chat bar placeholder', () => {
  it('picks the first state that applies', () => {
    expect(chatPlaceholder({ surface: 'meeting' })).toBe('Ask anything')
    expect(chatPlaceholder({ surface: 'folder' })).toBe('Ask about folder')
    expect(chatPlaceholder({ surface: 'global', override: 'What did I promise?' })).toBe('What did I promise?')
    expect(chatPlaceholder({ surface: 'global', disabled: true, disabledMessage: 'Add a note first' })).toBe('Add a note first')
    expect(chatPlaceholder({ surface: 'global', transcribing: true, collapsed: true, streamingText: true })).toBe('Transcribing...')
    expect(chatPlaceholder({ surface: 'global', collapsed: true, streamingText: true })).toBe('Replying...')
    expect(chatPlaceholder({ surface: 'global', selectionPending: true, hasMessages: true, collapsed: true })).toBe('Chat with selected text')
    expect(chatPlaceholder({ surface: 'global', hasMessages: true, collapsed: true })).toBe('Continue chat')
    expect(chatPlaceholder({ surface: 'global', hasMessages: true })).toBe('Ask anything')
    expect(chatPlaceholder({ surface: 'global', noteDragOver: true })).toMatch(/Drop the note/)
  })

  it('starts with "Thinking..." and then rotates without repeating a word back to back', () => {
    const since = 1_000_000
    expect(chatPlaceholder({ surface: 'global', collapsed: true, thinkingSince: since, now: since + 100 })).toBe('Thinking...')
    const words = [1, 2, 3, 4, 5, 6].map((i) => chatPlaceholder({ surface: 'global', collapsed: true, thinkingSince: since, now: since + i * THINKING_ROTATE_MS }))
    for (const w of words) expect(THINKING_WORDS.slice(1)).toContain(w)
    for (let i = 1; i < words.length; i++) expect(words[i]).not.toBe(words[i - 1])
  })
})

describe('menu triggers', () => {
  it('opens recipes only for "/" at the start of a line', () => {
    expect(detectTrigger('/')).toEqual({ kind: 'recipe', query: '' })
    expect(detectTrigger('/follow up')).toEqual({ kind: 'recipe', query: 'follow up' })
    expect(detectTrigger('first line\n/tl')).toEqual({ kind: 'recipe', query: 'tl' })
    expect(detectTrigger('a/b')).toBeNull()
    expect(detectTrigger('/ space first')).toBeNull()
    expect(detectTrigger('/two  spaces')).toBeNull()
  })

  it('opens notes for "@" after a space or at the start', () => {
    expect(detectTrigger('@')).toEqual({ kind: 'mention', query: '' })
    expect(detectTrigger('compare with @acme kick')).toEqual({ kind: 'mention', query: 'acme kick' })
    expect(detectTrigger('mail me@example')).toBeNull()
    expect(detectTrigger('@ acme')).toBeNull()
  })
})

describe('recipes', () => {
  const recipes = [
    recipe('follow-up-email', { description: 'A short email with next steps', usage_count: 3, last_used_at: '2026-10-19T10:00:00Z' }),
    recipe('tldr', { description: 'Three bullets' }),
    recipe('coach-me', { builtin: false, description: 'Feedback on how I spoke', usage_count: 9 }),
    recipe('action-items', { last_used_at: '2026-10-20T10:00:00Z' })
  ]

  it('shows recent recipes first before a query, then mine, then built-ins', () => {
    const s = rankRecipes(recipes, '')
    expect(s.recent.map((r) => r.slug)).toEqual(['action-items', 'follow-up-email'])
    expect(s.mine.map((r) => r.slug)).toEqual(['coach-me'])
    expect(s.all.map((r) => r.slug)).toEqual(['tldr'])
  })

  it('ranks matches by fit, including descriptions, and drops the recent section', () => {
    const s = rankRecipes(recipes, 'follow')
    expect(s.recent).toEqual([])
    expect(s.all[0].slug).toBe('follow-up-email')
    expect(rankRecipes(recipes, 'bullets').all.map((r) => r.slug)).toEqual(['tldr'])
    expect(fuzzyScore('fue', 'follow-up-email')).toBeGreaterThan(0)
    expect(fuzzyScore('xyz', 'tldr')).toBe(0)
  })

  it('finds a recipe typed out in full', () => {
    expect(exactRecipe('Follow up email', recipes)?.slug).toBe('follow-up-email')
    expect(exactRecipe('follow up', recipes)).toBeNull()
    expect(titleCaseSlug('follow-up-email')).toBe('Follow up email')
  })
})

describe('.env upgrade', () => {
  it('adds the sections for keys an existing file does not mention yet, and nothing else', () => {
    const old = '# Cereal API keys\n\nDEEPGRAM_API_KEY=abc\nANTHROPIC_API_KEY=\nOPENAI_API_KEY=sk\n# CEREAL_GOOGLE_CLIENT_SECRET=\n'
    expect(missingEnvSections(old)).toBe('\n# Google Gemini (aistudio.google.com)\nGEMINI_API_KEY=\n')
    expect(missingEnvSections(old + 'GEMINI_API_KEY=x\n')).toBe('')
  })
})

describe('model choices', () => {
  it('parses provider/model ids, keeping slashes in the model', () => {
    expect(parseModelChoice('auto')).toBeNull()
    expect(parseModelChoice('gemini/gemini-3.5-flash')).toEqual({ provider: 'gemini', model: 'gemini-3.5-flash' })
    expect(parseModelChoice('ollama/library/qwen3:8b')).toEqual({ provider: 'ollama', model: 'library/qwen3:8b' })
    expect(parseModelChoice('nope/x')).toBeNull()
    expect(choiceLabel('anthropic/claude-opus-5-5')).toBe('Claude Opus 5.5')
    expect(choiceLabel('auto')).toBe('Auto')
  })
})
