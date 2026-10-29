import type { ReactNode, RefObject } from 'react'
import { Dialog as Base } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import { Button, IconButton } from './Button'
import { cn } from './cn'

const BACKDROP =
  'fixed inset-0 z-50 bg-oats-neutral-600/40 dark:bg-oats-black/60 transition-opacity duration-75 ease-out data-[starting-style]:opacity-0 data-[ending-style]:opacity-0'
const POPUP =
  'fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl bg-surface p-4 text-sm shadow-xl ring ring-hairline outline-none select-none sm:max-w-sm dark:ring-inset transition-[scale,opacity] duration-75 ease-out data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0'

/**
 * A modal dialog (Base UI) drawn like Granola's: dimmed backdrop, centred card that scales in from 95%.
 * `className` widens or reshapes the card.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  showClose = true,
  initialFocus
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  className?: string
  showClose?: boolean
  /** Element to focus when the dialog opens (defaults to the first focusable one). */
  initialFocus?: RefObject<HTMLElement | null>
}): ReactNode {
  return (
    <Base.Root open={open} onOpenChange={(o) => onOpenChange(o)}>
      <Base.Portal>
        <Base.Backdrop className={BACKDROP} />
        <Base.Popup initialFocus={initialFocus} className={cn(POPUP, className)}>
          {(title || description) && (
            <div className="flex flex-col gap-1.5">
              {title && <Base.Title className="pr-6 text-lg font-medium text-ink-primary">{title}</Base.Title>}
              {description && <Base.Description className="text-sm text-balance text-ink-secondary">{description}</Base.Description>}
            </div>
          )}
          {children}
          {footer && <div className="-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-2xl p-4 sm:flex-row sm:justify-end">{footer}</div>}
          {showClose && <Base.Close render={<IconButton label="Close" className="absolute top-2 right-2" />}>{<X size={16} />}</Base.Close>}
        </Base.Popup>
      </Base.Portal>
    </Base.Root>
  )
}

/** Confirmation dialog with a destructive or primary action, replacing window.confirm. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}): ReactNode {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      showClose={false}
      footer={
        <>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            autoFocus
            variant={danger ? 'danger' : 'primary'}
            onClick={() => {
              onOpenChange(false)
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  )
}
