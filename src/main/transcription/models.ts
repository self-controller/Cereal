import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { WhisperModelInfo } from '@shared/types'

/** ggml models published with whisper.cpp. Downloaded on demand, like Granola's local ASR models. */
export const WHISPER_MODELS: { id: string; label: string; sizeMb: number }[] = [
  { id: 'tiny.en', label: 'Tiny (English, fastest)', sizeMb: 75 },
  { id: 'base.en', label: 'Base (English, recommended)', sizeMb: 142 },
  { id: 'small.en', label: 'Small (English, more accurate)', sizeMb: 466 },
  { id: 'base', label: 'Base (multilingual)', sizeMb: 142 },
  { id: 'small', label: 'Small (multilingual)', sizeMb: 466 },
  { id: 'large-v3-turbo-q5_0', label: 'Large v3 Turbo, quantized (best, needs a fast CPU)', sizeMb: 547 }
]

const modelUrl = (id: string): string => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${id}.bin`

export class WhisperModels {
  private progress = new Map<string, number>()

  constructor(
    private readonly dir: string,
    private readonly onChange: (models: WhisperModelInfo[]) => void
  ) {
    mkdirSync(dir, { recursive: true })
  }

  path(id: string): string {
    return join(this.dir, `ggml-${id}.bin`)
  }

  list(): WhisperModelInfo[] {
    return WHISPER_MODELS.map((m) => ({
      ...m,
      downloaded: existsSync(this.path(m.id)) && statSync(this.path(m.id)).size > 1_000_000,
      downloading: this.progress.has(m.id),
      progress: this.progress.get(m.id) ?? 0
    }))
  }

  async download(id: string): Promise<void> {
    if (!WHISPER_MODELS.some((m) => m.id === id)) throw new Error(`Unknown model ${id}`)
    if (this.progress.has(id)) return
    this.progress.set(id, 0)
    this.onChange(this.list())
    const tmp = this.path(id) + '.part'
    try {
      const res = await fetch(modelUrl(id))
      if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0)
      let received = 0
      let lastEmit = 0
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream)
      body.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total && Date.now() - lastEmit > 250) {
          lastEmit = Date.now()
          this.progress.set(id, received / total)
          this.onChange(this.list())
        }
      })
      await pipeline(body, createWriteStream(tmp))
      renameSync(tmp, this.path(id))
    } catch (e) {
      rmSync(tmp, { force: true })
      throw e
    } finally {
      this.progress.delete(id)
      this.onChange(this.list())
    }
  }

  delete(id: string): void {
    rmSync(this.path(id), { force: true })
    this.onChange(this.list())
  }
}
