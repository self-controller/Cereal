import { Fragment, type ReactNode } from 'react'
import { cn } from '../../components/oats'

// The settings layout kit: a page with a title, grouped cards of rows.

export function Page({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="@container h-full w-full overflow-y-auto pt-11 text-ink-primary select-none">
      <div className="mx-auto max-w-2xl px-4 pt-3 pb-16 @sm:px-6">
        <div className="mb-8 flex items-start gap-4 px-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="flex w-fit items-center gap-2 text-h3">{title}</h1>
            {description && <p className="text-sm text-ink-secondary">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
        {children}
      </div>
    </div>
  )
}

export function Group({ label, children }: { label?: string; children: ReactNode }): ReactNode {
  const rows = (Array.isArray(children) ? children : [children]).flat().filter(Boolean)
  return (
    <section className="mb-8 last:mb-0">
      {label && <h2 className="mb-2 px-2 text-sm font-book text-ink-secondary">{label}</h2>}
      <div className="relative overflow-hidden rounded-2xl bg-surface-elevated ring ring-hairline dark:ring-inset">
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && <div className="dashed-rule mx-4 opacity-80" />}
            {row}
          </Fragment>
        ))}
      </div>
    </section>
  )
}

/** A settings row: icon tile, title and description, and a control on the right (or below with `stacked`). */
export function Row({ icon, title, description, children, stacked }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; children?: ReactNode; stacked?: boolean }): ReactNode {
  return (
    <div className={cn('group/row relative flex gap-4 p-4 py-[15px]', stacked ? 'flex-col items-stretch' : 'items-center')}>
      <div className="flex min-w-0 flex-1 items-center gap-4">
        {icon && <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-tint-neutral text-ink-secondary">{icon}</div>}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-0.5 text-sm last:mb-0">{title}</div>
          {description && <div className="text-xs text-ink-secondary [&_a]:underline [&_a:hover]:text-ink-accent [&_code]:font-mono">{description}</div>}
        </div>
        {!stacked && children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
      {stacked && children && <div className={cn('flex flex-col gap-3', icon && 'pl-12')}>{children}</div>}
    </div>
  )
}
