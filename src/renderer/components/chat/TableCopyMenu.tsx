import { useMemo, useRef } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'

export type TableCopyFormat = 'table' | 'markdown' | 'csv'

const ITEMS: { format: TableCopyFormat; label: string; hint: string }[] = [
  { format: 'table', label: 'Copy table', hint: 'Sheets, Excel, Slack, Docs' },
  { format: 'markdown', label: 'Copy as Markdown', hint: 'Pipe table' },
  { format: 'csv', label: 'Copy as CSV', hint: 'Comma-separated' },
]

interface TableCopyMenuProps {
  /** Finds the table's menu button now: a streaming commit replaces the node it opened from. */
  findAnchor: () => HTMLElement | null
  open: boolean
  onClose: () => void
  onCopy: (format: TableCopyFormat) => void
}

export function TableCopyMenu({ findAnchor, open, onClose, onCopy }: TableCopyMenuProps) {
  const interactedOutsideRef = useRef(false)
  const anchorRef = useMemo(() => ({
    current: {
      getBoundingClientRect: () => findAnchor()?.getBoundingClientRect() ?? new DOMRect(),
    },
  }), [findAnchor])

  return (
    <Popover open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        align="end"
        sideOffset={4}
        updatePositionStrategy="always"
        aria-label="Copy table as"
        onOpenAutoFocus={() => { interactedOutsideRef.current = false }}
        onInteractOutside={(event) => {
          // The menu button toggles the menu itself on click.
          if (event.target instanceof Node && findAnchor()?.contains(event.target)) event.preventDefault()
          else interactedOutsideRef.current = true
        }}
        // No Popover.Trigger here: the button lives in rendered markdown, so
        // return focus to it by hand, unless the user clicked elsewhere.
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (!interactedOutsideRef.current) findAnchor()?.focus({ preventScroll: true })
        }}
        className="sb-floating-surface z-[1200] w-[220px] overflow-hidden rounded-[6px] border border-[var(--border)] py-[4px] shadow-[0_10px_30px_rgba(0,0,0,0.35)]"
      >
        {ITEMS.map((item) => (
          <button
            key={item.format}
            type="button"
            onClick={() => onCopy(item.format)}
            className="flex w-full cursor-pointer flex-col items-start gap-[1px] border-0 bg-transparent px-[12px] py-[6px] text-left outline-none hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
          >
            <span className="text-[12px] text-[var(--text-primary)]">{item.label}</span>
            <span className="text-[10.5px] text-[var(--text-muted,var(--text-secondary))]">{item.hint}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
