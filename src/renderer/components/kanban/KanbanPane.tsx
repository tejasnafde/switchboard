/**
 * KanbanPane — the right-pane "Kanban" mode.
 *
 * Hydrates cards for the active project, renders 4 columns
 * (Backlog / In progress / Needs input / Done), and offers a
 * keyboard-friendly card modal for create + edit.
 *
 * Drag-to-reorder is intentionally NOT in v1 — column moves happen
 * via a status select in the card detail. We can add @dnd-kit later
 * once the interaction model proves out; columns first, ergonomics
 * second.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import { useKanbanStore } from '../../stores/kanban-store'
import { KANBAN_COLUMNS, type KanbanCard, type KanbanStatus } from '@shared/kanban'
import { CardModal } from './CardModal'

export function KanbanPane(): React.ReactElement {
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const projectPath = useAgentStore((s) => {
    const sess = s.sessions.find((x) => x.id === s.activeSessionId)
    return sess?.projectPath ?? null
  })

  const { byProject, hydrate } = useKanbanStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (projectPath) void hydrate(projectPath)
  }, [projectPath, hydrate, activeSessionId])

  const cards = projectPath ? byProject[projectPath] ?? [] : []
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return cards
    return cards.filter((c) =>
      c.title.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [cards, filter])

  if (!projectPath) {
    return (
      <div style={emptyStateStyle}>
        Select a chat to view its project's kanban board.
      </div>
    )
  }

  const editingCard = editingId ? cards.find((c) => c.id === editingId) ?? null : null

  return (
    <div style={paneStyle}>
      <div style={toolbarStyle}>
        <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }}>
          Kanban — {projectPath.split('/').pop()}
        </div>
        <div style={{ flex: 1 }} />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter title / tag…"
          style={inputStyle}
        />
        <button onClick={() => setCreating(true)} style={primaryBtnStyle}>＋ New card</button>
      </div>

      <div style={columnsStyle}>
        {KANBAN_COLUMNS.map((col) => (
          <Column
            key={col.id}
            label={col.label}
            cards={filtered.filter((c) => c.status === col.id)}
            onOpen={(id) => setEditingId(id)}
          />
        ))}
      </div>

      {creating && (
        <CardModal
          mode="create"
          projectPath={projectPath}
          onClose={() => setCreating(false)}
        />
      )}
      {editingCard && (
        <CardModal
          mode="edit"
          card={editingCard}
          projectPath={projectPath}
          onClose={() => setEditingId(null)}
        />
      )}
    </div>
  )
}

function Column({
  label,
  cards,
  onOpen,
}: {
  label: string
  cards: KanbanCard[]
  onOpen: (id: string) => void
}): React.ReactElement {
  return (
    <div style={colStyle}>
      <div style={colHeaderStyle}>
        <span>{label}</span>
        <span style={{ opacity: 0.5, fontVariantNumeric: 'tabular-nums' }}>{cards.length}</span>
      </div>
      <div style={colBodyStyle}>
        {cards.map((c) => (
          <CardTile key={c.id} card={c} onClick={() => onOpen(c.id)} />
        ))}
        {cards.length === 0 && (
          <div style={{ opacity: 0.4, fontSize: 11, padding: 8, textAlign: 'center' }}>
            (empty)
          </div>
        )}
      </div>
    </div>
  )
}

function CardTile({ card, onClick }: { card: KanbanCard; onClick: () => void }): React.ReactElement {
  const overBudget = card.costCapUsd != null && card.costUsedUsd != null && card.costUsedUsd >= card.costCapUsd
  return (
    <button onClick={onClick} style={tileStyle} data-needs-input={card.status === 'needs_input' || undefined} data-over-budget={overBudget || undefined}>
      <div style={tileTitleStyle}>{card.title}</div>
      {card.tags.length > 0 && (
        <div style={tagsRowStyle}>
          {card.tags.map((t) => <span key={t} style={tagStyle}>{t}</span>)}
        </div>
      )}
      <div style={tileMetaRowStyle}>
        {card.worktreePath && <span title={card.worktreePath} style={badgeStyle}>⎇ worktree</span>}
        {card.costCapUsd != null && (
          <span style={{ ...badgeStyle, color: overBudget ? 'var(--red, #d73a49)' : undefined }}>
            ${(card.costUsedUsd ?? 0).toFixed(2)}/${card.costCapUsd.toFixed(2)}
          </span>
        )}
        {card.conversationId && <span style={badgeStyle}>● session</span>}
      </div>
    </button>
  )
}

const KanbanStatusOrder: Record<KanbanStatus, number> = {
  backlog: 0,
  in_progress: 1,
  needs_input: 2,
  done: 3,
}
// Exported only so the store / future drag-and-drop can sort consistently.
export { KanbanStatusOrder }

const paneStyle: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }
const toolbarStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
  borderBottom: '1px solid var(--border)', background: 'var(--bg-elev1, transparent)',
}
const inputStyle: CSSProperties = {
  fontSize: 12, padding: '4px 8px', background: 'var(--bg)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 4, width: 180,
}
const primaryBtnStyle: CSSProperties = {
  fontSize: 12, padding: '4px 10px', background: 'var(--accent, #2563eb)', color: 'white',
  border: 'none', borderRadius: 4, cursor: 'pointer',
}
const columnsStyle: CSSProperties = {
  flex: 1, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, padding: 10, overflow: 'auto',
}
const colStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', minHeight: 0,
  background: 'var(--bg-elev1, rgba(0,0,0,0.03))', borderRadius: 6, border: '1px solid var(--border)',
}
const colHeaderStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '6px 10px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: 0.5, opacity: 0.85, borderBottom: '1px solid var(--border)',
}
const colBodyStyle: CSSProperties = {
  flex: 1, overflow: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6,
}
const tileStyle: CSSProperties = {
  textAlign: 'left', padding: '8px 10px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)',
  cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
}
const tileTitleStyle: CSSProperties = { fontSize: 13, lineHeight: 1.3, fontWeight: 500 }
const tagsRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }
const tagStyle: CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'var(--bg-elev2, rgba(0,0,0,0.06))', color: 'var(--fg)',
}
const tileMetaRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 10, opacity: 0.7 }
const badgeStyle: CSSProperties = { fontSize: 10 }
const emptyStateStyle: CSSProperties = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 12, opacity: 0.6, padding: 24, textAlign: 'center',
}
