import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Bot, ChevronDown, ChevronsUpDown, Folder, FolderPlus, House, LayoutTemplate, LogOut, MessageCircle, MoreHorizontal, NotebookText, Pencil, Settings, SunMoon, Trash2, WandSparkles } from 'lucide-react'
import { call, errorMessage } from '../../lib/api'
import { navigate, type Route } from '../../lib/router'
import { useApp } from '../../store'
import { AnimatePresence, Avatar, Button, ConfirmDialog, Dialog, Input, Menu, MenuCheckItem, MenuItem, MenuSeparator, SubMenu, Tooltip, cn, motion } from '../oats'
import { SearchButton, SidebarToggleButton } from './Toolbar'
import { useLayout, useUi } from './layout'

// ------------------------------------------------------------------ frame

/**
 * The sidebar frame (docs/granola-ui.md §Sidebar): sunken surface with a right hairline, resizable 192–330px.
 * In a narrow window it floats over the page as a rounded panel with a scrim.
 */
export function SidebarFrame({ children }: { children: ReactNode }): ReactNode {
  const opened = useLayout((s) => s.opened)
  const narrow = useLayout((s) => s.narrow)
  const width = useLayout((s) => s.width)
  const animate = useLayout((s) => s.animate && !s.resizing)
  const close = useLayout((s) => s.close)

  return (
    <>
      <div className="group/sidebar relative grid shrink-0 select-none" style={{ '--sidebar-width': `${width}px` } as CSSProperties}>
        <div
          inert={!opened}
          className={cn(
            'flex flex-col overflow-hidden bg-surface-sunken',
            narrow
              ? 'fixed top-1 bottom-1 left-1 z-40 w-(--sidebar-width) rounded-[13px] shadow-2xl ring-[0.5px] ring-hairline dark:ring-inset'
              : cn('border-r', opened ? 'w-(--sidebar-width)' : 'w-0 border-r-0', animate ? 'transition-[width] duration-200 ease-out' : 'transition-none')
          )}
          style={
            narrow
              ? { transform: opened ? 'translateX(0)' : 'translateX(calc(-1 * (var(--sidebar-width) + 10px)))', transition: animate ? 'transform 150ms ease-out' : 'none' }
              : undefined
          }
        >
          <div className="flex h-full w-(--sidebar-width) flex-1 flex-col">{children}</div>
        </div>
        {opened && !narrow && <ResizeHandle />}
      </div>
      <AnimatePresence>
        {narrow && opened && (
          <motion.div
            key="scrim"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.4, 0, 0.2, 1] }}
            onClick={close}
            className="fixed inset-0 z-30 bg-black/30 dark:bg-black/70"
          />
        )}
      </AnimatePresence>
    </>
  )
}

function ResizeHandle(): ReactNode {
  const width = useLayout((s) => s.width)
  const setWidth = useLayout((s) => s.setWidth)
  const setResizing = useLayout((s) => s.setResizing)
  const drag = useRef<{ x: number; w: number } | null>(null)
  return (
    <div
      aria-hidden
      className="group/resize absolute top-11 bottom-0 z-20 grid w-[7px] cursor-col-resize place-items-center before:absolute before:inset-y-0 before:left-1/2 before:w-[7.5px] before:-translate-x-1/2 before:bg-highlight-secondary before:opacity-0 before:transition-opacity hover:before:opacity-100"
      style={{ right: -3 }}
      onPointerDown={(e) => {
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, w: width }
        setResizing(true)
      }}
      onPointerMove={(e) => {
        if (drag.current) setWidth(drag.current.w + e.clientX - drag.current.x)
      }}
      onPointerUp={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
        drag.current = null
        setResizing(false)
      }}
      onPointerCancel={() => {
        drag.current = null
        setResizing(false)
      }}
    >
      <div className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 rounded-full bg-ink-accent opacity-0 transition-opacity group-hover/resize:opacity-100" />
    </div>
  )
}

