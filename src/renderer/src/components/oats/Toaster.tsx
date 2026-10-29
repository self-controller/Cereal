import type { ReactNode } from 'react'
import { Toaster as Sonner } from 'sonner'
import { CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from 'lucide-react'

/** Sonner, unstyled, dressed as Granola's toasts. */
export function Toaster({ theme }: { theme: 'light' | 'dark' }): ReactNode {
  return (
    <Sonner
      theme={theme}
      position="bottom-right"
      offset={16}
      gap={8}
      icons={{
        success: <CircleCheck className="size-5 text-ink-secondary" />,
        info: <Info className="size-5 text-ink-secondary" />,
        warning: <TriangleAlert className="size-5 text-amber-500 dark:text-amber-400" />,
        error: <CircleAlert className="size-5 text-rose-500 dark:text-rose-400" />,
        loading: <LoaderCircle className="size-5 animate-spin text-ink-secondary" />
      }}
      toastOptions={{
        unstyled: true,
        closeButton: true,
        classNames: {
          toast:
            'group flex w-full max-w-sm select-none items-center gap-1.5 rounded-lg bg-surface-elevated p-3 text-sm text-ink-primary shadow-sm ring-[0.5px] ring-hairline dark:ring-inset',
          icon: 'relative flex size-5 shrink-0 items-center justify-center',
          content: 'flex-1',
          title: 'flex-grow',
          description: 'mt-0.5 text-xs text-ink-secondary',
          actionButton: 'h-7 cursor-default rounded-lg bg-highlight px-2 text-ink-primary hover:bg-highlight-secondary',
          cancelButton: 'order-last h-7 cursor-default rounded-lg px-2 text-ink-primary hover:bg-highlight',
          closeButton:
            'absolute -top-1.5 -left-1.5 hidden size-5 items-center justify-center rounded-full bg-surface-elevated text-ink-secondary ring-[0.5px] ring-hairline group-hover:flex [&>svg]:size-3'
        }
      }}
    />
  )
}
