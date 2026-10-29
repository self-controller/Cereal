import type { LlmProviderId, Settings } from '@shared/types'
import { AUTO_MODEL, CURATED_MODELS, PROVIDER_LABELS, PROVIDER_ORDER, modelChoiceId, parseModelChoice, prettyModelName, type ChatModelOption, type ChatModels, type ModelChoice } from '@shared/models'
import type { SettingsService } from '../settings'
import { AnthropicProvider, describeAnthropicError } from './anthropic'
import { GeminiProvider, describeGeminiError } from './gemini'
import { OpenAIProvider, describeOpenAIError } from './openai'
import { OllamaProvider } from './ollama'
import { LlmConfigError, type LlmProvider, type ProviderConfig } from './provider'

/** Resolve the configured provider, its models and key. Throws a friendly error when the key is missing. */
export function providerConfig(settings: SettingsService, id: LlmProviderId = settings.get().llm.provider): ProviderConfig {
  const llm: Settings['llm'] = settings.get().llm
  switch (id) {
    case 'anthropic': {
      const key = settings.getSecret('anthropicApiKey')
      if (!key) throw new LlmConfigError(`Set ANTHROPIC_API_KEY in ${settings.envFile} to use Claude.`)
      return { provider: id, apiKey: key, model: llm.anthropicModel, fastModel: llm.anthropicFastModel, ollamaUrl: llm.ollamaUrl, baseURL: process.env['CEREAL_ANTHROPIC_URL'] || undefined }
    }
    case 'openai': {
      const key = settings.getSecret('openaiApiKey')
      if (!key) throw new LlmConfigError(`Set OPENAI_API_KEY in ${settings.envFile} to use OpenAI.`)
      return { provider: id, apiKey: key, model: llm.openaiModel, fastModel: llm.openaiFastModel, ollamaUrl: llm.ollamaUrl, baseURL: process.env['CEREAL_OPENAI_URL'] || undefined }
    }
    case 'gemini': {
      const key = settings.getSecret('geminiApiKey')
      if (!key) throw new LlmConfigError(`Set GEMINI_API_KEY in ${settings.envFile} to use Gemini.`)
      return { provider: id, apiKey: key, model: llm.geminiModel, fastModel: llm.geminiFastModel, ollamaUrl: llm.ollamaUrl, baseURL: process.env['CEREAL_GEMINI_URL'] || undefined }
    }
    case 'ollama':
      return { provider: id, apiKey: null, model: llm.ollamaModel, fastModel: llm.ollamaModel, ollamaUrl: llm.ollamaUrl }
  }
}

/**
 * The provider config for a chat's model choice: 'auto' is the provider and model from Settings; a specific
 * `provider/model` keeps that provider's fast model for compaction.
 */
export function chatProviderConfig(settings: SettingsService, choice: ModelChoice | null | undefined): ProviderConfig {
  const parsed = parseModelChoice(choice)
  if (!parsed) return providerConfig(settings)
  const config = providerConfig(settings, parsed.provider)
  return { ...config, model: parsed.model, fastModel: parsed.provider === 'ollama' ? parsed.model : config.fastModel }
}

export function createProviderFromConfig(c: ProviderConfig): LlmProvider {
  switch (c.provider) {
    case 'anthropic':
      return new AnthropicProvider(c.apiKey ?? '', c.model, c.fastModel, c.baseURL)
    case 'openai':
      return new OpenAIProvider(c.apiKey ?? '', c.model, c.fastModel, c.baseURL)
    case 'gemini':
      return new GeminiProvider(c.apiKey ?? '', c.model, c.fastModel, c.baseURL)
    case 'ollama':
      return new OllamaProvider(c.ollamaUrl, c.model)
  }
}

export function createProvider(settings: SettingsService, id: LlmProviderId = settings.get().llm.provider): LlmProvider {
  return createProviderFromConfig(providerConfig(settings, id))
}

/** Delete a provider's copy of an uploaded attachment (no-op for providers without a Files API, or no key). */
export async function deleteRemoteFile(settings: SettingsService, provider: LlmProviderId, remoteId: string): Promise<void> {
  let llm: LlmProvider
  try {
    llm = createProvider(settings, provider)
  } catch {
    return
  }
  await llm.deleteFile?.(remoteId)
}

export function describeLlmError(e: unknown): string {
  return describeAnthropicError(e) ?? describeOpenAIError(e) ?? describeGeminiError(e) ?? (e instanceof Error ? e.message : String(e))
}

const KEY_NAMES: Record<Exclude<LlmProviderId, 'ollama'>, { secret: 'anthropicApiKey' | 'openaiApiKey' | 'geminiApiKey'; variable: string }> = {
  anthropic: { secret: 'anthropicApiKey', variable: 'ANTHROPIC_API_KEY' },
  openai: { secret: 'openaiApiKey', variable: 'OPENAI_API_KEY' },
  gemini: { secret: 'geminiApiKey', variable: 'GEMINI_API_KEY' }
}

/** The configured quality model of a provider. */
function settingsModel(llm: Settings['llm'], provider: LlmProviderId): string {
  return provider === 'anthropic' ? llm.anthropicModel : provider === 'openai' ? llm.openaiModel : provider === 'gemini' ? llm.geminiModel : llm.ollamaModel
}

/**
 * The model picker's list: the curated models plus whatever is configured in Settings, each marked unavailable when
 * its provider has no key; for Ollama, the models it has installed (none when it isn't running).
 */
export async function chatModels(settings: SettingsService, ollamaModels: () => Promise<string[]>): Promise<ChatModels> {
  const llm = settings.get().llm
  const models: ChatModelOption[] = []
  for (const provider of PROVIDER_ORDER) {
    if (provider === 'ollama') {
      const installed = await ollamaModels().catch(() => [] as string[])
      for (const model of installed) models.push({ id: modelChoiceId('ollama', model), provider, model, label: model, info: 'Runs locally with Ollama.', available: true })
      continue
    }
    const key = KEY_NAMES[provider]
    const available = !!settings.getSecret(key.secret)
    const reason = available ? undefined : `Add ${key.variable} to Cereal’s .env file to use ${PROVIDER_LABELS[provider]} models.`
    const ids = new Set<string>()
    for (const m of CURATED_MODELS.filter((c) => c.provider === provider)) {
      ids.add(m.model)
      models.push({ id: modelChoiceId(provider, m.model), provider, model: m.model, label: m.label, isNew: m.isNew, info: m.info, available, unavailableReason: reason })
    }
    const configured = settingsModel(llm, provider)
    if (configured && !ids.has(configured)) {
      models.push({ id: modelChoiceId(provider, configured), provider, model: configured, label: prettyModelName(configured), info: 'The model set in Settings → AI.', available, unavailableReason: reason })
    }
  }
  const groups = PROVIDER_ORDER.filter((p) => models.some((m) => m.provider === p)).map((p) => ({ id: p, label: PROVIDER_LABELS[p] }))
  return { groups, models, autoLabel: prettyModelName(settingsModel(llm, llm.provider)) }
}

export { AUTO_MODEL }
export type { LlmProvider }
