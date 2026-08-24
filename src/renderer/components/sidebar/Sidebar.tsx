import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { useAgentStore } from '../../stores/agent-store'
import { useMachineStore } from '../../stores/machine-store'
import { useBookmarkStore } from '../../stores/bookmark-store'
import { useLayoutStore } from '../../stores/layout-store'
import { onSessionRename, emitSessionRename, onSessionCreated, onSessionActivity } from '../../services/session-events'
import { bumpSessionActivity } from './sessionActivity'
import { serializeConversationToMarkdown, suggestedExportFilename } from '../../services/exportMarkdown'
import { SidebarFilter } from './SidebarFilter'
import { decideDragOutcome } from './dragLogic'
import { WorkspaceManager } from './WorkspaceManager'
import { PromptModal } from './PromptModal'
import { MachineLayer, ComposeSpinner } from './MachineLayer'
import { AddMachineModal } from './AddMachineModal'
import { ProjectFavicon } from './ProjectFavicon'
import { NativeSessionImportModal } from './NativeSessionImportModal'
import {
  groupProjectsByWorkspace,
  applySidebarFilter,
  colorTokenForWorkspace,
  formatRelativeTime,
  type WorkspaceGroup,
} from './sidebar-helpers'
import type { Workspace } from '@shared/types'
import {
  moveProjectToWorkspace,
  projectOrganizationItems,
  reorderWorkspacesById,
} from '@shared/workspaceOrganization'
import type { Machine } from '@shared/machines'
import { UnreadBadge, GroupUnreadBadge } from './UnreadBadge'
import { RecentSessionsSection } from './RecentSessionsSection'
import { deriveRecentSessions, type RecentLiveSession } from './recentSessions'
import {
  DEFAULT_RECENT_SESSION_LIMIT,
  RECENT_SESSION_LIMIT_CHANGED,
  RECENT_SESSION_LIMIT_SETTING,
  parseRecentSessionLimit,
  type RecentSessionLimit,
} from './recentSessionLimit'

import type { Project, SessionSummary, Bookmark, ChatMessage } from '@shared/types'

interface SidebarProps {
  onSessionSelect?: (session: SessionSummary, projectPath: string, machineId?: string) => void
  onOpenBeside?: (session: SessionSummary, projectPath: string, machineId?: string) => void
  onNewChat?: (projectPath: string, machineId?: string) => void
  /** True while a New Chat create is in flight for that project + machine. */
  isNewChatPending?: (projectPath: string, machineId?: string) => boolean
}

// ── Sortable project wrapper ─────────────────────────────────────

function SortableProject({
  id,
  children,
}: {
  id: string
  children: (props: { isDragging: boolean; dragHandleProps: Record<string, unknown> }) => React.ReactNode
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id })

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.7 : 1,
        position: 'relative',
        zIndex: isDragging ? 10 : undefined,
      }}
    >
      {children({ isDragging, dragHandleProps: { ...attributes, ...listeners } })}
    </div>
  )
}

// ── Main Sidebar ─────────────────────────────────────────────────

