import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, X } from 'lucide-react'
import { call, errorMessage } from '../../lib/api'
import { useApp } from '../../store'
import { IconButton, MOD, Tooltip } from '../oats'

const SAMPLE_RATE = 16_000
/** Granola auto-sends a dictation at 10 minutes and warns a minute before. */
export const DICTATION_LIMIT_S = 600
const DICTATION_WARN_S = 540
const BARS = 48

export type DictationState = 'idle' | 'recording' | 'transcribing'

/**
 * Voice questions (docs/granola-chat-bar.md §2): record from the microphone, then transcribe with the engine set in
 * Settings → Transcription. Audio is captured at 16 kHz mono; the waveform shows the recent level history.
 */
export function useDictation(onText: (text: string) => void) {
  const [state, setState] = useState<DictationState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState<number[]>(() => Array(BARS).fill(0))
  const showToast = useApp((s) => s.showToast)
  const rec = useRef<{ ctx: AudioContext; stream: MediaStream; node: ScriptProcessorNode; chunks: Float32Array[]; started: number; timer: ReturnType<typeof setInterval> } | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const teardown = useCallback(() => {
    const r = rec.current
    rec.current = null
    if (!r) return null
    clearInterval(r.timer)
    r.node.disconnect()
    for (const t of r.stream.getTracks()) t.stop()
    void r.ctx.close()
    return r
  }, [])

  const finish = useCallback(
    async (send: boolean) => {
      const r = teardown()
      setLevels(Array(BARS).fill(0))
      setElapsed(0)
      if (!r || !send) return setState('idle')
      const total = r.chunks.reduce((n, c) => n + c.length, 0)
      const samples = new Float32Array(total)
      let at = 0
      for (const c of r.chunks) {
        samples.set(c, at)
        at += c.length
      }
      if (total < r.ctx.sampleRate * 0.3) return setState('idle')
      setState('transcribing')
      try {
        const { text } = await call('dictation:transcribe', { samples, sampleRate: r.ctx.sampleRate })
        if (text.trim()) onTextRef.current(text.trim())
        else showToast('info', 'Cereal didn’t hear anything. Try again a little closer to the microphone.')
      } catch (e) {
        showToast('error', errorMessage(e))
      } finally {
        setState('idle')
      }
    },
    [teardown, showToast]
  )

  const start = useCallback(async () => {
    if (rec.current || state !== 'idle') return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch {
      showToast('error', 'Cereal couldn’t use the microphone. Check that one is connected and not blocked.')
      return
    }
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
    const source = ctx.createMediaStreamSource(stream)
    // ScriptProcessor keeps capture inside this page (an AudioWorklet would need a separate script file).
    const node = ctx.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []
    node.onaudioprocess = (e) => {
      const data = new Float32Array(e.inputBuffer.getChannelData(0))
      chunks.push(data)
      let sum = 0
      for (const v of data) sum += v * v
      const rms = Math.sqrt(sum / data.length)
      setLevels((l) => [...l.slice(1), Math.min(1, rms * 8)])
    }
    source.connect(node)
    node.connect(ctx.destination)
    const started = Date.now()
    const timer = setInterval(() => {
      const s = Math.floor((Date.now() - started) / 1000)
      setElapsed(s)
      if (s >= DICTATION_LIMIT_S) void finish(true)
    }, 250)
    rec.current = { ctx, stream, node, chunks, started, timer }
    setElapsed(0)
    setState('recording')
  }, [state, showToast, finish])

  useEffect(() => () => void teardown(), [teardown])

  return { state, elapsed, levels, start, send: () => void finish(true), cancel: () => void finish(false) }
}

export type Dictation = ReturnType<typeof useDictation>

const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/** What replaces the editor while recording: a scrolling waveform, the timer, cancel and send. */
export function DictationBar({ dictation }: { dictation: Dictation }): ReactNode {
  const warn = dictation.elapsed >= DICTATION_WARN_S
  return (
    <div className="flex min-h-[47px] w-full items-center gap-2 py-1 pr-2 pl-3" data-testid="dictation-bar">
      <Tooltip content="Cancel dictation" kbd="Esc" side="top">
        <IconButton variant="soft" label="Cancel dictation" onClick={dictation.cancel} className="size-8">
          <X size={14} />
        </IconButton>
      </Tooltip>
      <div className="flex h-6 min-w-0 flex-1 items-center gap-[2px] overflow-hidden" aria-label="Recording">
        {dictation.levels.map((l, i) => (
          <span key={i} className="w-[3px] shrink-0 rounded-full bg-ink-accent transition-[height] duration-75" style={{ height: `${Math.max(3, l * 24)}px`, opacity: 0.35 + l * 0.65 }} />
        ))}
      </div>
      <Tooltip content={warn ? '1 min left, will send automatically' : undefined} side="top" disabled={!warn}>
        <span className="w-10 shrink-0 text-right text-sm text-ink-accent tabular-nums">{mmss(dictation.elapsed)}</span>
      </Tooltip>
      <Tooltip content="Send dictation" kbd={`↵ or ${MOD} T`} side="top">
        <IconButton variant="accent" label="Send dictation" onClick={dictation.send} className="size-8">
          <ArrowUp size={16} />
        </IconButton>
      </Tooltip>
    </div>
  )
}
