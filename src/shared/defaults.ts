import type { EnvSecretName, NoteMode, Recipe, Settings, Template } from './types'

/** Slug for auto-structured notes (no fixed sections). */
export const AUTO_TEMPLATE_SLUG = 'auto'

/** Built-in template that lecture-mode notes use unless the note picked another. */
export const LECTURE_TEMPLATE_SLUG = 'lecture'

/** Template to enhance with when the note hasn't chosen one. */
export function defaultTemplateFor(mode: NoteMode, settings: Settings | null | undefined): string {
  if (mode === 'lecture') return LECTURE_TEMPLATE_SLUG
  return settings?.enhance.defaultTemplate || AUTO_TEMPLATE_SLUG
}

/** The .env variable each user-supplied key is read from. */
export const SECRET_ENV_VARS: Record<EnvSecretName, string> = {
  deepgramApiKey: 'DEEPGRAM_API_KEY',
  anthropicApiKey: 'ANTHROPIC_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
  geminiApiKey: 'GEMINI_API_KEY',
  googleClientSecret: 'CEREAL_GOOGLE_CLIENT_SECRET'
}

export const DEFAULT_SETTINGS: Settings = {
  transcription: {
    engine: 'deepgram',
    language: 'en',
    deepgramModel: 'nova-3',
    whisperModel: 'base.en',
    whisperServerPath: '',
    whisperThreads: 4,
    diarize: true
  },
  llm: {
    provider: 'anthropic',
    anthropicModel: 'claude-opus-5-5',
    anthropicFastModel: 'claude-haiku-5-5',
    openaiModel: 'gpt-5.6',
    openaiFastModel: 'gpt-5.4-mini',
    geminiModel: 'gemini-3.1-pro-preview',
    geminiFastModel: 'gemini-3.5-flash',
    ollamaModel: 'llama3.1',
    ollamaUrl: 'http://127.0.0.1:11434'
  },
  chat: { enterKey: 'send', modelSingle: 'auto', modelMulti: 'auto' },
  audio: {
    captureSystem: true,
    micTarget: null,
    systemTarget: null,
    playSounds: true
  },
  profile: { name: '', email: '', company: '', jobTitle: '' },
  dictionary: [],
  calendar: { googleClientId: '', connected: false, notifyMinutesBefore: 1 },
  detection: { enabled: true },
  enhance: { autoEnhanceOnStop: false, defaultTemplate: AUTO_TEMPLATE_SLUG },
  assistant: { enabled: true, instructions: '', alwaysAllow: [] },
  theme: 'system'
}

type BuiltinTemplate = Omit<Template, 'builtin' | 'updated_at'>

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    slug: AUTO_TEMPLATE_SLUG,
    title: 'Auto',
    description: 'Cereal picks the headings that best fit what was discussed.',
    sections: []
  },
  {
    slug: 'one-on-one',
    title: '1:1',
    description: 'A recurring conversation between a manager and a report, or two peers.',
    sections: [
      { heading: 'Check-in', section_description: 'How each person is doing, wins and anything weighing on them.' },
      { heading: 'Topics', section_description: 'Each topic raised, with the key points and any conclusions.' },
      { heading: 'Feedback', section_description: 'Feedback given in either direction, quoted closely where it matters.' },
      { heading: 'Growth', section_description: 'Career goals, skills and development opportunities mentioned.' },
      { heading: 'Action items', section_description: 'Concrete follow-ups with an owner for each.' }
    ]
  },
  {
    slug: 'stand-up',
    title: 'Stand-up',
    description: 'A short team sync on progress and blockers.',
    sections: [
      { heading: 'Updates', section_description: 'Per person: what they finished and what they are working on next.' },
      { heading: 'Blockers', section_description: 'Anything stopping progress and who can unblock it.' },
      { heading: 'Decisions', section_description: 'Decisions made during the sync.' },
      { heading: 'Follow-ups', section_description: 'Items to pick up after the meeting, with owners.' }
    ]
  },
  {
    slug: 'customer-call',
    title: 'Customer call',
    description: 'A sales, discovery or account call with an external customer.',
    sections: [
      { heading: 'About them', section_description: 'Who they are, their role, team and context.' },
      { heading: 'Problems and needs', section_description: 'Pain points, goals and what they are trying to achieve, in their words.' },
      { heading: 'Current solution', section_description: 'What they use today and what they think of it.' },
      { heading: 'Objections and concerns', section_description: 'Hesitations, risks or blockers they raised.' },
      { heading: 'Budget and timeline', section_description: 'Budget, decision process, stakeholders and timing.' },
      { heading: 'Next steps', section_description: 'Agreed next steps, owners and dates.' }
    ]
  },
  {
    slug: 'interview',
    title: 'Interview',
    description: 'A hiring interview with a candidate.',
    sections: [
      { heading: 'Background', section_description: 'The candidate’s experience and relevant history.' },
      { heading: 'Strengths', section_description: 'Evidence of strengths, with specific examples they gave.' },
      { heading: 'Concerns', section_description: 'Gaps, risks or weak answers, with specifics.' },
      { heading: 'Questions they asked', section_description: 'What the candidate wanted to know.' },
      { heading: 'Assessment', section_description: 'An overall read on fit, grounded in what was said.' }
    ]
  },
  {
    slug: LECTURE_TEMPLATE_SLUG,
    title: 'Lecture',
    description: 'A class, talk or training session.',
    sections: [
      { heading: 'Key concepts', section_description: 'The main ideas, defined clearly.' },
      { heading: 'Details and examples', section_description: 'Supporting explanations, formulas and worked examples.' },
      { heading: 'Questions raised', section_description: 'Questions from the audience and the answers given.' },
      { heading: 'To review', section_description: 'Assignments, readings, deadlines and topics to study further.' }
    ]
  }
]

type BuiltinRecipe = Omit<Recipe, 'id' | 'builtin' | 'updated_at' | 'usage_count' | 'last_used_at'>

export const BUILTIN_RECIPES: BuiltinRecipe[] = [
  {
    slug: 'follow-up-email',
    name: 'Write follow-up email',
    description: 'A short email to the other participants with what was agreed and the next steps.',
    prompt: 'Draft a concise follow-up email to the other participants summarising what we agreed and the next steps. Keep it friendly and skimmable.'
  },
  {
    slug: 'action-items',
    name: 'List action items',
    description: 'Every action item as a checklist, with owners and due dates.',
    prompt: 'List every action item from this meeting as a checklist, with the owner and any due date mentioned.'
  },
  {
    slug: 'tldr',
    name: 'TL;DR',
    description: 'The meeting in three bullets.',
    prompt: 'Give me a three-bullet TL;DR of this meeting.'
  },
  {
    slug: 'coach-me',
    name: 'Coach me',
    description: 'Specific feedback on how you came across.',
    prompt: 'Based on how I spoke in this meeting, give me two or three specific, constructive pieces of feedback on how I could communicate more effectively next time.'
  }
]
