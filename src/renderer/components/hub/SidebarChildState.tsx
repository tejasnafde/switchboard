import { childStateWord, type HubChildView } from '@shared/hub'
import { useHubStore, useHubView } from '../../stores/hub-store'
import { hubChildDot } from './child-dot'
import { MachineBadge } from './MachineBadge'

/** Keeps an unfolded parent's hub view loaded for its child rows: one read per parent, not per child. */
export function HubViewMount({ parentId }: { parentId: string }) {
  useHubView(parentId)
  return null
}

/** A child's row in its parent's hub view; undefined until read. */
function useHubChild(parentId: string, childId: string): HubChildView | undefined {
  return useHubStore((s) => s.views[parentId]?.children.find((c) => c.chat.familyIds.includes(childId)))
}

export function ChildStateDot({ parentId, childId }: { parentId: string; childId: string }) {
  const child = useHubChild(parentId, childId)
  return child ? <span className="sidebar-recent-dot" data-dot={hubChildDot(child)} /> : null
}

export function ChildStateWord({ parentId, childId }: { parentId: string; childId: string }) {
  const child = useHubChild(parentId, childId)
  if (!child) return null
  return (
    <>
      {child.remote && <MachineBadge name={child.remote.machine} />}
      <span className="sidebar-thread-time">{childStateWord(child)}</span>
    </>
  )
}
