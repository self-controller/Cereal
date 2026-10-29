import { forwardRef, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { Switch as BaseSwitch } from '@base-ui/react/switch'
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from './cn'

/** Granola's switch: neutral track that turns accent, thumb sliding 14px over 100ms. */
export function Switch({ checked, onChange, size = 'md', disabled, 'aria-label': ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; size?: 'sm' | 'md'; disabled?: boolean; 'aria-label'?: string }): ReactNode {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={(v) => onChange(v)}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn(
        'group/switch relative inline-flex shrink-0 items-center rounded-full cursor-default ring-focus-ring outline-none transition-colors bg-fill-neutral data-[checked]:bg-fill-accent data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40',
        size === 'sm' ? 'h-4 w-[26px]' : 'h-5 w-8'
      )}
    >
      <BaseSwitch.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-ink-primary-inverse shadow-sm dark:bg-ink-primary-inverse-static translate-x-0.5 transition-transform duration-100 will-change-transform',
          size === 'sm' ? 'size-3 data-[checked]:translate-x-[12px]' : 'size-4 data-[checked]:translate-x-[14px]'
        )}
      />
    </BaseSwitch.Root>
  )
}

/** A settings row: label (and hint) on the left, switch on the right. */
export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <label className="flex cursor-default items-center justify-between gap-4 py-1">
      <span className="min-w-0">
        <span className="block text-sm text-ink-primary">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-ink-secondary">{hint}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  )
}

export function Checkbox({
  checked,
  onChange,
  size = 'md',
  accent,
  indeterminate,
  'aria-label': ariaLabel,
  className
}: {
  checked: boolean
  onChange: (v: boolean) => void
  size?: 'sm' | 'md' | 'lg'
  accent?: boolean
  indeterminate?: boolean
  'aria-label'?: string
  className?: string
}): ReactNode {
  const fill = accent ? 'data-[checked]:bg-fill-accent data-[indeterminate]:bg-fill-accent' : 'data-[checked]:bg-fill-primary data-[indeterminate]:bg-fill-primary'
  const dims = { sm: 'size-[14px] rounded-[4px]', md: 'size-4 rounded-[5px]', lg: 'size-5 rounded-md' }[size]
  return (
    <BaseCheckbox.Root
      checked={checked}
      indeterminate={indeterminate}
      onCheckedChange={(v) => onChange(v)}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex shrink-0 items-center justify-center border border-hairline cursor-default ring-focus-ring outline-none hover:not-data-disabled:not-data-checked:bg-fill-highlight data-[checked]:border-transparent data-[indeterminate]:border-transparent data-[disabled]:cursor-not-allowed',
        fill,
        dims,
        className
      )}
    >
      <BaseCheckbox.Indicator className="flex items-center justify-center text-ink-primary-inverse data-[disabled]:text-ink-tertiary">
        {indeterminate ? <Minus size={size === 'lg' ? 14 : 11} strokeWidth={2.5} /> : <Check size={size === 'lg' ? 14 : 11} strokeWidth={2.5} />}
      </BaseCheckbox.Indicator>
    </BaseCheckbox.Root>
  )
}

const FIELD = 'flex w-full rounded-md px-2.5 ring ring-hairline ring-inset bg-surface-elevated text-ink-primary outline-none placeholder:text-ink-tertiary focus:ring-1 focus:ring-ink-accent disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-ink-tertiary'
const INPUT_SIZES = { sm: 'h-7 rounded-md text-sm', md: 'h-9 rounded-lg text-base', lg: 'h-11 rounded-lg text-base' }

export const Input = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: keyof typeof INPUT_SIZES }>(function Input({ size = 'md', className, ...props }, ref) {
  return <input ref={ref} className={cn(FIELD, INPUT_SIZES[size], className)} {...props} />
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { size?: 'sm' | 'md' }>(function Textarea({ size = 'md', className, ...props }, ref) {
  return <textarea ref={ref} className={cn(FIELD, 'resize-none py-2', size === 'sm' ? 'min-h-7 rounded-md text-sm' : 'min-h-9 rounded-lg text-base', className)} {...props} />
})

/** Label above a control, with an optional hint below it. */
export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }): ReactNode {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-sm text-ink-primary">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-ink-secondary [&_a]:underline [&_a:hover]:text-ink-accent">{hint}</span>}
    </label>
  )
}
