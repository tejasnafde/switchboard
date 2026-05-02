/**
 * KanbanView — top-level kanban board, scoped by workspace + project.
 *
 * Replaces the per-session right-pane kanban. Lives at App level alongside
 * (not inside) the chat layout — the sidebar stays mounted and drives
 * filtering: clicking a workspace in the sidebar narrows the board, and
 * clicking a session there exits back to chat view.
 *
 * The default scope is "All workspaces" (every project the user has
 * opened). Selecting a workspace narrows to its projects; a further
 * project filter drills down to one project. We don't aggregate cards in
 * main — kanban-store hydrates per-project and we union in-memory, which
 * keeps the IPC surface minimal at the cost of N round-trips on first
 * load (O(projects), not O(cards), and projects are typically <20).
 *
 * Card tiles show their project's basename so cross-project boards stay
 * legible. Starting a card switches `appView` back to 'chats' so the
 * user lands in the new conversation immediately.
 *
 * Drag-and-drop (2026-05-02) lives via `@dnd-kit/core`: columns are
 * droppables keyed by status, tiles are draggables, drops fire
 * `kanban-store.move`. No within-column reorder yet (cards remain
 * createdAt-sorted until we add a `sortOrder` column).
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useAgentStore } from '../../stores/agent-store'
import { useKanbanStore } from '../../stores/kanban-store'
import { useLayoutStore } from '../../stores/layout-store'
import { KANBAN_COLUMNS, type KanbanCard, type KanbanStatus } from '@shared/kanban'
import type { AgentStatus, Project, Workspace } from '@shared/types'
import { CardModal } from './CardModal'
import { WorktreeManagerModal } from './WorktreeManagerModal'
import { launchCardChat } from './cardLaunch'

const UNGROUPED = '__ungrouped__'

export function KanbanView(): React.ReactElement {
  const workspaceFilter = useLayoutStore((s) => s.kanbanWorkspaceFilter)
  const projectFilter = useLayoutStore((s) => s.kanbanProjectFilter)
  const setWorkspaceFilter = useLayoutStore((s) => s.setKanbanWorkspaceFilter)
  const setProjectFilter = useLayoutStore((s) => s.setKanbanProjectFilter)
  const setAppView = useLayoutStore((s) => s.setAppView)

  const { byProject, hydrate, move } = useKanbanStore()

  const [projects, setProjects] = useState<Project[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [managingWorktrees, setManagingWorktrees] = useState(false)
  const [filter, setFilter] = useState('')
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // 5px activation distance keeps clicks (open edit modal) distinct
  // from drags. Without it every mousedown becomes a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  )

  // Hydrate projects + workspaces once on mount. The renderer doesn't
  // have a project-list store yet (sidebar fetches its own copy on
  // mount), so we re-fetch here. Cheap: this is a small SQLite query.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      const [ps, ws] = await Promise.all([
        window.api.app.getProjects() as Promise<Project[]>,
        window.api.app.workspaces.list(),
      ])
      if (cancelled) return
      setProjects(ps)
      setWorkspaces(ws)
    }
    void load()
    return () => { cancelled = true }
  }, [])

  // Projects in scope of the current workspace filter.
  const scopedProjects = useMemo(() => {
    if (workspaceFilter === null) return projects
    if (workspaceFilter === UNGROUPED) return projects.filter((p) => !p.workspaceId)
    return projects.filter((p) => p.workspaceId === workspaceFilter)
  }, [projects, workspaceFilter])

  // Hydrate kanban cards for every project we'll display. Re-runs when
  // the scope changes — kanban-store dedupes on key so refreshes stay
  // cheap. We deliberately don't await: cards stream in per-project.
  useEffect(() => {
    for (const p of scopedProjects) {
      void hydrate(p.path)
    }
  }, [scopedProjects, hydrate])

  // Aggregated card list for the board. When a project filter is set,
  // narrows to that project; otherwise unions cards across all scoped
  // projects.
  const allCards: KanbanCard[] = useMemo(() => {
    const inScope = projectFilter
      ? scopedProjects.filter((p) => p.path === projectFilter)
      : scopedProjects
    const out: KanbanCard[] = []
    for (const p of inScope) {
      const list = byProject[p.path]
      if (list) out.push(...list)
    }
    return out
  }, [scopedProjects, projectFilter, byProject])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return allCards
    return allCards.filter((c) =>
      c.title.toLowerCase().includes(q) ||
      c.description.toLowerCase().includes(q) ||
      c.tags.some((t) => t.toLowerCase().includes(q))
    )
  }, [allCards, filter])

  const projectByPath = useMemo(() => {
    const m = new Map<string, Project>()
    for (const p of projects) m.set(p.path, p)
    return m
  }, [projects])

  // Two CTAs:
  //   ▶  (background) — start the agent, stay on the kanban board.
  //   ↗  (open)       — start (or jump-to) and switch to chats view.
  // Both go through the shared `launchCardChat` so the persistence /
  // provider-bridge wiring stays in one place.
  const startCardBackground = useCallback(
    async (card: KanbanCard) => {
      const result = await launchCardChat(card, { openChat: false })
      if (!result.reused && card.status === 'backlog') {
        // Background launch implies "start the work"; promote to in_progress
        // so the column reflects reality without a separate drag.
        void move(card.id, 'in_progress')
      }
    },
    [move],
  )
  const startCardAndOpen = useCallback(
    async (card: KanbanCard) => {
      const result = await launchCardChat(card, { openChat: true })
      if (!result.reused && card.status === 'backlog') {
        void move(card.id, 'in_progress')
      }
      setAppView('chats')
    },
    [move, setAppView],
  )

  const editingCard = editingId ? allCards.find((c) => c.id === editingId) ?? null : null
  // "+ New card" needs a project to attach to. We seed the modal with
  // the most specific guess available (project filter, or the only
  // project in scope), and pass the full scoped list so the modal can
  // render a picker when the answer is ambiguous. The button itself
  // stays enabled as long as *some* project is in scope.
  const newCardDefaultPath = projectFilter ?? scopedProjects[0]?.path ?? null
  const newCardOptions = scopedProjects.map((p) => ({ path: p.path, name: p.name }))

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDraggingId(String(event.active.id))
  }, [])

  // Droppable id is the column's status (see useDroppable below), so
  // we can map directly from drop target → new status.
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setDraggingId(null)
    const cardId = String(event.active.id)
    const overId = event.over?.id != null ? String(event.over.id) : null
    if (!overId || !KANBAN_COLUMNS.some((c) => c.id === overId)) return
    const card = allCards.find((c) => c.id === cardId)
    if (!card || card.status === overId) return
    void move(cardId, overId as KanbanStatus)
  }, [allCards, move])

  const draggingCard = draggingId ? allCards.find((c) => c.id === draggingId) ?? null : null

  return (
    <div style={paneStyle}>
      <div style={toolbarStyle}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Kanban</div>
        <select
          value={workspaceFilter ?? ''}
          onChange={(e) => setWorkspaceFilter(e.target.value || null)}
          style={selectStyle}
          title="Filter by workspace"
        >
          <option value="">All workspaces</option>
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
          <option value={UNGROUPED}>Ungrouped</option>
        </select>
        <select
          value={projectFilter ?? ''}
          onChange={(e) => setProjectFilter(e.target.value || null)}
          style={selectStyle}
          title="Filter by project"
        >
          <option value="">All projects ({scopedProjects.length})</option>
          {scopedProjects.map((p) => (
            <option key={p.path} value={p.path}>{p.name}</option>
          ))}
        </select>
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter title / tag…"
          style={inputStyle}
        />
        <div style={{ flex: 1 }} />
        <button
          onClick={() => setManagingWorktrees(true)}
          disabled={!projectFilter}
          style={secondaryBtnStyle}
          title={projectFilter ? 'Manage git worktrees for this project' : 'Pick a project to manage its worktrees'}
        >
          ⎇ Worktrees
        </button>
        <button
          onClick={() => setCreating(true)}
          disabled={!newCardDefaultPath}
          style={primaryBtnStyle}
          title={
            !newCardDefaultPath
              ? 'No projects in scope yet — open a project from the sidebar first'
              : newCardOptions.length > 1
                ? 'Create card (you’ll pick the project in the modal)'
                : `Create card in ${newCardDefaultPath.split('/').pop()}`
          }
        >
          ＋ New card
        </button>
        <button
          onClick={() => setAppView('chats')}
          style={secondaryBtnStyle}
          title="Back to chats (⌘⇧K)"
        >
          ✕ Close
        </button>
      </div>

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div style={columnsStyle}>
          {KANBAN_COLUMNS.map((col) => (
            <Column
              key={col.id}
              status={col.id}
              label={col.label}
              cards={filtered.filter((c) => c.status === col.id)}
              projectByPath={projectByPath}
              onOpen={(id) => setEditingId(id)}
              onStart={(c) => { void startCardBackground(c) }}
              onStartAndOpen={(c) => { void startCardAndOpen(c) }}
              showProjectChip={!projectFilter}
              draggingId={draggingId}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={null}>
          {draggingCard && (
            <CardTilePresentation
              card={draggingCard}
              projectName={projectByPath.get(draggingCard.projectPath)?.name ?? draggingCard.projectPath.split('/').pop() ?? ''}
              showProjectChip={!projectFilter}
              isOverlay
            />
          )}
        </DragOverlay>
      </DndContext>

      {creating && newCardDefaultPath && (
        <CardModal
          mode="create"
          projectPath={newCardDefaultPath}
          availableProjects={newCardOptions}
          onClose={() => setCreating(false)}
        />
      )}
      {editingCard && (
        <CardModal
          mode="edit"
          card={editingCard}
          projectPath={editingCard.projectPath}
          onClose={() => setEditingId(null)}
        />
      )}
      {managingWorktrees && projectFilter && (
        <WorktreeManagerModal
          projectPath={projectFilter}
          onClose={() => { setManagingWorktrees(false); void hydrate(projectFilter) }}
        />
      )}
    </div>
  )
}

function Column({
  status,
  label,
  cards,
  projectByPath,
  onOpen,
  onStart,
  onStartAndOpen,
  showProjectChip,
  draggingId,
}: {
  status: KanbanStatus
  label: string
  cards: KanbanCard[]
  projectByPath: Map<string, { name: string }>
  onOpen: (id: string) => void
  onStart: (card: KanbanCard) => void
  onStartAndOpen: (card: KanbanCard) => void
  showProjectChip: boolean
  draggingId: string | null
}): React.ReactElement {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div
      ref={setNodeRef}
      style={{
        ...colStyle,
        ...(isOver ? colDropTargetStyle : null),
      }}
    >
      <div style={colHeaderStyle}>
        <span>{label}</span>
        <span style={{ opacity: 0.5, fontVariantNumeric: 'tabular-nums' }}>{cards.length}</span>
      </div>
      <div style={colBodyStyle}>
        {cards.map((c) => (
          <DraggableCardTile
            key={c.id}
            card={c}
            projectName={projectByPath.get(c.projectPath)?.name ?? c.projectPath.split('/').pop() ?? ''}
            showProjectChip={showProjectChip}
            isDragging={draggingId === c.id}
            onOpen={() => onOpen(c.id)}
            onStart={() => onStart(c)}
            onStartAndOpen={() => onStartAndOpen(c)}
          />
        ))}
        {cards.length === 0 && (
          <div style={{ opacity: 0.4, fontSize: 11, padding: 8, textAlign: 'center' }}>
            (drop cards here)
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Drag wiring split from presentation so `DragOverlay` can re-render
 * the same tile without conflicting `useDraggable` bindings.
 */
