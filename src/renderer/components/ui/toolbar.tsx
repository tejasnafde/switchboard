import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { cn } from '../../lib/utils'
import { chipClass, DotsIcon, optionMenuClass } from './chip'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import type { ToolbarStep } from './toolbar-steps'

// Tailwind reads whole class names from the source, so each step is spelled out.
const HIDE_BELOW: Record<ToolbarStep, string> = {
  760: '@max-[760px]/toolbar:hidden',
  680: '@max-[680px]/toolbar:hidden',
  600: '@max-[600px]/toolbar:hidden',
  480: '@max-[480px]/toolbar:hidden',
  400: '@max-[400px]/toolbar:hidden',
}

const SHOW_BELOW: Record<ToolbarStep, string> = {
  760: '@max-[760px]/toolbar:inline-flex',
  680: '@max-[680px]/toolbar:inline-flex',
  600: '@max-[600px]/toolbar:inline-flex',
  480: '@max-[480px]/toolbar:inline-flex',
  400: '@max-[400px]/toolbar:inline-flex',
}

/**
 * A row of controls that never wraps. It is the `toolbar` container its
 * items' `/toolbar` container queries read (see toolbar-steps.ts).
 */
export function Toolbar({ className, ...props }: ComponentProps<'div'>) {
  return <div data-toolbar className={cn('@container/toolbar flex items-center', className)} {...props} />
}

/** An item that leaves the row below `hideBelow`; list it in the `ToolbarOverflow` too. */
export function ToolbarItem({ hideBelow, children }: { hideBelow: ToolbarStep; children: ReactNode }) {
  return <span className={cn('contents', HIDE_BELOW[hideBelow])}>{children}</span>
}

/**
 * The tier an element's content width falls in, kept current with a
 * ResizeObserver. For what a CSS container query cannot reach, such as a
 * popover portalled out of the container: pass the same steps the container
 * queries use, as a pure `tierOf(width)`.
 *
 * Returns a callback ref for the container and its current tier. The first
 * reading happens in a layout effect, so the first paint already uses it.
 */
export function useContainerTier<T>(tierOf: (width: number) => T): [(element: HTMLElement | null) => void, T] {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [tier, setTier] = useState<T>(() => tierOf(0))
  const tierOfRef = useRef(tierOf)
  tierOfRef.current = tierOf

  useLayoutEffect(() => {
    if (!element) return
    // Content box, the width an inline-size container query reads.
    const read = (width: number) => setTier(tierOfRef.current(width))
    read(element.getBoundingClientRect().width - horizontalPadding(element))
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) read(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  const ref = useCallback((next: HTMLElement | null) => setElement(next), [])
  return [ref, tier]
}

function horizontalPadding(element: HTMLElement): number {
  const style = getComputedStyle(element)
  return (
    (parseFloat(style.paddingLeft) || 0) +
    (parseFloat(style.paddingRight) || 0) +
    (parseFloat(style.borderLeftWidth) || 0) +
    (parseFloat(style.borderRightWidth) || 0)
  )
}

/** An item that left a `Toolbar` row for its "..." menu (see toolbar-steps.ts). */
export interface ToolbarOverflowEntry {
  key: string
  icon: ReactNode
  /** The row's name: "Effort", "Checkout", "Mode". */
  name: string
  /** What it is set to now, on the right of the row. */
  valueText: string
  /** A list that needs more room than the rows (the branch search). */
  wide?: boolean
  /** The control's list, shown in place of the rows. Call `close` after a pick. */
  body: (close: () => void) => ReactNode
}

/**
 * The "..." chip at the end of a narrow toolbar. It lists the items the row
 * had no room for; a row opens that item's own list in the same popover.
 * Escape in a list goes back to the rows.
 *
 * The chip shows below `showBelow` (a container query, the highest step any
 * item hides at), and the caller passes the entries `overflowedItems` names
 * for the tier `useContainerTier` read, so both agree on what moved.
 */
export function ToolbarOverflow({ entries, showBelow }: { entries: ToolbarOverflowEntry[]; showBelow: ToolbarStep }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<string | null>(null)
  const active = entries.find((entry) => entry.key === view)

  // The footer widened while the menu was open: close it, so it does not
  // pop open again the next time the footer narrows.
  useEffect(() => {
    if (entries.length > 0) return
    setOpen(false)
    setView(null)
  }, [entries.length])

  if (entries.length === 0) return null

  const close = () => {
    setOpen(false)
    setView(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else close()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More options"
          title="More options"
          data-toolbar-overflow
          className={cn(chipClass, 'hidden w-[24px] justify-center px-0', SHOW_BELOW[showBelow])}
        >
          <DotsIcon />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label="More options"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.stopPropagation()
          if (!active) return
          e.preventDefault()
          setView(null)
        }}
        className={cn(optionMenuClass, active?.wide ? 'w-[320px]' : 'w-[248px]')}
      >
        {active ? (
          <div className="flex flex-col gap-[2px]">
            <button
              type="button"
              onClick={() => setView(null)}
              className="flex cursor-pointer items-center gap-[6px] rounded-[5px] border-0 bg-transparent px-[8px] pt-[4px] pb-[6px] text-left text-[10.5px] text-[var(--text-muted)] outline-none hover:text-[var(--text-primary)] focus-visible:text-[var(--text-primary)]"
            >
              <span aria-hidden>‹</span>
              {active.name}
            </button>
            {active.body(close)}
          </div>
        ) : (
          <OverflowRows entries={entries} onOpenEntry={setView} />
        )}
      </PopoverContent>
    </Popover>
  )
}

function OverflowRows({
  entries,
  onOpenEntry,
}: {
  entries: ToolbarOverflowEntry[]
  onOpenEntry: (key: string) => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

  // On open, and on the way back from a list.
  useEffect(() => {
    rows()[0]?.focus()
  }, [])

  const moveFocus = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = rows()
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)]?.focus()
  }

  return (
    <div ref={listRef} role="menu" aria-label="More options" onKeyDown={moveFocus} className="flex flex-col gap-[1px]">
      <div className="px-[8px] pt-[4px] pb-[6px] text-[10.5px] text-[var(--text-muted)]">More options</div>
      {entries.map((entry) => (
        <button
          key={entry.key}
          type="button"
          role="menuitem"
          data-overflow-entry={entry.key}
          onClick={() => onOpenEntry(entry.key)}
          className="flex h-[28px] w-full cursor-pointer items-center gap-[8px] rounded-[5px] border-0 bg-transparent px-[8px] text-left text-[12px] text-[var(--text-secondary)] outline-none hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus-visible:bg-[var(--bg-tertiary)] focus-visible:text-[var(--text-primary)]"
        >
          {entry.icon}
          <span className="shrink-0">{entry.name}</span>
          <span className="ml-auto min-w-0 truncate font-[500] text-[var(--text-primary)]">{entry.valueText}</span>
          <span aria-hidden className="shrink-0 text-[11px] text-[var(--text-muted)]">
            ›
          </span>
        </button>
      ))}
    </div>
  )
}