export function Sidebar({ onSessionSelect, onOpenBeside, onNewChat, isNewChatPending }: SidebarProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [scanning, setScanning] = useState<string | null>(null)
  const [importProject, setImportProject] = useState<Project | null>(null)
  const [importCandidates, setImportCandidates] = useState<SessionSummary[]>([])
  const [importingId, setImportingId] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [renamingProjectPath, setRenamingProjectPath] = useState<string | null>(null)
  // Remote session rename uses a modal (MachineLayer rows have no inline-edit anchor).
  const [remoteRename, setRemoteRename] = useState<{ machineId: string; session: SessionSummary } | null>(null)
  const [editValue, setEditValue] = useState('')
  const [filterQuery, setFilterQuery] = useState('')
  const [managerOpen, setManagerOpen] = useState(false)
  const [managerStartsCreating, setManagerStartsCreating] = useState(false)
  const [managerWorkspaceId, setManagerWorkspaceId] = useState<string | null | undefined>(undefined)
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [addMachineOpen, setAddMachineOpen] = useState(false)
  const [editMachine, setEditMachine] = useState<Machine | null>(null)
  const [sidebarView, setSidebarView] = useState<'threads' | 'saved'>('threads')
  const editRef = useRef<HTMLInputElement>(null)
  const createTriggerRef = useRef<HTMLButtonElement>(null)
  const activeSessionId = useLayoutStore((s) =>
    s.focusedChatSlot === 'secondary' && s.secondarySessionId
      ? s.secondarySessionId
      : s.primarySessionId,
  )
  const primarySessionId = useLayoutStore((s) => s.primarySessionId)
  const secondarySessionId = useLayoutStore((s) => s.secondarySessionId)
  const displayedSessionIds = [primarySessionId, secondarySessionId]
  const machineProjects = useMachineStore((s) => s.projects)
  const [recentLimit, setRecentLimit] = useState<RecentSessionLimit>(DEFAULT_RECENT_SESSION_LIMIT)
  const [recentLiveSessions, setRecentLiveSessions] = useState<RecentLiveSession[]>(() =>
    useAgentStore.getState().sessions.map(({ id, machineId, status, messages, unreadCount }) => ({
      id,
      machineId,
      status,
      messages,
      unreadCount,
    })),
  )
  const recentSignalRef = useRef('')

  // Agent sessions change identity on every streamed token. Subscribe outside
  // React and update the sidebar only when recents-relevant state changes, so
  // a streaming answer never re-renders the whole machine/workspace tree.
  useEffect(() => useAgentStore.subscribe((state) => {
    const next = state.sessions.map(({ id, machineId, status, messages, unreadCount }) => ({
      id,
      machineId,
      status,
      messages,
      unreadCount,
    }))
    const signal = next.map((session) => {
      const pendingApproval = session.messages.some((message) => message.approval?.status === 'pending')
      const pendingQuestion = session.messages.some((message) => message.question?.status === 'pending')
      return `${session.machineId ?? 'local'}:${session.id}:${session.status}:${pendingApproval ? 1 : 0}:${pendingQuestion ? 1 : 0}:${session.unreadCount ?? 0}`
    }).join('|')
    if (signal === recentSignalRef.current) return
    recentSignalRef.current = signal
    setRecentLiveSessions(next)
  }), [])

  useEffect(() => {
    void window.api.settings.get(RECENT_SESSION_LIMIT_SETTING).then((value) => {
      setRecentLimit(parseRecentSessionLimit(value))
    })
    const onChanged = (event: Event) => {
      setRecentLimit((event as CustomEvent<RecentSessionLimit>).detail)
    }
    window.addEventListener(RECENT_SESSION_LIMIT_CHANGED, onChanged)
    return () => window.removeEventListener(RECENT_SESSION_LIMIT_CHANGED, onChanged)
  }, [])

  // Persisted collapse state - single source of truth lives in layout-store
  // so it survives reload (and the SidebarFilter's auto-expand only touches
  // the local view, never the persisted truth).
  const collapsedProjects = useLayoutStore((s) => s.sidebarCollapsedProjects)
  const collapsedWorkspaces = useLayoutStore((s) => s.sidebarCollapsedWorkspaces)
  const toggleSidebarProject = useLayoutStore((s) => s.toggleSidebarProject)
  const toggleSidebarWorkspace = useLayoutStore((s) => s.toggleSidebarWorkspace)
  const setSidebarCollapsedProjects = useLayoutStore((s) => s.setSidebarCollapsedProjects)
  const expandSidebarProject = useLayoutStore((s) => s.expandSidebarProject)
  const expandSidebarWorkspace = useLayoutStore((s) => s.expandSidebarWorkspace)
  const bookmarks = useBookmarkStore((s) => s.bookmarks)
  const removeBookmark = useBookmarkStore((s) => s.remove)

  // Right-click context menus (sessions and workspaces share the same menu shell).
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    sessionId: string
    projectPath: string
    session: SessionSummary
  } | null>(null)
  const [projectMenu, setProjectMenu] = useState<{
    x: number
    y: number
    project: Project
  } | null>(null)
  const [workspaceMenu, setWorkspaceMenu] = useState<{
    x: number
    y: number
    workspace: Workspace
  } | null>(null)
  // Remote (MachineLayer) session rows - actions route to the machine and
  // mutate the snapshot, not `projects`.
  const [remoteMenu, setRemoteMenu] = useState<{
    x: number
    y: number
    machineId: string
    projectPath: string
    session: SessionSummary
  } | null>(null)
  const [mergePickerFor, setMergePickerFor] = useState<{
    sessionId: string
    projectPath: string
    session: SessionSummary
  } | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  useEffect(() => {
    if (!createMenuOpen) return
    const close = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('.sidebar-create-wrap')) setCreateMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setCreateMenuOpen(false)
        createTriggerRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [createMenuOpen])

  useEffect(() => {
    if (!createMenuOpen) return
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('.sidebar-create-menu [role="menuitem"]')?.focus()
    })
  }, [createMenuOpen])

  const refreshWorkspaces = useCallback(() => {
    window.api.app.workspaces.list().then((list) => setWorkspaces(list ?? [])).catch(() => {})
  }, [])

  const loadProjects = useCallback(async (firstRun = false): Promise<void> => {
    const saved: Project[] = await window.api.app.getProjects()
    if (firstRun && useLayoutStore.getState().sidebarCollapsedProjects.length === 0) {
      setSidebarCollapsedProjects(saved.map((p) => p.path))
    }
    setProjects(saved)
  }, [setSidebarCollapsedProjects])

  useEffect(() => {
    refreshWorkspaces()
    void loadProjects(true)
  }, [refreshWorkspaces, loadProjects])

  const handleAddProject = useCallback(async () => {
    const project = await window.api.app.openFolder()
    if (!project) return
    setProjects((prev) => {
      if (prev.find((p) => p.path === project.path)) return prev
      return [...prev, project]
    })
  }, [])

  const handleScan = useCallback(async (projectPath: string) => {
    setScanning(projectPath)
    try {
      const sessions = await window.api.app.scanSessions(projectPath)
      const project = projects.find((item) => item.path === projectPath)
      if (project) setImportProject(project)
      setImportCandidates(sessions)
      setImportError(null)
    } finally {
      setScanning(null)
    }
  }, [projects])

  const handleImportNative = useCallback(async (session: SessionSummary) => {
    if (!importProject
      || (session.source !== 'claude-code' && session.source !== 'codex' && session.source !== 'cursor')) return
    setImportingId(session.id)
    setImportError(null)
    try {
      const result = await window.api.app.importSession(importProject.path, session.id, session.source)
      if (!result?.ok) {
        setImportError(result?.error ?? 'Import failed')
        return
      }
      await loadProjects()
      setImportCandidates((current) => current.filter((item) => item.id !== session.id))
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Import failed')
    } finally {
      setImportingId(null)
    }
  }, [importProject, loadProjects])

  const toggleCollapse = useCallback((path: string) => {
    toggleSidebarProject(path)
  }, [toggleSidebarProject])

  const startRename = useCallback((session: SessionSummary) => {
    setRenamingProjectPath(null)
    setEditingId(session.id)
    setEditValue(session.title)
    setTimeout(() => editRef.current?.select(), 0)
  }, [])

  const cancelRename = useCallback(() => {
    setEditingId(null)
  }, [])

  const commitRename = useCallback((projectPath: string, sessionId: string) => {
    const newTitle = editValue.trim()
    if (!newTitle) { setEditingId(null); return }
    setProjects((prev) =>
      prev.map((p) => {
        if (p.path !== projectPath) return p
        return {
          ...p,
          sessions: p.sessions.map((s) =>
            s.id === sessionId ? { ...s, title: newTitle } : s
          ),
        }
      })
    )
    window.api.app.renameConversation(sessionId, newTitle).catch(() => {})
    emitSessionRename(sessionId, newTitle)
    setEditingId(null)
  }, [editValue])

  // Listen for renames from other places (ChatPanel) and update local projects state
  useEffect(() => {
    return onSessionRename((sid, title) => {
      setProjects((prev) =>
        prev.map((p) => ({
          ...p,
          sessions: p.sessions.map((s) =>
            s.id === sid ? { ...s, title } : s
          ),
        }))
      )
    })
  }, [])

  // Live activity: a sent message bumps its chat to the top with "now"
  // without waiting for a reload (the DB updated_at is already maintained).
  useEffect(() => {
    return onSessionActivity((sid, ts) => {
      setProjects((prev) => bumpSessionActivity(prev, sid, ts))
    })
  }, [])

  // Refresh project list from disk (e.g., after unarchive)
  useEffect(() => {
    const handler = () => void loadProjects().catch(() => {})
    window.addEventListener('sidebar-refresh', handler)
    // onSessionCreated is renderer-local, so another client's chat needs this.
    const off = window.api.app.onConversationsChanged(handler)
    return () => {
      window.removeEventListener('sidebar-refresh', handler)
      off()
    }
  }, [loadProjects])

  // Listen for newly-created sessions from ChatPanel (e.g. "+ New Chat")
  useEffect(() => {
    return onSessionCreated((newSession) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.path !== newSession.projectPath) return p
          // Skip if already present
          if (p.sessions.find((s) => s.id === newSession.id)) return p
          return {
            ...p,
            sessions: [
              {
                id: newSession.id,
                source: newSession.source,
                title: newSession.title,
                startedAt: newSession.startedAt,
                messageCount: 0,
                filePath: '',
              },
              ...p.sessions,
            ],
          }
        })
      )
      // Auto-expand the project so the user sees the new chat
      expandSidebarProject(newSession.projectPath)
    })
  }, [expandSidebarProject])

  const handleExport = useCallback(async (session: SessionSummary, projectPath: string) => {
    // Use the most up-to-date messages from agent-store if the session is
    // already loaded. Otherwise, load from disk first so exports of
    // never-opened sessions still work.
    let messages = useAgentStore.getState().sessions.find((s) => s.id === session.id)?.messages
    if (!messages || messages.length === 0) {
      try {
        if (session.filePath) {
          const source = session.source === 'codex' ? 'codex' : 'claude-code'
          messages = await window.api.app.loadSession(session.filePath, session.id, source)
        } else {
          // No filePath means a db-only row, which is what every worktree-run
          // chat is. Exporting those wrote an empty file with the transcript
          // sitting on disk unread; loadSessionById finds it by session id.
          const resp = await window.api.app.loadSessionById(session.id) as { messages?: ChatMessage[] } | null
          messages = resp?.messages ?? []
        }
      } catch { /* best-effort - export whatever we have */ }
    }
    const content = serializeConversationToMarkdown({
      title: session.title ?? 'Conversation',
      projectPath,
      startedAt: session.startedAt,
      messages: messages ?? [],
      agentType: session.source === 'codex' ? 'codex' : 'claude-code',
    })
    await window.api.app.exportMarkdown({
      suggestedFilename: suggestedExportFilename(session.title ?? 'conversation'),
      content,
    })
  }, [])

  const handleMerge = useCallback(async (
    fragment: { sessionId: string; projectPath: string; session: SessionSummary },
    rootThreadId: string,
  ) => {
    try {
      await window.api.app.attachToThread(fragment.sessionId, rootThreadId)
      // Optimistic UI: remove the fragment from its project list in the sidebar
      setProjects((prev) =>
        prev.map((p) =>
          p.path !== fragment.projectPath
            ? p
            : { ...p, sessions: p.sessions.filter((s) => s.id !== fragment.sessionId) }
        )
      )
    } catch {
      // best-effort - next getProjects refresh will correct state
    }
  }, [])

  const handleArchive = useCallback((projectPath: string, session: SessionSummary) => {
    // Optimistically remove from sidebar
    setProjects((prev) =>
      prev.map((p) =>
        p.path !== projectPath
          ? p
          : { ...p, sessions: p.sessions.filter((s) => s.id !== session.id) }
      )
    )
    ;window.api.app.archiveConversation(session.id, projectPath, session.title).catch(() => {
      // Rollback on error
      setProjects((prev) =>
        prev.map((p) =>
          p.path !== projectPath
            ? p
            : { ...p, sessions: [...p.sessions, session].sort((a, b) => b.startedAt - a.startedAt) }
        )
      )
    })
  }, [])

  // Remote-session menu actions bind the session id to its machine first -
  // an unbound id silently routes local.
  const commitRemoteRename = useCallback((menu: { machineId: string; session: SessionSummary }, title: string) => {
    if (title === menu.session.title) return
    window.api.routing.bind(menu.session.id, menu.machineId)
    window.api.app.renameConversation(menu.session.id, title).catch(() => {
      // best-effort - next sync restores the real title
    })
    emitSessionRename(menu.session.id, title)
  }, [])

  const handleRemoteExport = useCallback(async (menu: { machineId: string; projectPath: string; session: SessionSummary }) => {
    let messages = useAgentStore.getState().sessions.find((s) => s.id === menu.session.id)?.messages
    if (!messages || messages.length === 0) {
      try {
        // Remote rows carry no filePath - load by id, routed to the machine.
        window.api.routing.bind(menu.session.id, menu.machineId)
        const resp = await window.api.app.loadSessionById(menu.session.id) as { messages?: ChatMessage[] }
        messages = resp?.messages
      } catch { /* best-effort - export whatever we have */ }
    }
    const content = serializeConversationToMarkdown({
      title: menu.session.title ?? 'Conversation',
      projectPath: menu.projectPath,
      startedAt: menu.session.startedAt,
      messages: messages ?? [],
      agentType: menu.session.source === 'codex' ? 'codex' : 'claude-code',
    })
    await window.api.app.exportMarkdown({
      suggestedFilename: suggestedExportFilename(menu.session.title ?? 'conversation'),
      content,
    })
  }, [])

  const handleRemoteArchive = useCallback((menu: { machineId: string; projectPath: string; session: SessionSummary }) => {
    window.api.routing.bind(menu.session.id, menu.machineId)
    // Optimistic: drop from the snapshot; roll back if the routed archive fails.
    useMachineStore.getState().removeSnapshotSession(menu.machineId, menu.session.id)
    window.api.app.archiveConversation(menu.session.id, menu.projectPath, menu.session.title).catch(() => {
      useMachineStore.getState().addSnapshotSession(menu.machineId, menu.projectPath, {
        id: menu.session.id,
        title: menu.session.title,
        agentType: menu.session.agentType ?? null,
      })
    })
  }, [])

  const handleAssignWorkspace = useCallback((projectPath: string, workspaceId: string | null) => {
    setProjects((prev) => {
      const next = moveProjectToWorkspace(prev, projectPath, workspaceId)
      void window.api.app.organizeProjects(projectOrganizationItems(next))
        .catch(() => { void loadProjects() })
      return next
    })
  }, [loadProjects])

  // Inline edit, not window.prompt - Electron renderers don't implement
  // prompt() (returns null), so the prompt version silently did nothing.
  const handleRenameProject = useCallback((project: { path: string; name: string }) => {
    setEditingId(null)
    setRenamingProjectPath(project.path)
    setEditValue(project.name)
    setTimeout(() => editRef.current?.select(), 0)
  }, [])

  const commitProjectRename = useCallback((projectPath: string) => {
    const name = editValue.trim()
    setRenamingProjectPath(null)
    if (!name) return
    setProjects((prev) => prev.map((p) => p.path === projectPath ? { ...p, name } : p))
    window.api.app.renameProject(projectPath, name).catch(() => {
      // optimistic - next refresh will correct
    })
  }, [editValue])

  const handleRemoveProject = useCallback(async (project: { path: string; name: string }) => {
    if (!window.confirm(`Remove "${project.name}"? This also deletes its conversations and kanban cards from Switchboard (the folder on disk is untouched).`)) return
    setProjects((prev) => prev.filter((p) => p.path !== project.path))
    // Tear down any open sessions rooted in this project before the cascade
    // delete lands - otherwise activeSessionId points at a conversation row
    // that no longer exists and the next turn writes against a dead FK parent.
    const { sessions, removeSession } = useAgentStore.getState()
    for (const s of sessions.filter((s) => s.projectPath === project.path)) removeSession(s.id)
    try {
      await window.api.app.removeProject(project.path)
    } catch { /* best-effort - next refresh will restore if it failed */ }
  }, [])

  const handleCreateWorkspaceFromProject = useCallback(async (projectPath: string) => {
    // Default the workspace name to the project's folder name (no window.prompt
    // - Electron no-ops it). Rename later via Manage workspaces.
    const name = projectPath.split('/').filter(Boolean).pop() || 'New workspace'
    try {
      const w = await window.api.app.workspaces.create({ name })
      setWorkspaces((prev) => [...prev, w])
      await handleAssignWorkspace(projectPath, w.id)
    } catch { /* best-effort */ }
  }, [handleAssignWorkspace])

  // Drives both same- and cross-workspace drops off the *rendered* flat
  // order (what SortableContext.items sees), not the raw `projects` array
  // - dnd-kit's drag indices are relative to that. Cross-workspace drops
  // also flip the dragged item's workspaceId so it lands in the target
  // bucket at the visual drop slot.
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const renderedOrder = groupProjectsByWorkspace(projects, workspaces)
      .flatMap((g) => g.projects.map((p) => p.path))
    const outcome = decideDragOutcome(
      projects,
      renderedOrder,
      String(active.id),
      String(over.id),
    )
    if (outcome.type === 'noop') return

    const newRenderedOrder = arrayMove(renderedOrder, outcome.oldIndex, outcome.newIndex)

    setProjects((prev) => {
      const byPath = new Map(prev.map((p) => [p.path, p]))
      const reordered = newRenderedOrder
        .map((path) => byPath.get(path))
        .filter((project): project is Project => project !== undefined)
        .map((p) =>
          outcome.type === 'reassign' && p.path === outcome.projectPath
            ? { ...p, workspaceId: outcome.targetWorkspaceId }
            : p,
        )
      void window.api.app.organizeProjects(projectOrganizationItems(reordered))
        .catch(() => { void loadProjects() })
      return reordered
    })
  }, [loadProjects, projects, workspaces])

  // Compute the workspace-grouped tree, then apply the (debounced) filter.
  // The filter expansion sets are merged with the persisted collapse sets:
  // when filtering, matching ancestors auto-expand without clobbering the
  // user's saved collapse state \u2014 clearing the filter restores it.
  const groups: WorkspaceGroup[] = useMemo(
    () => groupProjectsByWorkspace(projects, workspaces),
    [projects, workspaces]
  )
  const filtered = useMemo(() => applySidebarFilter(filterQuery, groups), [filterQuery, groups])
  const recentSessions = useMemo(() => deriveRecentSessions({
    localProjects: projects,
    remoteProjects: machineProjects,
    liveSessions: recentLiveSessions,
  }), [projects, machineProjects, recentLiveSessions])
  const isFiltering = filterQuery.trim().length > 0
  const isProjectCollapsed = (path: string) => {
    if (isFiltering && filtered.expandProjects.has(path)) return false
    return collapsedProjects.includes(path)
  }
  const isWorkspaceCollapsed = (id: string) => {
    if (isFiltering && filtered.expandWorkspaces.has(id)) return false
    return collapsedWorkspaces.includes(id)
  }
  const ungroupedKey = '__ungrouped__'

  const renderProject = (
    project: Project,
    isDragging: boolean,
    dragHandleProps: Record<string, unknown>,
  ) => {
    const isCollapsed = isProjectCollapsed(project.path)
    const composePending = isNewChatPending?.(project.path) ?? false
    return (
      <div className="sidebar-project">
        <div
          className="sidebar-project-header"
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setProjectMenu({ x: e.clientX, y: e.clientY, project })
          }}
        >
          <span
            {...dragHandleProps}
            className="sidebar-drag-handle"
            style={{
              cursor: 'grab',
              display: 'flex',
              alignItems: 'center',
              padding: '0 2px',
              color: 'var(--text-muted)',
              opacity: 0,
              transition: 'opacity 0.12s',
            }}
            title="Drag to reorder"
          >
            <svg width="8" height="12" viewBox="0 0 8 12" fill="currentColor">
              <circle cx="2" cy="2" r="1.2" />
              <circle cx="6" cy="2" r="1.2" />
              <circle cx="2" cy="6" r="1.2" />
              <circle cx="6" cy="6" r="1.2" />
              <circle cx="2" cy="10" r="1.2" />
              <circle cx="6" cy="10" r="1.2" />
            </svg>
          </span>
          {renamingProjectPath === project.path ? (
            <>
              <button
                type="button"
                className="sidebar-project-toggle sidebar-project-toggle-compact"
                onClick={() => !isDragging && toggleCollapse(project.path)}
                aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${project.name}`}
                aria-expanded={!isCollapsed}
              >
                <span className="sidebar-chevron">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
                <ProjectFavicon projectPath={project.path} />
              </button>
              <input
                ref={editRef}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitProjectRename(project.path)
                  if (e.key === 'Escape') setRenamingProjectPath(null)
                }}
                onBlur={() => commitProjectRename(project.path)}
                className="sidebar-rename-input"
              />
            </>
          ) : (
            <button
              type="button"
              className="sidebar-project-toggle"
              onClick={() => !isDragging && toggleCollapse(project.path)}
              aria-expanded={!isCollapsed}
            >
              <span className="sidebar-chevron">{isCollapsed ? '\u25B6' : '\u25BC'}</span>
              <ProjectFavicon projectPath={project.path} />
              <span className="sidebar-project-name">{project.name}</span>
              <GroupUnreadBadge
                sessionIds={project.sessions.map((s) => s.id)}
                expanded={!isCollapsed}
              />
              <span className="sidebar-project-count">{project.sessions.length || ''}</span>
            </button>
          )}
          <button
            type="button"
            className="sidebar-project-compose"
            disabled={composePending}
            // Hover-revealed button: keep it visible while pending so the
            // spinner shows even after the pointer leaves the header.
            style={composePending ? { opacity: 1 } : undefined}
            onClick={(e) => {
              e.stopPropagation()
              onNewChat?.(project.path)
            }}
            title="New thread in this project"
          >
            {composePending ? (
              <ComposeSpinner />
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            )}
          </button>
        </div>

        {!isCollapsed && (
          <div className="sidebar-threads">
            {project.sessions.length > 0 ? (
              project.sessions.map((s) => {
                const isActive = activeSessionId === s.id
                const isDisplayed = displayedSessionIds.includes(s.id)
                return (
                  <div
                    key={s.id}
                    className={`sidebar-thread ${isActive ? 'sidebar-thread-active' : ''} ${isDisplayed ? 'sidebar-thread-displayed' : ''}`}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setContextMenu({
                        x: e.clientX,
                        y: e.clientY,
                        sessionId: s.id,
                        projectPath: project.path,
                        session: s,
                      })
                    }}
                  >
                    {editingId === s.id ? (
                      <div className="sidebar-rename-row">
                        <input
                          ref={editRef}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename(project.path, s.id)
                            if (e.key === 'Escape') cancelRename()
                          }}
                          onBlur={() => commitRename(project.path, s.id)}
                          onClick={(e) => e.stopPropagation()}
                          className="sidebar-rename-input"
                        />
                        <button
                          className="sidebar-rename-cancel"
                          onMouseDown={(e) => {
                            e.preventDefault()
                            cancelRename()
                          }}
                          title="Cancel (Esc)"
                        >
                          &times;
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="sidebar-thread-main"
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => onSessionSelect?.(s, project.path)}
                        >
                          <span className="sidebar-thread-title">
                            {s.title}
                          </span>
                          {s.worktreeRecovery?.cleanupDisposition === 'retained' && (
                            <span
                              title="This worktree was retained and needs recovery before the conversation can start."
                              style={{ color: 'var(--warning)', fontSize: 10, flex: '0 0 auto' }}
                            >
                              Recovery
                            </span>
                          )}
                          <UnreadBadge sessionId={s.id} />
                          <span className="sidebar-thread-time">
                            {formatRelativeTime(s.startedAt)}
                          </span>
                        </button>
                        <button
                          className="sidebar-thread-archive"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleArchive(project.path, s)
                          }}
                          title="Archive"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="4" rx="1" />
                            <path d="M5 7v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7" />
                            <line x1="10" y1="12" x2="14" y2="12" />
                          </svg>
                        </button>
                      </>
                    )}
                  </div>
                )
              })
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); handleScan(project.path) }}
                disabled={scanning === project.path}
                className="sidebar-scan-btn"
              >
                {scanning === project.path ? 'Scanning\u2026' : 'Import conversations'}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  // The header button always targets projects[0], so it mirrors that
  // project's pending state.
  const headerComposePending = projects[0]
    ? isNewChatPending?.(projects[0].path) ?? false
    : false

  const openSavedBookmark = (bookmark: Bookmark) => {
    const syntheticSession: SessionSummary = {
      id: bookmark.sessionId,
      source: (bookmark.agentType === 'codex' ? 'codex' : 'claude-code') as SessionSummary['source'],
      title: bookmark.sessionTitle,
      startedAt: bookmark.savedAt,
      messageCount: 0,
      filePath: '',
    }
    onSessionSelect?.(syntheticSession, bookmark.projectPath)
    useAgentStore.getState().requestScrollToTimestamp(
      bookmark.sessionId,
      bookmark.messageTimestamp,
    )
  }

  return (
    <div className="sidebar-root">
      {/* Header */}
      <div className="sidebar-header">
        {sidebarView === 'saved' ? (
          <div className="sidebar-saved-header">
            <button
              type="button"
              className="sidebar-header-icon"
              aria-label="Back to threads"
              title="Back to threads"
              onClick={() => setSidebarView('threads')}
            >
              <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span className="sidebar-header-label">Saved</span>
            <span className="sidebar-saved-count">{bookmarks.length}</span>
          </div>
        ) : (
          <>
            <span className="sidebar-header-label">THREADS</span>
            <div className="sidebar-header-actions">
              <button
                type="button"
                className="sidebar-header-icon"
                aria-label="Open saved messages"
                title="Saved messages"
                onClick={() => setSidebarView('saved')}
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                </svg>
              </button>
              <button
                type="button"
                className="sidebar-new-btn"
                onClick={() => {
                  const project = projects[0]
                  if (project) onNewChat?.(project.path)
                }}
                disabled={projects.length === 0 || headerComposePending}
                title="New thread"
              >
                {headerComposePending ? (
                  <ComposeSpinner />
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                  </svg>
                )}
              </button>
            </div>
          </>
        )}
      </div>

      {sidebarView === 'saved' && (
        <div className="sidebar-list sidebar-saved-list">
          {bookmarks.length === 0 ? (
            <div className="sidebar-saved-empty">
              <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
              </svg>
              <strong>No saved messages</strong>
              <span>Save a message to find it here.</span>
            </div>
          ) : bookmarks.map((bookmark) => (
            <SavedItem
              key={bookmark.id}
              bookmark={bookmark}
              onNavigate={() => openSavedBookmark(bookmark)}
              onRemove={() => void removeBookmark(bookmark.id)}
            />
          ))}
        </div>
      )}
      {/* Filter input \u2014 debounced 100ms, fuzzy substring on session titles */}
      {sidebarView === 'threads' && projects.length > 0 && (
        <SidebarFilter onChange={setFilterQuery} />
      )}

      {/* Project + thread list */}
      {sidebarView === 'threads' && (
      <div className="sidebar-list">
        {!isFiltering && (
          <RecentSessionsSection
            items={recentSessions}
            initialLimit={recentLimit}
            activeSessionId={activeSessionId}
            displayedSessionIds={displayedSessionIds}
            onSelect={(item) => onSessionSelect?.(
              item.session,
              item.projectPath,
              item.machineId === 'local' ? undefined : item.machineId,
            )}
          />
        )}
        <MachineLayer
          onEditMachine={(machine) => setEditMachine(machine)}
          onOpenRemoteSession={(machineId, projectPath, session) => onSessionSelect?.(session, projectPath, machineId)}
          onNewRemoteChat={(machineId, projectPath) => onNewChat?.(projectPath, machineId)}
          isNewChatPending={isNewChatPending}
          onSessionContextMenu={(e, machineId, projectPath, session) =>
            setRemoteMenu({ x: e.clientX, y: e.clientY, machineId, projectPath, session })}
        >
        <DndContext
          sensors={sensors}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          {/* Items must match rendered DOM order (grouped by workspace), not raw load order. */}
          <SortableContext
            items={filtered.groups.flatMap((g) => g.projects.map((p) => p.path))}
            strategy={verticalListSortingStrategy}
          >
            {filtered.groups.map((group) => {
              const workspace = group.workspace
              const wsId = workspace?.id ?? ungroupedKey
              const wsCollapsed = isWorkspaceCollapsed(wsId)
              const sessionTotal = group.projects.reduce((acc, p) => acc + p.sessions.length, 0)
              const spineColor = workspace ? colorTokenForWorkspace(workspace) : 'var(--text-muted)'
              return (
                <section
                  key={wsId}
                  className={`sidebar-workspace ${wsCollapsed ? 'collapsed' : ''} ${workspace ? '' : 'ungrouped'}`}
                  style={{ ['--spine' as string]: spineColor } as React.CSSProperties}
                >
                  <div className="sidebar-workspace-header-row">
                    <button
                      type="button"
                      className="sidebar-workspace-header"
                      onClick={() => toggleSidebarWorkspace(wsId)}
                      aria-expanded={!wsCollapsed}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        if (workspace) {
                          setWorkspaceMenu({
                            x: event.clientX,
                            y: event.clientY,
                            workspace,
                          })
                        }
                      }}
                    >
                      <span className="sidebar-chevron">{wsCollapsed ? '\u25B6' : '\u25BC'}</span>
                      <span className="sidebar-workspace-name">
                        {workspace?.name ?? 'Ungrouped'}
                      </span>
                      <GroupUnreadBadge
                        sessionIds={group.projects.flatMap((p) => p.sessions.map((s) => s.id))}
                        expanded={!wsCollapsed}
                      />
                      <span
                        className="sidebar-workspace-count"
                        title={`${group.projects.length} project${group.projects.length === 1 ? '' : 's'}, ${sessionTotal} thread${sessionTotal === 1 ? '' : 's'}`}
                      >
                        {group.projects.length}{'\u00B7'}{sessionTotal}
                      </span>
                    </button>
                    {workspace && (
                      <button
                        type="button"
                        className="sidebar-workspace-actions"
                        aria-label={`Actions for ${workspace.name}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          const rect = event.currentTarget.getBoundingClientRect()
                          setWorkspaceMenu({
                            x: rect.right,
                            y: rect.bottom,
                            workspace,
                          })
                        }}
                      >
                        <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="5" cy="12" r="1.6" />
                          <circle cx="12" cy="12" r="1.6" />
                          <circle cx="19" cy="12" r="1.6" />
                        </svg>
                      </button>
                    )}
                  </div>
                  {!wsCollapsed && (
                    <div className="sidebar-workspace-body">
                      {group.projects.map((project) => (
                        <SortableProject key={project.path} id={project.path}>
                          {({ isDragging, dragHandleProps }) =>
                            renderProject(project, isDragging, dragHandleProps)
                          }
                        </SortableProject>
                      ))}
                    </div>
                  )}
                </section>
              )
            })}
            {isFiltering && filtered.matchCount === 0 && (
              <div className="sidebar-empty" style={{ padding: '14px', textAlign: 'center' }}>
                No matches for "{filterQuery}"
              </div>
            )}
          </SortableContext>
        </DndContext>
        </MachineLayer>


        {projects.length === 0 && (
          <div className="sidebar-empty-state">
            <div className="sidebar-empty-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.4">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>Add a project folder</div>
            <div style={{ fontSize: '11px', marginTop: '2px' }}>to see threads</div>
          </div>
        )}
      </div>
      )}

      {/* Footer */}
      {sidebarView === 'threads' && (
      <div className="sidebar-footer">
        <div className="sidebar-create-wrap">
          <button
            ref={createTriggerRef}
            type="button"
            className="sidebar-create-trigger"
            aria-haspopup="menu"
            aria-expanded={createMenuOpen}
            onClick={() => setCreateMenuOpen((open) => !open)}
          >
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
            Create
            <svg aria-hidden="true" className="sidebar-create-caret" width="10" height="10" viewBox="0 0 20 20" fill="currentColor">
              <path d="m5 7.5 5 5 5-5Z" />
            </svg>
          </button>
          {createMenuOpen && (
            <div
              className="sidebar-create-menu sb-floating-surface"
              role="menu"
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
                const current = items.indexOf(document.activeElement as HTMLButtonElement)
                const delta = event.key === 'ArrowDown' ? 1 : -1
                items[(current + delta + items.length) % items.length]?.focus()
              }}
            >
              <button type="button" role="menuitem" onClick={() => {
                setCreateMenuOpen(false)
                void handleAddProject()
              }}>
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                  <path d="M12 10v6M9 13h6" />
                </svg>
                <span><strong>New project</strong><small>Add a folder from this Mac</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => {
                setCreateMenuOpen(false)
                setManagerWorkspaceId(undefined)
                setManagerStartsCreating(true)
                setManagerOpen(true)
              }}>
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M4 6h16M4 12h16M4 18h10" />
                </svg>
                <span><strong>New workspace</strong><small>Group related projects</small></span>
              </button>
              <button type="button" role="menuitem" onClick={() => {
                setCreateMenuOpen(false)
                setAddMachineOpen(true)
              }}>
                <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="4" width="18" height="6" rx="1" />
                  <rect x="3" y="14" width="18" height="6" rx="1" />
                  <path d="M7 7h.01M7 17h.01" />
                </svg>
                <span><strong>New machine</strong><small>Connect over SSH or IAP</small></span>
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setManagerWorkspaceId(undefined)
            setManagerStartsCreating(false)
            setManagerOpen(true)
          }}
          className="sidebar-organize-btn"
          aria-label="Organize workspaces and projects"
          title="Organize sidebar"
        >
          <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
            <circle cx="9" cy="6" r="1.7" fill="var(--bg-elevated)" />
            <circle cx="15" cy="12" r="1.7" fill="var(--bg-elevated)" />
            <circle cx="11" cy="18" r="1.7" fill="var(--bg-elevated)" />
          </svg>
        </button>
      </div>
      )}

      {/* Right-click context menu on sessions */}
      {contextMenu && (
        <SidebarContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
            {
              label: 'Open beside',
              onClick: () => {
                onOpenBeside?.(contextMenu.session, contextMenu.projectPath)
                setContextMenu(null)
              },
            },
            {
              label: 'Rename',
              onClick: () => { startRename(contextMenu.session); setContextMenu(null) },
            },
            {
              label: 'Export as Markdown',
              onClick: () => {
                void handleExport(contextMenu.session, contextMenu.projectPath)
                setContextMenu(null)
              },
            },
            {
              label: 'Merge into another chat…',
              onClick: () => {
                setMergePickerFor(contextMenu)
                setContextMenu(null)
              },
            },
            {
              label: 'Archive',
              danger: true,
              onClick: () => {
                handleArchive(contextMenu.projectPath, contextMenu.session)
                setContextMenu(null)
              },
            },
          ]}
        />
      )}

      {/* Right-click menu on remote (MachineLayer) session rows */}
      {remoteMenu && (
        <SidebarContextMenu
          x={remoteMenu.x}
          y={remoteMenu.y}
          onClose={() => setRemoteMenu(null)}
          items={[
            {
              label: 'Open beside',
              onClick: () => {
                onOpenBeside?.(remoteMenu.session, remoteMenu.projectPath, remoteMenu.machineId)
                setRemoteMenu(null)
              },
            },
            {
              label: 'Rename',
              onClick: () => { setRemoteRename({ machineId: remoteMenu.machineId, session: remoteMenu.session }); setRemoteMenu(null) },
            },
            {
              label: 'Export as Markdown',
              onClick: () => {
                void handleRemoteExport(remoteMenu)
                setRemoteMenu(null)
              },
            },
            {
              label: 'Archive',
              danger: true,
              onClick: () => {
                handleRemoteArchive(remoteMenu)
                setRemoteMenu(null)
              },
            },
          ]}
        />
      )}

      {remoteRename && (
        <PromptModal
          title="Rename chat"
          initialValue={remoteRename.session.title}
          submitLabel="Rename"
          onSubmit={(title) => { commitRemoteRename(remoteRename, title); setRemoteRename(null) }}
          onCancel={() => setRemoteRename(null)}
        />
      )}

      {workspaceMenu && (
        <SidebarContextMenu
          x={workspaceMenu.x}
          y={workspaceMenu.y}
          onClose={() => setWorkspaceMenu(null)}
          items={[
            {
              label: 'Organize workspace…',
              onClick: () => {
                setManagerWorkspaceId(workspaceMenu.workspace.id)
                setManagerStartsCreating(false)
                setManagerOpen(true)
                setWorkspaceMenu(null)
              },
            },
            ...(workspaces.findIndex((workspace) => workspace.id === workspaceMenu.workspace.id) > 0
              ? [{
                  label: 'Move workspace up',
                  onClick: () => {
                    const index = workspaces.findIndex((workspace) => workspace.id === workspaceMenu.workspace.id)
                    const next = reorderWorkspacesById(workspaces, workspaceMenu.workspace.id, workspaces[index - 1].id)
                    setWorkspaces(next)
                    void window.api.app.workspaces.reorder(next.map((workspace) => workspace.id))
                      .catch(refreshWorkspaces)
                    setWorkspaceMenu(null)
                  },
                }]
              : []),
            ...(workspaces.findIndex((workspace) => workspace.id === workspaceMenu.workspace.id) < workspaces.length - 1
              ? [{
                  label: 'Move workspace down',
                  onClick: () => {
                    const index = workspaces.findIndex((workspace) => workspace.id === workspaceMenu.workspace.id)
                    const next = reorderWorkspacesById(workspaces, workspaceMenu.workspace.id, workspaces[index + 1].id)
                    setWorkspaces(next)
                    void window.api.app.workspaces.reorder(next.map((workspace) => workspace.id))
                      .catch(refreshWorkspaces)
                    setWorkspaceMenu(null)
                  },
                }]
              : []),
          ]}
        />
      )}

      {/* Right-click on a project header - workspace assignment */}
      {projectMenu && (
        <SidebarContextMenu
          x={projectMenu.x}
          y={projectMenu.y}
          onClose={() => setProjectMenu(null)}
          items={[
            ...(workspaces.length > 0 ? workspaces.map((w) => ({
              label: `Move to: ${w.name}`,
              onClick: () => {
                void handleAssignWorkspace(projectMenu.project.path, w.id)
                setProjectMenu(null)
              },
            })) : []),
            ...(projectMenu.project.workspaceId ? [{
              label: 'Move to: Ungrouped',
              onClick: () => {
                void handleAssignWorkspace(projectMenu.project.path, null)
                setProjectMenu(null)
              },
            }] : []),
            {
              label: 'New workspace from this project…',
              onClick: () => {
                void handleCreateWorkspaceFromProject(projectMenu.project.path)
                setProjectMenu(null)
              },
            },
            {
              label: 'Manage workspaces…',
              onClick: () => {
                setManagerWorkspaceId(projectMenu.project.workspaceId ?? null)
                setManagerStartsCreating(false)
                setManagerOpen(true)
                setProjectMenu(null)
              },
            },
            {
              label: 'Import or recover conversations…',
              onClick: () => {
                void handleScan(projectMenu.project.path)
                setProjectMenu(null)
              },
            },
            {
              label: 'Rename project…',
              onClick: () => {
                void handleRenameProject(projectMenu.project)
                setProjectMenu(null)
              },
            },
            {
              label: 'Remove project',
              danger: true,
              onClick: () => {
                void handleRemoveProject(projectMenu.project)
                setProjectMenu(null)
              },
            },
          ]}
        />
      )}

      {/* Workspace manager modal - rename / recolor / delete */}
      {managerOpen && (
        <WorkspaceManager
          workspaces={workspaces}
          projects={projects}
          startCreating={managerStartsCreating}
          initialWorkspaceId={managerWorkspaceId}
          onWorkspacesChanged={setWorkspaces}
          onProjectsChanged={setProjects}
          onClose={() => {
            setManagerOpen(false)
            setManagerStartsCreating(false)
            setManagerWorkspaceId(undefined)
          }}
          onMutated={() => {
            refreshWorkspaces()
            void loadProjects().catch(() => {})
          }}
        />
      )}

      {(addMachineOpen || editMachine) && (
        <AddMachineModal
          editMachine={editMachine ?? undefined}
          onClose={() => { setAddMachineOpen(false); setEditMachine(null) }}
        />
      )}

      {/* Merge-fragment picker - lists sibling chats in the same project. */}
      {mergePickerFor && (
        <MergeIntoPicker
          fragment={mergePickerFor}
          candidates={
            projects.find((p) => p.path === mergePickerFor.projectPath)?.sessions
              .filter((s) => s.id !== mergePickerFor.sessionId) ?? []
          }
          onClose={() => setMergePickerFor(null)}
          onPick={(rootId) => {
            void handleMerge(mergePickerFor, rootId)
            setMergePickerFor(null)
          }}
        />
      )}

      {importProject && (
        <NativeSessionImportModal
          projectName={importProject.name}
          candidates={importCandidates}
          importingId={importingId}
          error={importError}
          onImport={(session) => void handleImportNative(session)}
          onClose={() => {
            if (importingId) return
            setImportProject(null)
            setImportCandidates([])
            setImportError(null)
          }}
        />
      )}
    </div>
  )
}

