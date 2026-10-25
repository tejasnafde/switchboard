import { hubChipText, type HubChatView } from '@shared/hub'

/** "Hub, 3 children · Waiting for children" in the header of a chat with unsettled children. */
export function HubChip({ view }: { view: HubChatView }) {
  if (view.children.length === 0) return null
  return (
    <span
      data-testid="hub-chip"
      className="shrink-0 rounded-full border border-[var(--border)] px-[8px] py-[1px] text-[11px] text-[var(--text-secondary)]"
    >
      {hubChipText(view)}
    </span>
  )
}
