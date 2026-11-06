import { useState } from 'react'
import { hubChildrenCount, type HubChatView } from '@shared/hub'
import { cn } from '../../lib/utils'
import { chipClass, chipValueClass } from '../ui/chip'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import type { ToolbarOverflowEntry } from '../ui/toolbar'
import { hubChipDot } from './child-dot'
import { HubChildrenList } from './HubChildrenList'

/**
 * "Hub · 3 children · 2 running" in the header of a parent, with a dot for
 * the most urgent child. It opens the children list in a popover (the list
 * sat above the composer as a strip until 2026-11-07). "Child" in an open
 * child chat, which has no list: its banner names the parent.
 */
export function HubChip({ view }: { view: HubChatView }) {
  const [open, setOpen] = useState(false)
  if (view.parent) return <span className={cn(chipClass, 'cursor-default')}>Child</span>
  if (view.children.length === 0) return null
  const running = view.children.filter((c) => c.state === 'working').length
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-testid="hub-chip" className={chipClass}>
          <span className="sidebar-recent-dot" data-dot={hubChipDot(view.children)} />
          Hub <span className="text-[var(--text-muted)]">·</span>
          <span className={chipValueClass}>{hubChildrenCount(view.children)}</span>
          {running > 0 && (
            <>
              <span className="text-[var(--text-muted)]">·</span>
              <span className={chipValueClass}>{running} running</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="sb-floating-surface z-[1200] w-[360px] overflow-hidden rounded-[8px] border border-[var(--border)]"
      >
        <HubChildrenList view={view} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The Hub chip's row in a narrow header's "..." menu: the same children list,
 * inside that menu. A child's "Child" chip has no row: its banner names the
 * parent.
 */
export function hubOverflowEntry(view: HubChatView): ToolbarOverflowEntry | null {
  if (view.parent || view.children.length === 0) return null
  const running = view.children.filter((c) => c.state === 'working').length
  const count = hubChildrenCount(view.children)
  return {
    key: 'hub',
    icon: <HubIcon />,
    name: 'Hub',
    valueText: running > 0 ? `${count} · ${running} running` : count,
    wide: true,
    body: (close) => <HubChildrenList view={view} onDone={close} />,
  }
}

function HubIcon() {
  return (
    <svg
      aria-hidden
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      className="shrink-0 text-[var(--text-muted)]"
    >
      <circle cx="8" cy="4" r="2" />
      <circle cx="3.5" cy="12" r="1.6" />
      <circle cx="12.5" cy="12" r="1.6" />
      <path d="M7 5.8 4.3 10.5M9 5.8l2.7 4.7" />
    </svg>
  )
}
