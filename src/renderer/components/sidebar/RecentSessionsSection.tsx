import { useEffect, useState } from 'react'
import type { RecentSessionItem } from './recent-sessions'
import { RelativeTimeLabel } from './RelativeTimeLabel'
import { DEFAULT_RECENT_SESSION_LIMIT, type RecentSessionLimit } from './recent-session-limit'
import { RECENT_DOT_LABELS, groupRecentSessions, recentDot } from './recent-groups'
import { useRenderCount } from '../../services/render-counter'
import { focusRecentRow, neighbourAfterRemoval } from './recent-row-focus'

export function RecentSessionsSection({
  items,
  initialLimit = DEFAULT_RECENT_SESSION_LIMIT,
  activeSessionId,
  displayedSessionIds = [],
  onSelect,
  onSettle,
}: {
  items: RecentSessionItem[]
  initialLimit?: RecentSessionLimit
  activeSessionId: string | null
  displayedSessionIds?: readonly (string | null)[]
  onSelect: (item: RecentSessionItem) => void
  /** Settle a "Done recently" row; without it the rows offer no Settle. */
  onSettle?: (item: RecentSessionItem) => void
}) {
  useRenderCount('RecentSessionsSection')
  const [revealedCount, setRevealedCount] = useState(0)
  useEffect(() => setRevealedCount(0), [initialLimit])
  if (items.length === 0) return null
  const { groups, hiddenCount, nextRevealCount } = groupRecentSessions(items, initialLimit, revealedCount)
  const expanded = revealedCount > 0
  const rowIds = groups.flatMap((group) => group.items.map((item) => item.session.id))
  return (
    <section className="sidebar-recents" aria-label="Recent conversations">
      {groups.map((group) => (
        <div key={group.key} className="sidebar-recent-group" data-group={group.key}>
          <div className="sidebar-section-label">
            <span>{group.label}</span>
            {group.key !== 'done' && <span className="sidebar-recent-count">{group.items.length}</span>}
          </div>
          {group.items.map((item) => {
            const dot = recentDot(item.status)
            const active = activeSessionId === item.session.id
            const settleable = group.key === 'done' && onSettle !== undefined
            return (
              <div
                key={`${item.machineId}:${item.session.id}`}
                className={`sidebar-recent-row ${active ? 'active' : ''} ${displayedSessionIds.includes(item.session.id) ? 'displayed' : ''} ${settleable ? 'settleable' : ''}`}
              >
                <button
                  type="button"
                  className="sidebar-recent-row-button"
                  data-recent-id={item.session.id}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onSelect(item)}
                >
                  <span className="sidebar-recent-line">
                    <span
                      className="sidebar-recent-dot"
                      data-dot={dot}
                      role="img"
                      aria-label={RECENT_DOT_LABELS[dot]}
                      title={RECENT_DOT_LABELS[dot]}
                    />
                    <span className="sidebar-recent-title">{item.session.title}</span>
                    <RelativeTimeLabel className="sidebar-recent-detail" timestamp={item.session.startedAt} />
                  </span>
                  <span className="sidebar-recent-status" title={item.statusLine}>
                    {item.statusLine}
                  </span>
                </button>
                {settleable && (
                  <button
                    type="button"
                    className="sidebar-recent-settle"
                    aria-label={`Settle ${item.session.title}`}
                    title="Take this chat out of Done recently"
                    onClick={() => {
                      const next = neighbourAfterRemoval(rowIds, item.session.id)
                      onSettle(item)
                      if (next) focusRecentRow(next)
                    }}
                  >
                    Settle
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ))}
      {(hiddenCount > 0 || expanded) && (
        <div className="sidebar-recents-actions">
          {hiddenCount > 0 && (
            <button
              type="button"
              className="sidebar-recents-more"
              aria-expanded={expanded}
              onClick={() => setRevealedCount(nextRevealCount)}
            >
              Show {nextRevealCount - revealedCount} more
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
