import { closeSync, constants, fchmodSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Recursively merge `patch` into `base`; arrays and primitives replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v
  }
  return out as T
}

/**
 * Read the .env file's text (null if it doesn't exist). It must be a regular file: a FIFO would block the main
 * process. A file others can read is made private again, since an editor's save can widen its mode.
 */
export function readEnvText(path: string): string | null {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error(`${path} is not a regular file.`)
    if (stat.mode & 0o077) {
      try {
        fchmodSync(fd, 0o600)
      } catch {
        // Not ours to change (another owner); read it anyway.
      }
    }
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

/** Parse a .env file; a missing file reads as empty. */
export function readEnvFile(path: string): Record<string, string> {
  return parseEnv(readEnvText(path) ?? '') as Record<string, string>
}

/** Encrypts the tokens Cereal obtains itself: Electron's async safeStorage in the app, a fake in tests. */
export interface TokenCipher {
  available(): Promise<boolean>
  encrypt(plain: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
  /** Values written by the synchronous safeStorage API, which Cereal used before. */
  decryptLegacy(data: Buffer): string
}

/** A token as stored: `enc2:` when the keyring can protect it, otherwise `plain:`. */
export async function sealToken(cipher: TokenCipher, value: string): Promise<string> {
  if (await cipher.available()) return `enc2:${(await cipher.encrypt(value)).toString('base64')}`
  return `plain:${Buffer.from(value, 'utf8').toString('base64')}`
}

/**
 * A stored token's value (null if it can't be read, e.g. it was sealed by another keyring), and whether to store it
 * again: it's in an older format, its key was rotated, or a keyring has appeared since it was stored in plain.
 */
export async function openToken(cipher: TokenCipher, stored: string): Promise<{ value: string | null; reseal: boolean }> {
  try {
    if (stored.startsWith('enc2:')) {
      const { result, shouldReEncrypt } = await cipher.decrypt(Buffer.from(stored.slice(5), 'base64'))
      return { value: result, reseal: shouldReEncrypt }
    }
    if (stored.startsWith('enc:')) return { value: cipher.decryptLegacy(Buffer.from(stored.slice(4), 'base64')), reseal: true }
    if (stored.startsWith('plain:')) return { value: Buffer.from(stored.slice(6), 'base64').toString('utf8'), reseal: await cipher.available() }
  } catch {
    // Unreadable: the user signs in again.
  }
  return { value: null, reseal: false }
}

export const ENV_TEMPLATE = `# Cereal API keys. Changes apply right away; there's no need to restart Cereal.

# Deepgram live transcription (console.deepgram.com)
DEEPGRAM_API_KEY=

# Claude (console.anthropic.com)
ANTHROPIC_API_KEY=

# OpenAI (platform.openai.com)
OPENAI_API_KEY=

# Google Gemini (aistudio.google.com)
GEMINI_API_KEY=

# Google Calendar: the client secret of your own Desktop-app OAuth client (the client ID goes in Settings)
CEREAL_GOOGLE_CLIENT_SECRET=
`

/** Sections of the template whose variable an existing .env doesn't mention yet, ready to append. */
export function missingEnvSections(existing: string): string {
  const sections = ENV_TEMPLATE.split(/\n\n+/).slice(1)
  const missing = sections.filter((section) => {
    const variable = section.match(/^([A-Z0-9_]+)=/m)?.[1]
    return variable && !new RegExp(`^\\s*#?\\s*${variable}\\s*=`, 'm').test(existing)
  })
  if (!missing.length) return ''
  return `${existing.endsWith('\n') ? '' : '\n'}\n${missing.map((m) => m.trimEnd()).join('\n\n')}\n`
}
