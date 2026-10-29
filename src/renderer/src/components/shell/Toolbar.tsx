import { createContext, useContext, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PanelLeft, Search } from 'lucide-react'
import { Tooltip, cn } from '../oats'
import { useLayout, useUi } from './layout'

// Granola's toolbar (docs/granola-ui.md §Toolbar): a 44px header floating over the page, which scrolls under a
// blurred fade. The left cluster tracks the sidebar's width; pages put their own controls in the slot.

const SlotContext = createContext<{ slot: HTMLElement | null; setSlot: (el: HTMLElement | null) => void }>({ slot: null, setSlot: () => {} })

export function ToolbarProvider({ children }: { children: ReactNode }): ReactNode {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  return <SlotContext.Provider value={{ slot, setSlot }}>{children}</SlotContext.Provider>
}

/** Renders page controls into the toolbar. */
export function ToolbarContent({ children }: { children: ReactNode }): ReactNode {
  const { slot } = useContext(SlotContext)
  return slot ? createPortal(children, slot) : null
}

function ChromeButton({ label, kbd, onClick, children, testId, className }: { label: string; kbd: string; onClick: () => void; children: ReactNode; testId?: string; className?: string }): ReactNode {
  return (
    <Tooltip content={label} kbd={kbd} sideOffset={4}>
      <button
        type="button"
        aria-label={label}
        data-testid={testId}
        onClick={onClick}
        className={cn('no-drag group/chrome -m-0.5 flex size-8 shrink-0 cursor-default items-center justify-center rounded-full ring-focus-ring-inset outline-none', className)}
      >
        <span className="relative flex size-7 items-center justify-center rounded-full text-ink-secondary group-hover/chrome:bg-fill-highlight">{children}</span>
      </button>
    </Tooltip>
  )
}

export function SidebarToggleButton(): ReactNode {
  const opened = useLayout((s) => s.opened)
  const toggle = useLayout((s) => s.toggle)
  return (
    <ChromeButton label={opened ? 'Close sidebar' : 'Open sidebar'} kbd="Ctrl S" onClick={toggle} testId="toggle-sidebar-button">
      <PanelLeft size={16} />
    </ChromeButton>
  )
}

export function SearchButton({ className }: { className?: string }): ReactNode {
  const setSearch = useUi((s) => s.setSearch)
  return (
    <ChromeButton label="Search" kbd="Ctrl K" onClick={() => setSearch(true)} testId="toolbar-search-button" className={className}>
      <Search size={16} />
    </ChromeButton>
  )
}

export function Toolbar({ title, hideSidebar }: { title?: string; hideSidebar?: boolean }): ReactNode {
  const { setSlot } = useContext(SlotContext)
  const opened = useLayout((s) => s.opened)
  const narrow = useLayout((s) => s.narrow)
  const width = useLayout((s) => s.width)
  const animate = useLayout((s) => s.animate && !s.resizing)
  const sidebarVisible = !hideSidebar && !narrow && opened

  return (
    <header data-sidebar-animating={animate} className="drag group/toolbar absolute inset-x-0 top-0 z-20 flex h-11 items-stretch">
      {!hideSidebar && (
        <div
          className={cn('relative flex shrink-0 items-center px-2', sidebarVisible ? 'min-w-[136px]' : 'min-w-[76px]', animate ? 'transition-[width,min-width] duration-200 ease-out' : 'transition-none')}
          style={{ width: sidebarVisible ? width : 0 }}
        >
          <div className="relative z-10 flex items-center gap-4">
            <SidebarToggleButton />
            <SearchButton className="-ms-3.5" />
          </div>
        </div>
      )}
      <div className={cn('relative flex min-w-0 flex-1 items-center gap-2 px-2', hideSidebar && 'pl-4')}>
        {title && (
          <div className="pointer-events-none absolute inset-y-0 left-1/2 flex w-max -translate-x-1/2 items-center justify-center">
            <span className="text-sm font-book text-ink-secondary">{title}</span>
          </div>
        )}
        <div ref={setSlot} className="flex min-w-0 flex-1 items-center gap-2" />
      </div>
      {/* Space for the window controls drawn by the title bar overlay: Granola reserves 138px for Windows' three
          buttons; on Linux the overlay is as wide as the desktop's button layout, so measure it. */}
      <div className="shrink-0" style={{ width: 'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 8px)' }} />
    </header>
  )
}

/** The blurred surface-coloured fade at the top of the content column, under the toolbar. */
export function ToolbarFade(): ReactNode {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-[19] h-11 overflow-hidden">
      <div className="absolute -inset-x-12 -top-12 -bottom-5 bg-linear-to-b from-surface from-70% to-transparent blur-md" />
    </div>
  )
}