/** Space under the toolbar, or (as an overlay) a header with its own toggle and search. */
export function SidebarHeader(): ReactNode {
  const narrow = useLayout((s) => s.narrow)
  if (!narrow) return <div className="mb-3 h-11 shrink-0" />
  return (
    <div className="drag mb-4 flex h-9 shrink-0 flex-row items-center pr-2 pl-1.5">
      <SidebarToggleButton />
      <SearchButton className="ms-0.5" />
    </div>
  )
}

// ------------------------------------------------------------------ items

export function SidebarItem({
  icon,
  label,
  active,
  onClick,
  trailing,
  meta,
  className,
  testId
}: {
  icon: ReactNode
  label: ReactNode
  active?: boolean
  onClick: () => void
  /** Actions shown on hover (they replace `meta`). */
  trailing?: ReactNode
  /** Quiet metadata on the right, e.g. a count. */
  meta?: ReactNode
  className?: string
  testId?: string
}): ReactNode {
  return (
    <div
      data-slot="sidebar-item"
      data-active={active ? '' : undefined}
      className={cn(
        'group/sidebar-item relative my-px flex h-7 w-full min-w-0 cursor-default items-center gap-1.5 rounded-lg px-1 text-sm select-none ring-focus-ring-inset-within has-[[data-focus-ring-target]:focus-visible]:bg-fill-highlight',
        active ? 'bg-fill-highlight' : 'hover:bg-oats-off-black-a6 dark:hover:bg-oats-off-white-a4',
        className
      )}
    >
      <button
        type="button"
        data-focus-ring-target=""
        data-testid={testId}
        aria-current={active ? 'page' : undefined}
        onClick={onClick}
        className="flex h-full min-w-0 flex-1 cursor-default items-center gap-1.5 rounded-md bg-transparent text-left text-ink-secondary-strong outline-none"
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-ink-secondary">{icon}</span>
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </button>
      {(trailing || meta) && (
        <div className="grid-pile shrink-0">
          {meta && <span className="pointer-events-none flex items-center justify-end pr-1 text-xs text-ink-tertiary transition-opacity group-hover/sidebar-item:opacity-0 group-has-data-popup-open/sidebar-item:opacity-0">{meta}</span>}
          {trailing && (
            <span className="flex items-center gap-px opacity-0 transition-opacity group-hover/sidebar-item:opacity-100 group-focus-within/sidebar-item:opacity-100 group-has-data-popup-open/sidebar-item:opacity-100">
              {trailing}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** A small hover action inside a sidebar row (e.g. "Open chat", "…"). */
export function SidebarAction({ label, onClick, children, ...rest }: { label: string; onClick?: () => void; children: ReactNode }): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      {...rest}
      className="flex size-5 shrink-0 cursor-default items-center justify-center rounded text-ink-tertiary outline-none ring-focus-ring-inset hover:bg-fill-highlight hover:text-ink-secondary-strong data-popup-open:bg-fill-highlight"
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- sidebar

export function Sidebar({ route }: { route: Route }): ReactNode {
  const folders = useApp((s) => s.folders)
  const settings = useApp((s) => s.settings)
  const showToast = useApp((s) => s.showToast)
  const openTemplates = useUi((s) => s.openTemplates)
  const [myNotesOpen, setMyNotesOpen] = useState(true)
  const [newFolder, setNewFolder] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null)
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null)
  const assistantOn = settings?.assistant.enabled ?? false

  const go = (path: string): void => {
    navigate(path)
    if (useLayout.getState().narrow) useLayout.getState().close()
  }

  return (
    <SidebarFrame>
      <SidebarHeader />
      <nav className="flex flex-col gap-px px-2 pb-2">
        <SidebarItem icon={<House size={16} />} label="Home" active={route.name === 'home'} onClick={() => go('/')} testId="sidebar-home" />
        {assistantOn ? (
          <SidebarItem
            icon={<Bot size={16} />}
            label="Assistant"
            active={route.name === 'assistant'}
            onClick={() => go('/assistant')}
            testId="sidebar-assistant"
            trailing={
              <Tooltip content="Open chat" delay={0}>
                <SidebarAction label="Open chat" onClick={() => go('/chat')}>
                  <MessageCircle size={14} />
                </SidebarAction>
              </Tooltip>
            }
          />
        ) : (
          <SidebarItem icon={<Bot size={16} />} label="Assistant" active={route.name === 'assistant'} onClick={() => go('/assistant')} testId="sidebar-assistant" />
        )}
        <SidebarItem icon={<MessageCircle size={16} />} label="Chat" active={route.name === 'chat'} onClick={() => go('/chat')} testId="sidebar-chat" />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <SidebarItem
          icon={<NotebookText size={16} />}
          label={
            <span className="flex items-center gap-0.5">
              My notes
              <ChevronDown
                size={10}
                className={cn('relative top-[0.5px] text-ink-tertiary opacity-0 transition-[transform,opacity] group-hover/sidebar:opacity-100', !myNotesOpen && '-rotate-90')}
              />
            </span>
          }
          active={route.name === 'folder' && route.id === 'all'}
          onClick={() => {
            if (route.name === 'folder' && route.id === 'all') setMyNotesOpen((o) => !o)
            else go('/folder/all')
          }}
          testId="sidebar-my-notes"
          trailing={
            <Tooltip content="New folder" delay={0}>
              <SidebarAction label="New folder" onClick={() => setNewFolder('')}>
                <FolderPlus size={14} />
              </SidebarAction>
            </Tooltip>
          }
        />
        <AnimatePresence initial={false}>
          {myNotesOpen && (
            <motion.div key="folders" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: 'easeInOut' }} className="overflow-hidden">
              {folders.length === 0 && (
                <button type="button" onClick={() => setNewFolder('')} className="ml-3 flex h-7 items-center gap-1.5 rounded-lg px-1 text-sm text-ink-tertiary hover:text-ink-secondary">
                  <FolderPlus size={14} /> New folder
                </button>
              )}
              {folders.map((f) => (
                <SidebarItem
                  key={f.id}
                  className="pl-3"
                  icon={<Folder size={16} />}
                  label={f.title}
                  active={route.name === 'folder' && route.id === f.id}
                  onClick={() => go(`/folder/${f.id}`)}
                  meta={f.document_count || undefined}
                  trailing={
                    <Menu
                      trigger={
                        <SidebarAction label="Folder options">
                          <MoreHorizontal size={14} />
                        </SidebarAction>
                      }
                    >
                      <MenuItem onClick={() => setRenaming({ id: f.id, title: f.title })}>
                        <Pencil size={16} /> Rename
                      </MenuItem>
                      <MenuItem danger onClick={() => setDeleting({ id: f.id, title: f.title })}>
                        <Trash2 size={16} /> Delete folder
                      </MenuItem>
                    </Menu>
                  }
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <SidebarFooter
        onRecipes={() => go('/recipes')}
        onTemplates={() => openTemplates()}
        recipesActive={route.name === 'recipes'}
        onSettings={() => go('/settings')}
      />

      <FolderNameDialog
        open={newFolder !== null}
        title="New folder"
        initial=""
        confirm="Create folder"
        onClose={() => setNewFolder(null)}
        onSubmit={async (title) => {
          try {
            const f = await call('folders:create', title)
            go(`/folder/${f.id}`)
          } catch (e) {
            showToast('error', errorMessage(e))
          }
        }}
      />
      <FolderNameDialog
        open={renaming !== null}
        title="Rename folder"
        initial={renaming?.title ?? ''}
        confirm="Rename"
        onClose={() => setRenaming(null)}
        onSubmit={async (title) => {
          if (renaming) await call('folders:rename', renaming.id, title).catch((e) => showToast('error', errorMessage(e)))
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.title ?? ''}”?`}
        description="The folder is removed. Notes inside it are kept."
        confirmLabel="Delete folder"
        danger
        onConfirm={async () => {
          if (!deleting) return
          await call('folders:delete', deleting.id)
          if (route.name === 'folder' && route.id === deleting.id) go('/')
        }}
      />
    </SidebarFrame>
  )
}

function FolderNameDialog({ open, title, initial, confirm, onClose, onSubmit }: { open: boolean; title: string; initial: string; confirm: string; onClose: () => void; onSubmit: (title: string) => Promise<void> | void }): ReactNode {
  const [value, setValue] = useState(initial)
  const [lastOpen, setLastOpen] = useState(open)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) setValue(initial)
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={title} className="sm:max-w-[360px]">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!value.trim()) return
          onClose()
          await onSubmit(value.trim())
        }}
      >
        <Input autoFocus size="sm" placeholder="Folder name" value={value} onChange={(e) => setValue(e.target.value)} />
        <div className="flex justify-end gap-2">
          <Button variant="soft" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!value.trim()}>
            {confirm}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

function SidebarFooter({ onRecipes, onTemplates, onSettings, recipesActive }: { onRecipes: () => void; onTemplates: () => void; onSettings: () => void; recipesActive: boolean }): ReactNode {
  const settings = useApp((s) => s.settings)
  const setSettings = useApp((s) => s.setSettings)
  const name = settings?.profile.name || 'Cereal'
  const footerIcon = (active: boolean): string =>
    cn('flex size-7 cursor-default items-center justify-center rounded-lg text-ink-secondary outline-none ring-focus-ring-inset', active ? 'bg-fill-highlight' : 'hover:bg-fill-highlight')
  const setTheme = async (theme: 'system' | 'light' | 'dark'): Promise<void> => setSettings(await call('settings:update', { theme }))

  return (
    <>
      <div className="px-2">
        <div className="flex flex-row items-center gap-px py-1.5">
          <Tooltip content="Recipes" side="top">
            <button type="button" aria-label="Recipes" data-testid="sidebar-recipes-button" onClick={onRecipes} className={footerIcon(recipesActive)}>
              <WandSparkles size={16} />
            </button>
          </Tooltip>
          <Tooltip content="Templates" side="top">
            <button type="button" aria-label="Templates" data-testid="sidebar-templates-button" onClick={onTemplates} className={footerIcon(false)}>
              <LayoutTemplate size={16} />
            </button>
          </Tooltip>
        </div>
      </div>
      <div className="w-full px-1 pb-1">
        <div className="mx-2 mb-1 h-[0.5px] bg-hairline" role="separator" />
        <Menu
          side="top"
          align="start"
          className="w-64"
          trigger={
            <button
              type="button"
              data-testid="account-menu"
              className="flex h-9 w-full cursor-default flex-row items-center gap-1 overflow-hidden rounded-lg rounded-bl-xl px-1 py-1 pl-2 outline-none ring-focus-ring-inset hover:bg-fill-soft data-popup-open:bg-fill-soft"
            >
              <Avatar name={name} size={20} square />
              <span className="ml-1 min-w-0 flex-1 truncate text-left text-sm font-medium text-ink-primary">{name}</span>
              <ChevronsUpDown size={12} className="shrink-0 text-ink-secondary" />
            </button>
          }
        >
          <div className="flex items-center gap-2.5 px-2 py-2">
            <Avatar name={name} size={28} square className="rounded-lg" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm text-ink-primary">{name}</span>
              <span className="truncate text-xs text-ink-secondary">{settings?.profile.email || 'Local profile'}</span>
            </div>
          </div>
          <MenuSeparator />
          <MenuItem onClick={onSettings}>
            <Settings size={16} /> Settings
            <span className="ml-auto text-xs text-ink-tertiary">Ctrl ,</span>
          </MenuItem>
          <SubMenu
            label={
              <>
                <SunMoon size={16} className="text-ink-secondary" /> Theme
              </>
            }
          >
            {(['system', 'light', 'dark'] as const).map((t) => (
              <MenuCheckItem key={t} checked={settings?.theme === t} onClick={() => void setTheme(t)}>
                {t === 'system' ? 'Match system' : t === 'light' ? 'Light' : 'Dark'}
              </MenuCheckItem>
            ))}
          </SubMenu>
          <MenuSeparator />
          <MenuItem onClick={() => void call('app:quit')}>
            <LogOut size={16} /> Quit Cereal
          </MenuItem>
        </Menu>
      </div>
    </>
  )
}
