// The chat bar's model picker (docs/granola-chat-bar.md §6). Granola's list comes from its server; Cereal's is
// curated here and merged at runtime with the user's keys, Ollama's installed models and the models in Settings.
import type { LlmProviderId } from './types'

/** 'auto' (the provider and model from Settings) or `provider/model`. */
export type ModelChoice = string

export const AUTO_MODEL: ModelChoice = 'auto'

export interface ChatModelOption {
  id: ModelChoice
  provider: LlmProviderId
  model: string
  label: string
  isNew?: boolean
  info?: string
  /** False when the provider has no key (or Ollama isn't running). */
  available: boolean
  unavailableReason?: string
}

export interface ChatModelGroup {
  id: LlmProviderId
  label: string
}

export interface ChatModels {
  groups: ChatModelGroup[]
  models: ChatModelOption[]
  /** What Auto resolves to right now, e.g. "Claude Opus 5.5". */
  autoLabel: string
}

export const PROVIDER_ORDER: LlmProviderId[] = ['anthropic', 'openai', 'gemini', 'ollama']

export const PROVIDER_LABELS: Record<LlmProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google',
  ollama: 'Ollama'
}

/** Monochrome letter-marks the picker shows instead of provider logos. */
export const PROVIDER_MARKS: Record<LlmProviderId, string> = { anthropic: 'A', openai: 'O', gemini: 'G', ollama: 'L' }

export interface CuratedModel {
  provider: LlmProviderId
  model: string
  label: string
  isNew?: boolean
  info?: string
}

export const CURATED_MODELS: CuratedModel[] = [
  { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', info: 'Strong reasoning for most questions.' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', info: 'Fast and capable for everyday questions.' },
  { provider: 'anthropic', model: 'claude-fable-5-1', label: 'Claude Fable 5.1', isNew: true, info: 'The most capable Claude, for the hardest questions. Slower and more expensive.' },
  { provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', info: 'The quickest Claude.' },
  { provider: 'openai', model: 'gpt-5.6', label: 'GPT-5.6', isNew: true },
  { provider: 'openai', model: 'gpt-5.5', label: 'GPT-5.5' },
  { provider: 'openai', model: 'gpt-5.4-mini', label: 'GPT-5.4 mini', info: 'Fast and inexpensive.' },
  { provider: 'gemini', model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', info: 'Google’s most capable model.' },
  { provider: 'gemini', model: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', isNew: true, info: 'Fast, and thinks before answering.' }
]

export function modelChoiceId(provider: LlmProviderId, model: string): ModelChoice {
  return `${provider}/${model}`
}

/** `provider/model` → its parts; 'auto' and anything malformed → null. Model ids may contain slashes (Ollama tags). */
export function parseModelChoice(choice: ModelChoice | null | undefined): { provider: LlmProviderId; model: string } | null {
  if (!choice || choice === AUTO_MODEL) return null
  const slash = choice.indexOf('/')
  if (slash <= 0) return null
  const provider = choice.slice(0, slash) as LlmProviderId
  const model = choice.slice(slash + 1)
  return PROVIDER_ORDER.includes(provider) && model ? { provider, model } : null
}

/** A readable name for a model id that isn't in the curated list. */
export function prettyModelName(model: string): string {
  const curated = CURATED_MODELS.find((m) => m.model === model)
  if (curated) return curated.label
  return model
}

export function choiceLabel(choice: ModelChoice | null | undefined, models?: ChatModels | null): string {
  if (!choice || choice === AUTO_MODEL) return 'Auto'
  const found = models?.models.find((m) => m.id === choice)
  if (found) return found.label
  const parsed = parseModelChoice(choice)
  return parsed ? prettyModelName(parsed.model) : 'Auto'
}
