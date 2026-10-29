import { useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Info } from 'lucide-react'
import { AUTO_MODEL, PROVIDER_MARKS, choiceLabel, type ChatModels, type ModelChoice } from '@shared/models'
import type { LlmProviderId } from '@shared/types'
import { call, errorMessage } from '../../lib/api'
import { useApp } from '../../store'
import { Menu, MenuItem, MenuLabel, MenuSeparator, Tooltip, cn } from '../oats'

let cached: ChatModels | null = null
const listeners = new Set<(m: ChatModels) => void>()

/** The model list, shared by every chat bar; refreshed whenever a picker opens (keys can change in .env any time). */
export function useChatModels(): { models: ChatModels | null; refresh: () => void } {
  const [models, setModels] = useState<ChatModels | null>(cached)
  useEffect(() => {
    listeners.add(setModels)
    if (!cached) refreshModels()
    return () => void listeners.delete(setModels)
  }, [])
  return { models, refresh: refreshModels }
}

function refreshModels(): void {
  void call('chat:models')
    .then((m) => {
      cached = m
      for (const l of listeners) l(m)
    })
    .catch(() => undefined)
}

/** Single-meeting chats and chats across notes each keep their own choice, as in Granola. */
export function useModelChoice(scope: 'single' | 'multi'): [ModelChoice, (choice: ModelChoice) => void] {
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const showToast = useApp((s) => s.showToast)
  const choice = (scope === 'single' ? settings?.chat.modelSingle : settings?.chat.modelMulti) ?? AUTO_MODEL
  const set = (next: ModelChoice): void => {
    void call('settings:update', { chat: scope === 'single' ? { modelSingle: next } : { modelMulti: next } })
      .then(setSettings)
      .catch((e) => showToast('error', errorMessage(e)))
  }
  return [choice, set]
}

/** A provider's letter-mark (Cereal shows these instead of provider logos). */
export function ProviderMark({ provider, className }: { provider: LlmProviderId; className?: string }): ReactNode {
  return (
    <span
      aria-hidden
      className={cn('flex size-4 shrink-0 items-center justify-center rounded-[4px] bg-oats-off-black-a6 text-[9px] leading-none font-semibold text-ink-secondary dark:bg-oats-off-white-a6', className)}
    >
      {PROVIDER_MARKS[provider]}
    </span>
  )
}

/**
 * Granola's model select (docs/granola-chat-bar.md §6): a ghost trigger with the current model, a menu with Auto
 * first and the models grouped by provider. Models whose provider has no key are listed but can't be picked.
 */
export function ModelPicker({ value, onChange, side = 'top', className }: { value: ModelChoice; onChange: (choice: ModelChoice) => void; side?: 'top' | 'bottom'; className?: string }): ReactNode {
  const { models, refresh } = useChatModels()
  const label = choiceLabel(value, models)
  return (
    <Menu
      side={side}
      align="start"
      size="md"
      className="w-58 min-w-58"
      onOpenChange={(open) => open && refresh()}
      trigger={
        <button
          type="button"
          data-testid="model-picker"
          aria-label="Select AI model"
          className={cn(
            'flex h-8 min-w-0 cursor-default items-center gap-0.5 rounded-full px-2 py-2 text-sm text-ink-secondary outline-none hover:text-ink-primary data-popup-open:text-ink-primary',
            className
          )}
        >
          <span className="truncate">{label}</span>
          <ChevronDown size={14} className="shrink-0" />
        </button>
      }
    >
      <MenuItem onClick={() => onChange(AUTO_MODEL)}>
        <span className="flex size-4 shrink-0 items-center justify-center text-ink-tertiary">✦</span>
        <span className="min-w-0 flex-1">
          <span className="block">Auto</span>
          {models && <span className="block truncate text-xs text-ink-tertiary">Uses {models.autoLabel}, as set in Settings → AI</span>}
        </span>
        {value === AUTO_MODEL && <Check size={16} />}
      </MenuItem>
      {models?.groups.map((g) => {
        const rows = models.models.filter((m) => m.provider === g.id)
        return (
          <div key={g.id}>
            <MenuSeparator />
            <MenuLabel>{g.label}</MenuLabel>
            {rows.map((m) => (
              <Tooltip key={m.id} content={m.available ? m.info : m.unavailableReason} side="right" delay={300}>
                <div>
                  <MenuItem disabled={!m.available} onClick={() => onChange(m.id)}>
                    <ProviderMark provider={m.provider} />
                    <span className="min-w-0 flex-1 truncate">{m.label}</span>
                    {m.isNew && <span className="rounded-full bg-surface-tint-accent px-1.5 py-px text-[10px] font-semibold tracking-wide text-ink-accent">NEW</span>}
                    {!m.available && <Info size={14} />}
                    {value === m.id && <Check size={16} />}
                  </MenuItem>
                </div>
              </Tooltip>
            ))}
          </div>
        )
      })}
      {models && !models.groups.some((g) => g.id === 'ollama') && <div className="px-2 pt-1 pb-1.5 text-xs text-ink-tertiary">Local Ollama models appear here while Ollama is running.</div>}
    </Menu>
  )
}
