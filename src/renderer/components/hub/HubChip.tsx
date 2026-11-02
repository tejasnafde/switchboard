import { hubChildrenCount, type HubChatView } from '@shared/hub'
import { cn } from '../../lib/utils'
import { chipClass, chipValueClass } from '../ui/chip'
import type { ToolbarOverflowEntry } from '../ui/toolbar'

/** What the Hub chip and its "..." row do: scroll the panel's children strip into view. */
export function scrollToHubStrip(panel: Element | null | undefined): void {
  panel?.querySelector('[data-testid=hub-children-strip]')?.scrollIntoView({ block: 'nearest' })
}

/**
 * "Hub · 3 children" (or "Hub · 4 children on 3 machines") in the header of a
 * parent, scrolling its strip into view; "Child" in an open child.
 */
export function HubChip({ view }: { view: HubChatView }) {
  if (view.parent) return <span className={cn(chipClass, 'cursor-default')}>Child</span>
  if (view.children.length === 0) return null
  return (
    <button
      type="button"
      data-testid="hub-chip"
      className={chipClass}
      onClick={(e) => scrollToHubStrip(e.currentTarget.closest('[data-chat-panel]'))}
    >
      Hub <span className="text-[var(--text-muted)]">·</span>
      <span className={chipValueClass}>{hubChildrenCount(view.children)}</span>
    </button>
  )
}

/**
 * The Hub chip's row in a narrow header's "..." menu, for a parent with
 * children. A child's "Child" chip has no row: its banner names the parent.
 */
export function hubOverflowEntry(
  view: HubChatView,
  panel: () => Element | null | undefined,
): (ToolbarOverflowEntry & { onSelect: () => void }) | null {
  if (view.parent || view.children.length === 0) return null
  return {
    key: 'hub',
    icon: <HubIcon />,
    name: 'Hub',
    valueText: hubChildrenCount(view.children),
    onSelect: () => scrollToHubStrip(panel()),
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
