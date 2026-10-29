import { safeStorage } from 'electron'
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import type { Store } from './db/store'
import type { DeepPartial } from '@shared/ipc'
import type { EnvSecretName, SecretName, SecretStatus, Settings } from '@shared/types'
import { DEFAULT_SETTINGS, SECRET_ENV_VARS } from '@shared/defaults'
import { ENV_TEMPLATE, deepMerge, missingEnvSections, openToken, readEnvFile, readEnvText, sealToken, type TokenCipher } from './settings.pure'

type TokenName = Exclude<SecretName, EnvSecretName>

const SECRET_NAMES: SecretName[] = ['anthropicApiKey', 'openaiApiKey', 'geminiApiKey', 'deepgramApiKey', 'googleClientSecret', 'googleRefreshToken']
const ENV_SECRET_NAMES = Object.keys(SECRET_ENV_VARS) as EnvSecretName[]
const TOKEN_NAMES: TokenName[] = ['googleRefreshToken']

const isEnvSecret = (name: SecretName): name is EnvSecretName => name in SECRET_ENV_VARS

// The async API reaches the keyring through the Secret portal inside Flatpak, where the sync API loses its key on
// every start; app.ts turns on encrypting with the portal's key there.
let protecting: Promise<boolean> | null = null
const cipher: TokenCipher = {
  // With no keyring or portal, Chromium still "encrypts", with a fixed key it tags v10. That protects nothing, so it
  // counts as unavailable: tokens are stored plain and Settings says so.
  available: () =>
    (protecting ??= (async () => {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false
      const probe = await safeStorage.encryptStringAsync('probe')
      return probe.subarray(0, 3).toString('latin1') !== 'v10'
    })().catch(() => false)),
  encrypt: (plain) => safeStorage.encryptStringAsync(plain),
  decrypt: (data) => safeStorage.decryptStringAsync(data),
  decryptLegacy: (data) => safeStorage.decryptString(data)
}

export class SettingsService {
  private cache: Settings
  private tokens = new Map<TokenName, string>()
  private tokensLoading: Promise<void> | null = null
  /** Tokens saved or removed since start; loading never overwrites them. */
  private tokensChanged = new Set<TokenName>()

  constructor(
    private store: Store,
    readonly envFile: string
  ) {
    // Merge stored values over defaults so new settings keys get defaults after upgrades.
    this.cache = deepMerge(DEFAULT_SETTINGS, store.getSetting<Partial<Settings>>('settings', {}))
    // API keys used to be saved through Settings; they now live only in the .env file.
    for (const name of ENV_SECRET_NAMES) store.deleteSetting(`secret:${name}`)
    this.ensureEnvFile()
  }

  get(): Settings {
    return this.cache
  }

  update(patch: DeepPartial<Settings>): Settings {
    this.cache = deepMerge(this.cache, patch)
    this.store.setSetting('settings', this.cache)
    return this.cache
  }

  /** Create the .env file from a commented template, readable only by the user; add keys newer versions read. */
  ensureEnvFile(): void {
    if (!existsSync(this.envFile)) {
      writeFileSync(this.envFile, ENV_TEMPLATE, { mode: 0o600 })
      return
    }
    try {
      const missing = missingEnvSections(readEnvText(this.envFile) ?? '')
      if (missing) appendFileSync(this.envFile, missing)
    } catch {
      // An unreadable .env is reported where a key is needed.
    }
  }

  // API keys come from the .env file (re-read on every lookup, so edits apply without a restart), falling back to
  // the process environment. Tokens Cereal obtains itself are encrypted with the OS keyring via Electron safeStorage,
  // and kept decrypted in memory once loadTokens() has run.

  getSecret(name: SecretName): string | null {
    if (isEnvSecret(name)) {
      const variable = SECRET_ENV_VARS[name]
      const env = readEnvFile(this.envFile)
      // Google's SDKs also read GOOGLE_API_KEY, so accept it for Gemini.
      const alias = name === 'geminiApiKey' ? 'GOOGLE_API_KEY' : null
      return (
        env[variable]?.trim() || (alias && env[alias]?.trim()) || process.env[variable]?.trim() || (alias && process.env[alias]?.trim()) || null
      )
    }
    return this.tokens.get(name) ?? process.env['CEREAL_GOOGLE_REFRESH_TOKEN'] ?? null
  }

  /** Decrypt the stored tokens into memory, once the app is ready. Later calls return the same promise. */
  loadTokens(): Promise<void> {
    this.tokensLoading ??= (async () => {
      for (const name of TOKEN_NAMES) {
        const stored = this.store.getSetting<string | null>(`secret:${name}`, null)
        if (!stored) continue
        const { value, reseal } = await openToken(cipher, stored)
        if (!value || this.tokensChanged.has(name)) continue
        this.tokens.set(name, value)
        if (!reseal) continue
        const sealed = await sealToken(cipher, value).catch(() => null)
        if (sealed && !this.tokensChanged.has(name)) this.store.setSetting(`secret:${name}`, sealed)
      }
    })()
    return this.tokensLoading
  }

  async setSecret(name: TokenName, value: string | null): Promise<SecretStatus> {
    this.tokensChanged.add(name)
    if (!value) {
      this.tokens.delete(name)
      this.store.deleteSetting(`secret:${name}`)
    } else {
      this.tokens.set(name, value)
      this.store.setSetting(`secret:${name}`, await sealToken(cipher, value))
    }
    return this.secretStatus()
  }

  /** Whether tokens are encrypted with a key the OS keeps (keyring or Secret portal), not stored plain. */
  tokensProtected(): Promise<boolean> {
    return cipher.available()
  }

  secretStatus(): SecretStatus {
    return Object.fromEntries(SECRET_NAMES.map((n) => [n, !!this.getSecret(n)])) as SecretStatus
  }
}
