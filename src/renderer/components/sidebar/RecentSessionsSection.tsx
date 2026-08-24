import { useEffect, useState, type ReactNode } from 'react'
import type { RecentSessionItem, RecentSessionStatus } from './recentSessions'
import { formatRelativeTime } from './sidebar-helpers'
import {
  DEFAULT_RECENT_SESSION_LIMIT,
  RECENT_SESSION_PAGE_SIZE,
  nextRecentSessionRevealCount,
  visibleRecentSessions,
  type RecentSessionLimit,
} from './recentSessionLimit'

const STATUS = {
  approval: 'Approval',
  input: 'Input',
  working: 'Working',
  failed: 'Failed',
  done: 'Done',
} as const

function StatusIcon({ status }: { status: RecentSessionStatus }) {
  let content: ReactNode
  switch (status) {
    case 'approval':
      content = <><path d="M12 3 5.5 5.7v5.1c0 4.2 2.7 7.9 6.5 9.2 3.8-1.3 6.5-5 6.5-9.2V5.7L12 3Z" /><path d="M12 7v5" /><path d="M12 16h.01" /></>
      break
    case 'input':
      content = <><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.3 2.3 0 0 1 4.4 1c0 1.6-2.2 1.8-2.2 3.4" /><path d="M12 17h.01" /></>
      break
    case 'working':
      content = <><path d="M12 3a9 9 0 1 1-6.4 2.7" /><path d="M5 3v4h4" /></>
      break
    case 'failed':
      content = <><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></>
      break
    case 'done':
      content = <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.6 2.6L16.5 9" /></>
      break
  }
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {content}
    </svg>
  )
}

export function RecentSessionsSection({ items, initialLimit = DEFAULT_RECENT_SESSION_LIMIT, activeSessionId, displayedSessionIds = [], onSelect }: {
  items: RecentSessionItem[]
  initialLimit?: RecentSessionLimit
  activeSessionId: string | null
  displayedSessionIds?: readonly (string | null)[]
  onSelect: (item: RecentSessionItem) => void
}) {
  const [revealedCount, setRevealedCount] = useState(0)
  useEffect(() => setRevealedCount(0), [initialLimit])
  if (items.length === 0) return null
  const visibleItems = visibleRecentSessions(items, initialLimit, revealedCount)
  const hiddenCount = items.length - visibleItems.length
  const expanded = revealedCount > 0
  return (
    <section className="sidebar-recents" aria-label="Recent conversations">
      <div className="sidebar-section-label">Recents</div>
      {visibleItems.map((item) => {
        const statusLabel = item.status ? STATUS[item.status] : null
        return (
          <button
            key={`${item.machineId}:${item.session.id}`}
            type="button"
            className={`sidebar-recent-row ${activeSessionId === item.session.id ? 'active' : ''} ${displayedSessionIds.includes(item.session.id) ? 'displayed' : ''}`}
            aria-current={activeSessionId === item.session.id ? 'page' : undefined}
            onClick={() => onSelect(item)}
          >
            <span className="sidebar-recent-title">{item.session.title}</span>
            {statusLabel && item.status ? (
              <span className={`sidebar-recent-status ${item.status}`}>
                <StatusIcon status={item.status} />
                <span>{statusLabel}</span>
              </span>
            ) : (
              <span className="sidebar-recent-detail">{formatRelativeTime(item.session.startedAt)}</span>
            )}
          </button>
        )
      })}
      {(hiddenCount > 0 || expanded) && (
        <div className="sidebar-recents-actions">
          {hiddenCount > 0 && (
            <button
              type="button"
              className="sidebar-recents-more"
              aria-expanded={expanded}
              onClick={() => setRevealedCount((count) => (
                nextRecentSessionRevealCount(items.length, initialLimit, count)
              ))}
            >
              Show {Math.min(hiddenCount, RECENT_SESSION_PAGE_SIZE)} more
            </button>
          )}
          {expanded && (
            <button
              type="button"
              className="sidebar-recents-more sidebar-recents-less"
              onClick={() => setRevealedCount(0)}
            >
              Show less
            </button>
          )}
        </div>
      )}
    </section>
  )
}