/**
 * Modal picker for attaching a fragmented session into another thread.
 * Lists sibling chats in the same project - picking one re-parents the
 * fragment via `app:attach-to-thread`. Keyboard-first: ↑↓/Enter/Esc.
 */
function MergeIntoPicker({
  fragment,
  candidates,
  onClose,
  onPick,
}: {
  fragment: { sessionId: string; session: SessionSummary }
  candidates: SessionSummary[]
  onClose: () => void
  onPick: (rootId: string) => void
}) {
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIdx((i) => Math.min(i + 1, candidates.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const pick = candidates[idx]
        if (pick) onPick(pick.id)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [idx, candidates, onPick, onClose])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '18vh',
      }}
    >
      <div
        className="sb-floating-surface"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(560px, 92vw)',
          maxHeight: '60vh',
          display: 'flex',
          flexDirection: 'column',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          boxShadow: '0 10px 40px rgba(0, 0, 0, 0.4)',
          overflow: 'hidden',
        }}
      >
        <div style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          fontSize: '11px',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.8px',
          fontWeight: 600,
        }}>
          Merge "{fragment.session.title}" into
        </div>
        {candidates.length === 0 ? (
          <div style={{ padding: '16px', color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center' }}>
            No sibling chats in this project yet.
          </div>
        ) : (
          <div style={{ overflowY: 'auto', padding: '4px 0' }}>
            {candidates.map((c, i) => {
              const selected = i === idx
              return (
                <button
                  key={c.id}
                  onClick={() => onPick(c.id)}
                  onMouseEnter={() => setIdx(i)}
                  style={{
                    display: 'flex',
                    width: '100%',
                    padding: '8px 14px',
                    gap: '8px',
                    alignItems: 'baseline',
                    border: 'none',
                    background: selected ? 'var(--bg-hover)' : 'transparent',
                    color: 'var(--text-primary)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: '13px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.title}
                  </span>
                  <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    {c.id.slice(0, 8)}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <div style={{
          padding: '6px 14px',
          borderTop: '1px solid var(--border)',
          fontSize: '10.5px',
          color: 'var(--text-muted)',
        }}>
          ↑↓ navigate · Enter select · Esc dismiss · merging won't delete anything (hidden child can be re-surfaced via DB)
        </div>
      </div>
    </div>
  )
}

interface ContextMenuItem {
  label: string
  onClick: () => void
  danger?: boolean
}

/**
 * Tiny positioned menu for right-click actions on a sidebar session.
 * Closes on outside click / Esc.
 */
function SidebarContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={rootRef}
      className="sb-floating-surface"
      style={{
        position: 'fixed',
        top: y,
        left: x,
        zIndex: 1200,
        minWidth: '170px',
        padding: '4px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
      }}
    >
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.onClick}
          style={{
            display: 'block',
            width: '100%',
            padding: '6px 10px',
            border: 'none',
            background: 'transparent',
            color: item.danger ? 'var(--error)' : 'var(--text-primary)',
            cursor: 'pointer',
            fontSize: '12px',
            textAlign: 'left',
            borderRadius: '3px',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

// ── Saved item row ───────────────────────────────────────────────

function SavedItem({
  bookmark,
  onNavigate,
  onRemove,
}: {
  bookmark: Bookmark
  onNavigate: () => void
  onRemove: () => void
}) {
  const isUser = bookmark.messageRole === 'user'
  return (
    <div className={`sidebar-saved-item ${isUser ? 'is-user' : 'is-agent'}`}>
      <button type="button" className="sidebar-saved-main" onClick={onNavigate}>
        <span className="sidebar-saved-meta">
          <span className="sidebar-saved-role">{isUser ? 'You' : 'Agent'}</span>
          <span className="sidebar-saved-session">{bookmark.sessionTitle}</span>
        </span>
        <span className="sidebar-saved-excerpt">{bookmark.contentExcerpt}</span>
        <span className="sidebar-saved-time">{formatRelativeTime(bookmark.savedAt)}</span>
      </button>
      <button
        type="button"
        className="sidebar-saved-remove"
        onClick={onRemove}
        aria-label={`Remove saved message from ${bookmark.sessionTitle}`}
        title="Remove saved message"
      >
        ×
      </button>
    </div>
  )
}
