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
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useAgentStore } from '../../stores/agent-store'
import { useKanbanStore } from '../../stores/kanban-store'
import { useLayoutStore } from '../../stores/layout-store'
import { emitSessionCreated } from '../../services/session-events'
import { KANBAN_COLUMNS, type KanbanCard } from '@shared/kanban'
import type { Project, Workspace } from '@shared/types'
import { CardModal } from './CardModal'
import { WorktreeManagerModal } from './WorktreeManagerModal'

const UNGROUPED = '__ungrouped__'

export function KanbanView(): React.ReactElement {
  const workspaceFilter = useLayoutStore((s) => s.kanbanWorkspaceFilter)
  const projectFilter = useLayoutStore((s) => s.kanbanProjectFilter)
  const setWorkspaceFilter = useLayoutStore((s) => s.setKanbanWorkspaceFilter)
  const setProjectFilter = useLayoutStore((s) => s.setKanbanProjectFilter)
  const setAppView = useLayoutStore((s) => s.setAppView)

  const addSession = useAgentStore((s) => s.addSession)
  const setActiveSession = useAgentStore((s) => s.setActiveSession)

  const { byProject, hydrate, update: updateCard } = useKanbanStore()

  const [projects, setProjects] = useState<Project[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [managingWorktrees, setManagingWorktrees] = useState(false)
  const [filter, setFilter] = useState('')

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

  // Create / jump-to a chat for a card. Identical to the per-session
  // version but switches `appView` back to 'chats' so the user lands in
  // the new conversation immediately.
  const startOrJumpToCard = useCallback(
    async (card: KanbanCard) => {
      const exists = card.conversationId
        && useAgentStore.getState().sessions.some((x) => x.id === card.conversationId)
      if (exists && card.conversationId) {
        setActiveSession(card.conversationId)
        setAppView('chats')
        return
      }
      const cwd = card.worktreePath ?? card.projectPath
      const id = `agent_${Date.now()}`
      const title = card.title
      addSession({ id, type: 'claude-code', status: 'idle', projectPath: cwd, title })
      setActiveSession(id)
      window.api.app
        .createConversation({ id, projectPath: cwd, agentType: 'claude-code', title })
        .catch((err: unknown) => { console.warn('[kanban] createConversation failed:', err) })
      emitSessionCreated({ id, projectPath: cwd, title, startedAt: Date.now(), source: 'switchboard' })
      await updateCard(card.id, { conversationId: id })
      setAppView('chats')
    },
    [addSession, setActiveSession, setAppView, updateCard],
  )

  const editingCard = editingId ? allCards.find((c) => c.id === editingId) ?? null : null
  // "+ New card" needs a project to attach to. With a project filter
  // selected we use that; otherwise we require one before creating —
  // simpler than a project-picker inside the create modal, and forces
  // the user to think about scope.
  const newCardProjectPath = projectFilter ?? (scopedProjects.length === 1 ? scopedProjects[0].path : null)

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
          disabled={!newCardProjectPath}
          style={primaryBtnStyle}
          title={newCardProjectPath ? `Create card in ${newCardProjectPath.split('/').pop()}` : 'Pick a project to create a card'}
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

      <div style={columnsStyle}>
        {KANBAN_COLUMNS.map((col) => (
          <Column
            key={col.id}
            label={col.label}
            cards={filtered.filter((c) => c.status === col.id)}
            projectByPath={projectByPath}
            onOpen={(id) => setEditingId(id)}
            onStart={(c) => { void startOrJumpToCard(c) }}
            showProjectChip={!projectFilter}
          />
        ))}
      </div>

      {creating && newCardProjectPath && (
        <CardModal
          mode="create"
          projectPath={newCardProjectPath}
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
  label,
  cards,
  projectByPath,
  onOpen,
  onStart,
  showProjectChip,
}: {
  label: string
  cards: KanbanCard[]
  projectByPath: Map<string, { name: string }>
  onOpen: (id: string) => void
  onStart: (card: KanbanCard) => void
  showProjectChip: boolean
}): React.ReactElement {
  return (
    <div style={colStyle}>
      <div style={colHeaderStyle}>
        <span>{label}</span>
        <span style={{ opacity: 0.5, fontVariantNumeric: 'tabular-nums' }}>{cards.length}</span>
      </div>
      <div style={colBodyStyle}>
        {cards.map((c) => (
          <CardTile
            key={c.id}
            card={c}
            projectName={projectByPath.get(c.projectPath)?.name ?? c.projectPath.split('/').pop() ?? ''}
            showProjectChip={showProjectChip}
            onOpen={() => onOpen(c.id)}
            onStart={() => onStart(c)}
          />
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

function CardTile({
  card,
  projectName,
  showProjectChip,
  onOpen,
  onStart,
}: {
  card: KanbanCard
  projectName: string
  showProjectChip: boolean
  onOpen: () => void
  onStart: () => void
}): React.ReactElement {
  const overBudget = card.costCapUsd != null && card.costUsedUsd != null && card.costUsedUsd >= card.costCapUsd
  const hasSession = !!card.conversationId
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
      style={tileStyle}
      data-needs-input={card.status === 'needs_input' || undefined}
      data-over-budget={overBudget || undefined}
    >
      <div style={tileHeaderRowStyle}>
        <div style={tileTitleStyle}>{card.title}</div>
        <button
          onClick={(e) => { e.stopPropagation(); onStart() }}
          title={hasSession ? 'Jump to linked chat' : 'Start a chat for this card'}
          style={startBtnStyle}
        >
          {hasSession ? '↗' : '▶'}
        </button>
      </div>
      {card.tags.length > 0 && (
        <div style={tagsRowStyle}>
          {card.tags.map((t) => <span key={t} style={tagStyle}>{t}</span>)}
        </div>
      )}
      <div style={tileMetaRowStyle}>
        {showProjectChip && <span style={projectChipStyle}>{projectName}</span>}
        {card.worktreePath && <span title={card.worktreePath} style={badgeStyle}>⎇ worktree</span>}
        {card.costCapUsd != null && (
          <span style={{ ...badgeStyle, color: overBudget ? 'var(--red, #d73a49)' : undefined }}>
            ${(card.costUsedUsd ?? 0).toFixed(2)}/${card.costCapUsd.toFixed(2)}
          </span>
        )}
        {hasSession && <span style={badgeStyle}>● session</span>}
      </div>
    </div>
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
  background: 'var(--bg-elev1, rgba(0,0,0,0.03))', borderRadius: 6, border: '1px solid var(--border)',
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
  cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
}
const tileHeaderRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 6, justifyContent: 'space-between',
}
const tileTitleStyle: CSSProperties = { fontSize: 13, lineHeight: 1.3, fontWeight: 500, flex: 1, minWidth: 0 }
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
const tileMetaRowStyle: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 10, opacity: 0.7 }
const badgeStyle: CSSProperties = { fontSize: 10 }
const projectChipStyle: CSSProperties = {
  fontSize: 10, padding: '1px 6px', borderRadius: 8,
  background: 'rgba(37,99,235,0.12)', color: 'var(--accent, #2563eb)', fontFamily: 'monospace',
}
