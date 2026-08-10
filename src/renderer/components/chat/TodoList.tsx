import type { TodoItem } from '@shared/provider-events'

/**
 * The agent's progress checklist, as a plain list.
 *
 * Deliberately not a card with actions: this used to render through PlanCard,
 * which put Implement and Iterate buttons under a list that answers no
 * question and changes several times a turn.
 */
export function TodoList({ items }: { items: TodoItem[] }) {
  const done = items.filter((i) => i.status === 'completed').length
  return (
    <div style={{ margin: '6px 0', fontSize: '12.5px' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        color: 'var(--text-muted)',
        fontSize: '10.5px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        marginBottom: 4,
      }}>
        <span>Checklist</span>
        <span style={{ textTransform: 'none', letterSpacing: 0 }}>{done}/{items.length}</span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
        {items.map((item, i) => (
          <li
            key={`${i}-${item.text}`}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 7,
              color: item.status === 'completed' ? 'var(--text-muted)' : 'var(--text-primary)',
              textDecoration: item.status === 'completed' ? 'line-through' : 'none',
            }}
          >
            <span aria-hidden style={{
              width: 12,
              flexShrink: 0,
              color: item.status === 'in_progress' ? 'var(--accent, #4a7dff)' : 'var(--text-muted)',
            }}>
              {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▸' : '○'}
            </span>
            <span style={{ overflowWrap: 'anywhere' }}>{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
