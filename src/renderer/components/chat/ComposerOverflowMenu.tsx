import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { DotsIcon, footerChipClass, optionMenuClass } from './FooterChip'

/** A footer control that moved into the "..." menu (see composer-footer-tiers.ts). */
export interface OverflowEntry {
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
 * The "..." chip at the end of a narrow composer footer. It lists the
 * controls the footer had no room for; a row opens that control's own list
 * in the same popover. Escape in a list goes back to the rows.
 *
 * The chip shows only below the footer's overflow step (a container query),
 * and the caller passes the entries `overflowedPriorities` names for the
 * width `useContainerTier` read, so both agree on what moved.
 */
export function ComposerOverflowMenu({ entries }: { entries: OverflowEntry[] }) {
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
    <Popover open={open} onOpenChange={(next) => { if (next) setOpen(true); else close() }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="More options"
          title="More options"
          data-composer-overflow
          className={cn(footerChipClass, 'hidden w-[24px] justify-center px-0 @max-[600px]/footer:inline-flex')}
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

function OverflowRows({ entries, onOpenEntry }: { entries: OverflowEntry[]; onOpenEntry: (key: string) => void }) {
  const listRef = useRef<HTMLDivElement>(null)
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])

  // On open, and on the way back from a list.
  useEffect(() => { rows()[0]?.focus() }, [])

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
          <span aria-hidden className="shrink-0 text-[11px] text-[var(--text-muted)]">›</span>
        </button>
      ))}
    </div>
  )
}
