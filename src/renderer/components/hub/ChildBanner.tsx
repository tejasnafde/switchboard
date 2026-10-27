import type { HubChatRef } from '@shared/hub'
import { Button } from '../ui/button'
import { nudgeChild, openHubChat } from './hub-actions'

/**
 * Takes the chat input's place in an open child: the user talks to it through
 * its parent. Its approval and question cards above still answer, and Stop
 * shows while it runs.
 */
export function ChildBanner({
  parent,
  child,
  onStop,
}: {
  parent: HubChatRef
  child: HubChatRef
  /** Set while the child runs. */
  onStop?: () => void
}) {
  return (
    <div
      role="note"
      data-testid="hub-child-banner"
      className="mx-6 mb-4 flex items-center gap-[10px] rounded-[10px] border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-[12px] text-[var(--text-secondary)]"
    >
      <div className="min-w-0 flex-1">
        <span className="font-[600] text-[var(--text-primary)]">Child of {parent.title}.</span> It works on its brief
        and reports to its parent. To steer it, message the hub.
      </div>
      <div className="flex shrink-0 gap-[6px]">
        {onStop && (
          <Button variant="destructive-outline" size="sm" onClick={onStop}>
            Stop
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void openHubChat(parent, child)}>
          Open hub
        </Button>
        <Button variant="default" size="sm" onClick={() => void nudgeChild(parent, child)}>
          Message the hub
        </Button>
      </div>
    </div>
  )
}