function DraggableCardTile({
  card,
  projectName,
  showProjectChip,
  isDragging,
  onOpen,
  onStart,
  onStartAndOpen,
}: {
  card: KanbanCard
  projectName: string
  showProjectChip: boolean
  isDragging: boolean
  onOpen: () => void
  onStart: () => void
  onStartAndOpen: () => void
}): React.ReactElement {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: card.id })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <CardTilePresentation
        card={card}
        projectName={projectName}
        showProjectChip={showProjectChip}
        isSource={isDragging}
        onStart={onStart}
        onStartAndOpen={onStartAndOpen}
      />
    </div>
  )
}

function CardTilePresentation({
  card,
  projectName,
  showProjectChip,
  isSource,
  isOverlay,
  onStart,
  onStartAndOpen,
}: {
  card: KanbanCard
  projectName: string
  showProjectChip: boolean
  isSource?: boolean
  isOverlay?: boolean
  onStart?: () => void
  onStartAndOpen?: () => void
}): React.ReactElement {
  // Subscribed only when a session is linked, so cardless tiles skip the lookup.
  const liveStatus = useAgentStore((s) =>
    card.conversationId
      ? s.sessions.find((x) => x.id === card.conversationId)?.status
      : undefined,
  )
  const unread = useAgentStore((s) =>
    card.conversationId
      ? s.sessions.find((x) => x.id === card.conversationId)?.unreadCount ?? 0
      : 0,
  )

  const overBudget = card.costCapUsd != null && card.costUsedUsd != null && card.costUsedUsd >= card.costCapUsd
  const hasSession = !!card.conversationId

  return (
    <div
      style={{
        ...tileStyle,
        ...(isSource ? { opacity: 0.3 } : null),
        ...(isOverlay ? tileOverlayStyle : null),
      }}
      data-needs-input={card.status === 'needs_input' || undefined}
      data-over-budget={overBudget || undefined}
    >
      <div style={tileHeaderRowStyle}>
        <div style={tileTitleStyle}>{card.title}</div>
        {(onStart || onStartAndOpen) && (
          <div style={tileActionsStyle}>
            {/* When the card already has a linked session there's only
                one sensible CTA: jump into it. The background-vs-open
                split only matters at first-launch. */}
            {hasSession ? (
              onStartAndOpen && (
                <button
                  onMouseDown={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onStartAndOpen() }}
                  title="Jump to linked chat"
                  style={startBtnStyle}
                >
                  ↗
                </button>
              )
            ) : (
              <>
                {onStart && (
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onStart() }}
                    title="Start (background) — kicks off the agent without leaving the board"
                    style={startBtnStyle}
                  >
                    ▶
                  </button>
                )}
                {onStartAndOpen && (
                  <button
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => { e.stopPropagation(); onStartAndOpen() }}
                    title="Start and open chat"
                    style={startBtnStyle}
                  >
                    ▶↗
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      {card.tags.length > 0 && (
        <div style={tagsRowStyle}>
          {card.tags.map((t) => <span key={t} style={tagStyle}>{t}</span>)}
        </div>
      )}
      <div style={tileMetaRowStyle}>
        {hasSession && <SessionLiveness status={liveStatus} />}
        {hasSession && unread > 0 && (
          <span style={unreadBadgeStyle} title={`${unread} unread message${unread === 1 ? '' : 's'}`}>
            {unread} new
          </span>
        )}
        {showProjectChip && <span style={projectChipStyle}>{projectName}</span>}
        {card.worktreePath && <span title={card.worktreePath} style={badgeStyle}>⎇ worktree</span>}
        {card.costCapUsd != null && (
          <span style={{ ...badgeStyle, color: overBudget ? 'var(--red, #d73a49)' : undefined }}>
            ${(card.costUsedUsd ?? 0).toFixed(2)}/${card.costCapUsd.toFixed(2)}
          </span>
        )}
      </div>
    </div>
  )
}

function SessionLiveness({ status }: { status: AgentStatus | undefined }): React.ReactElement | null {
  if (!status || status === 'exited') return null
  const active = status === 'running' || status === 'thinking'
  const isError = status === 'error'
  const color = isError ? 'var(--red, #d73a49)' : active ? 'var(--green, #3fb950)' : 'var(--fg)'
  const label = isError ? 'error' : active ? status : 'idle'
  return (
    <span style={livenessRowStyle} title={`Session ${label}`}>
      <span
        style={{
          ...livenessPipStyle,
          background: color,
          opacity: active ? 1 : 0.55,
          animation: active ? 'sb-kanban-pulse 1.4s ease-in-out infinite' : undefined,
        }}
      />
      <span style={{ color, fontSize: 10, opacity: active ? 0.95 : 0.7 }}>{label}</span>
    </span>
  )
}

const paneStyle: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0, background: 'var(--bg)' }
const toolbarStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
  borderBottom: '1px solid var(--border)', background: 'var(--bg-elev1, transparent)',
}
const inputStyle: CSSProperties = {
  fontSize: 12, padding: '4px 8px', background: 'var(--bg)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 4, width: 200,
}
const selectStyle: CSSProperties = {
  fontSize: 12, padding: '4px 8px', background: 'var(--bg)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 4,
}
const primaryBtnStyle: CSSProperties = {
  fontSize: 12, padding: '4px 12px', background: 'var(--accent, #2563eb)', color: 'white',
  border: 'none', borderRadius: 4, cursor: 'pointer',
}
const secondaryBtnStyle: CSSProperties = {
  fontSize: 12, padding: '4px 10px', background: 'transparent', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
}
const columnsStyle: CSSProperties = {
  flex: 1, display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, padding: 12, overflow: 'auto',
}
const colStyle: CSSProperties = {
  display: 'flex', flexDirection: 'column', minHeight: 0,
  background: 'var(--bg-elev1, rgba(0,0,0,0.03))', borderRadius: 6,
  border: '1px solid var(--border)',
  transition: 'border-color 120ms ease, box-shadow 120ms ease',
}
const colDropTargetStyle: CSSProperties = {
  borderColor: 'var(--accent, #2563eb)',
  boxShadow: '0 0 0 1px var(--accent, #2563eb), 0 0 12px rgba(37,99,235,0.18)',
}
const colHeaderStyle: CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '8px 12px', fontSize: 11, fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: 0.5, opacity: 0.85, borderBottom: '1px solid var(--border)',
}
const colBodyStyle: CSSProperties = {
  flex: 1, overflow: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6,
}
const tileStyle: CSSProperties = {
  textAlign: 'left', padding: '8px 10px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--fg)',
  cursor: 'grab', display: 'flex', flexDirection: 'column', gap: 4,
  userSelect: 'none',
}
const tileOverlayStyle: CSSProperties = {
  cursor: 'grabbing',
  transform: 'rotate(-1.5deg)',
  boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
  borderColor: 'var(--accent, #2563eb)',
}
const tileHeaderRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 6, justifyContent: 'space-between',
}
const tileTitleStyle: CSSProperties = { fontSize: 13, lineHeight: 1.3, fontWeight: 500, flex: 1, minWidth: 0 }
const tileActionsStyle: CSSProperties = { display: 'flex', gap: 4, flexShrink: 0 }
const startBtnStyle: CSSProperties = {
  fontSize: 11, lineHeight: 1, padding: '2px 6px', borderRadius: 3,
  background: 'transparent', color: 'var(--fg)',
  border: '1px solid var(--border)', cursor: 'pointer',
}
const tagsRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4 }
const tagStyle: CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'var(--bg-elev2, rgba(0,0,0,0.06))', color: 'var(--fg)',
}
const tileMetaRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 10, opacity: 0.85, alignItems: 'center' }
const badgeStyle: CSSProperties = { fontSize: 10, opacity: 0.8 }
const projectChipStyle: CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(37,99,235,0.12)', color: 'var(--accent, #2563eb)', fontFamily: 'monospace',
}
const livenessRowStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
}
const livenessPipStyle: CSSProperties = {
  width: 7, height: 7, borderRadius: '50%', display: 'inline-block',
}
const unreadBadgeStyle: CSSProperties = {
  fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 8,
  background: 'var(--accent, #2563eb)', color: 'white', letterSpacing: 0.2,
}
