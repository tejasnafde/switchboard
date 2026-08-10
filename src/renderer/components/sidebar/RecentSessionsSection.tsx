import type { RecentSessionItem } from './recentSessions'
import { formatRelativeTime } from './sidebar-helpers'

export function RecentSessionsSection({ items, activeSessionId, onSelect }: {
  items: RecentSessionItem[]
  activeSessionId: string | null
  onSelect: (item: RecentSessionItem) => void
}) {
  if (items.length === 0) return null
  return (
    <section className="sidebar-recents" aria-label="Recent conversations">
      <div className="sidebar-section-label">Recents</div>
      {items.map((item) => (
        <button
          key={`${item.machineId}:${item.session.id}`}
          type="button"
          className={`sidebar-recent-row ${activeSessionId === item.session.id ? 'active' : ''}`}
          aria-current={activeSessionId === item.session.id ? 'page' : undefined}
          onClick={() => onSelect(item)}
        >
          <span className="sidebar-recent-title">{item.session.title}</span>
          <span className={`sidebar-recent-detail ${item.attentionLabel ? 'actionable' : ''}`}>
            {item.attentionLabel ?? formatRelativeTime(item.session.startedAt)}
          </span>
        </button>
      ))}
    </section>
  )
}
