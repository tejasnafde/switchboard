/**
 * Unread pills shared by local (Sidebar) and remote (MachineLayer) session
 * rows. The count comes from agent-store's per-session unreadCount, which is
 * machine-agnostic - remote sessions were counting all along, MachineLayer
 * just never rendered a badge (docs/notes/unread-remote-diagnosis.md).
 */
import { useAgentStore } from '../../stores/agent-store'

function useUnreadCount(sessionId: string): number {
  return useAgentStore((s) => s.sessions.find((sess) => sess.id === sessionId)?.unreadCount ?? 0)
}

export function UnreadBadge({ sessionId }: { sessionId: string }) {
  const count = useUnreadCount(sessionId)
  if (count === 0) return null
  return (
    <span style={{
      minWidth: '16px',
      height: '16px',
      borderRadius: '8px',
      background: 'var(--accent)',
      color: '#fff',
      fontSize: '10px',
      fontWeight: 600,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 4px',
      flexShrink: 0,
    }}>
      {count > 99 ? '99+' : count}
    </span>
  )
}

/** Sum of unread counts across a workspace group - surfaces activity when the
 *  workspace is collapsed and per-session badges are hidden. */
function useGroupUnreadCount(sessionIds: string[]): number {
  // Return a primitive from the selector so this only triggers a re-render when
  // the summed count actually changes - not on every streamed token (which is
  // what subscribing to the whole `sessions` array + rebuilding a Map did).
  return useAgentStore((s) => {
    let total = 0
    for (const id of sessionIds) {
      total += s.sessions.find((x) => x.id === id)?.unreadCount ?? 0
    }
    return total
  })
}

/** Aggregated unread badge on workspace and project headers. Only rendered
 *  while the group is collapsed - when expanded, the per-session pills
 *  inside cover the same information and the group pill becomes
 *  redundant noise. */
export function GroupUnreadBadge({ sessionIds, expanded }: { sessionIds: string[]; expanded?: boolean }) {
  const count = useGroupUnreadCount(sessionIds)
  if (count === 0 || expanded) return null
  return (
    <span
      title={`${count} unread`}
      style={{
        minWidth: '14px',
        height: '14px',
        borderRadius: '7px',
        background: 'var(--accent)',
        color: '#fff',
        fontSize: '9.5px',
        fontWeight: 600,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 4px',
        flexShrink: 0,
        marginLeft: 4,
      }}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
