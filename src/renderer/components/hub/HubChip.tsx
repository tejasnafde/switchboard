import { hubChildCount, type HubChatView } from '@shared/hub'
import { cn } from '../../lib/utils'
import { chipClass, chipValueClass } from '../ui/chip'

/** "Hub, 3 children" in the header of a parent, scrolling its strip into view; "Child" in an open child. */
export function HubChip({ view }: { view: HubChatView }) {
  if (view.parent) return <span className={cn(chipClass, 'cursor-default')}>Child</span>
  if (view.children.length === 0) return null
  return (
    <button
      type="button"
      data-testid="hub-chip"
      className={chipClass}
      onClick={(e) =>
        e.currentTarget
          .closest('[data-chat-panel]')
          ?.querySelector('[data-testid=hub-children-strip]')
          ?.scrollIntoView({ block: 'nearest' })
      }
    >
      Hub, <span className={chipValueClass}>{hubChildCount(view.children.length)}</span>
    </button>
  )
}
