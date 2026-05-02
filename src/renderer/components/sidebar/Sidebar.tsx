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
import { useLayoutStore } from '../../stores/layout-store'
import { onSessionRename, emitSessionRename, onSessionCreated } from '../../services/session-events'
import { serializeConversationToMarkdown, suggestedExportFilename } from '../../services/exportMarkdown'
import { SidebarFilter } from './SidebarFilter'
import { decideDragOutcome } from './dragLogic'
import { WorkspaceManager } from './WorkspaceManager'
import {
  groupProjectsByWorkspace,
  applySidebarFilter,
  colorTokenForWorkspace,
  type WorkspaceGroup,
} from './sidebar-helpers'
import type { Workspace } from '@shared/types'

function useUnreadCount(sessionId: string): number {
  return useAgentStore((s) => s.sessions.find((sess) => sess.id === sessionId)?.unreadCount ?? 0)
}

function UnreadBadge({ sessionId }: { sessionId: string }) {
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

/** Sum of unread counts across a workspace group — surfaces activity when the
 *  workspace is collapsed and per-session badges are hidden. */
function useGroupUnreadCount(sessionIds: string[]): number {
  // Select the sessions array (stable reference) once, then reduce with a
  // local Map. Cheaper than `find` per id when many groups call this hook.
  const sessions = useAgentStore((s) => s.sessions)
  return useMemo(() => {
    const byId = new Map(sessions.map((s) => [s.id, s.unreadCount ?? 0]))
    let total = 0
    for (const id of sessionIds) total += byId.get(id) ?? 0
    return total
  }, [sessions, sessionIds])
}

/** Aggregated unread badge on workspace headers. Only rendered while
 *  the workspace is collapsed — when expanded, the per-session pills
 *  inside cover the same information and the workspace pill becomes
 *  redundant noise. */
function WorkspaceUnreadBadge({ sessionIds, expanded }: { sessionIds: string[]; expanded?: boolean }) {
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
import type { Project, SessionSummary } from '@shared/types'

interface SidebarProps {
  onSessionSelect?: (session: SessionSummary, projectPath: string) => void
  onNewChat?: (projectPath: string) => void
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

export function Sidebar({ onSessionSelect, onNewChat }: SidebarProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [workspaces, setWorkspaces] = useState<Workspace[]>([])
  const [scanning, setScanning] = useState<string | null>(null)
  const [scannedPaths, setScannedPaths] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [filterQuery, setFilterQuery] = useState('')
  const [managerOpen, setManagerOpen] = useState(false)
  const editRef = useRef<HTMLInputElement>(null)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)

  // Persisted collapse state — single source of truth lives in layout-store
  // so it survives reload (and the SidebarFilter's auto-expand only touches
  // the local view, never the persisted truth).
  const collapsedProjects = useLayoutStore((s) => s.sidebarCollapsedProjects)
  const collapsedWorkspaces = useLayoutStore((s) => s.sidebarCollapsedWorkspaces)
  const toggleSidebarProject = useLayoutStore((s) => s.toggleSidebarProject)
  const toggleSidebarWorkspace = useLayoutStore((s) => s.toggleSidebarWorkspace)
  const setSidebarCollapsedProjects = useLayoutStore((s) => s.setSidebarCollapsedProjects)
  const expandSidebarProject = useLayoutStore((s) => s.expandSidebarProject)
  const expandSidebarWorkspace = useLayoutStore((s) => s.expandSidebarWorkspace)

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
  const [mergePickerFor, setMergePickerFor] = useState<{
    sessionId: string
    projectPath: string
    session: SessionSummary
  } | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  const refreshWorkspaces = useCallback(() => {
    window.api.app.workspaces.list().then((list) => setWorkspaces(list ?? [])).catch(() => {})
  }, [])

  useEffect(() => {
    refreshWorkspaces()
    window.api.app.getProjects().then((saved: Project[]) => {
      if (saved?.length) {
        // Default-collapse only on first run — once the user has expanded
        // anything, layout-store drives the truth across reloads.
        const stored = useLayoutStore.getState().sidebarCollapsedProjects
        if (stored.length === 0) {
          setSidebarCollapsedProjects(saved.map((p) => p.path))
        }

        window.api.settings.get('projectOrder').then((orderJson: string | null) => {
          if (orderJson) {
            try {
              const order: string[] = JSON.parse(orderJson)
              const sorted = [...saved].sort((a, b) => {
                const ai = order.indexOf(a.path)
                const bi = order.indexOf(b.path)
                if (ai === -1 && bi === -1) return 0
                if (ai === -1) return 1
                if (bi === -1) return -1
                return ai - bi
              })
              setProjects(sorted)
            } catch {
              setProjects(saved)
            }
          } else {
            setProjects(saved)
          }
        })
      }
    })
  }, [refreshWorkspaces, setSidebarCollapsedProjects])

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
      setProjects((prev) =>
        prev.map((p) => (p.path === projectPath ? { ...p, sessions } : p))
      )
    } finally {
      setScanning(null)
      setScannedPaths((prev) => new Set(prev).add(projectPath))
    }
  }, [])

  const toggleCollapse = useCallback((path: string) => {
    toggleSidebarProject(path)
  }, [toggleSidebarProject])

  const startRename = useCallback((session: SessionSummary) => {
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
    window.api.app.createConversation({
      id: sessionId,
      projectPath,
      agentType: 'claude-code',
      title: newTitle,
    }).catch(() => {})
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

  // Refresh project list from disk (e.g., after unarchive)
  useEffect(() => {
    const handler = () => {
      window.api.app.getProjects().then((saved: Project[]) => {
        if (saved?.length) setProjects(saved)
      }).catch(() => {})
    }
    window.addEventListener('sidebar-refresh', handler)
    return () => window.removeEventListener('sidebar-refresh', handler)
  }, [])

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
        }
      } catch { /* best-effort — export whatever we have */ }
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
      // best-effort — next getProjects refresh will correct state
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

  const handleAssignWorkspace = useCallback(async (projectPath: string, workspaceId: string | null) => {
    setProjects((prev) => prev.map((p) => p.path === projectPath ? { ...p, workspaceId } : p))
    try {
      await window.api.app.assignProjectWorkspace(projectPath, workspaceId)
    } catch { /* optimistic — next refresh will correct */ }
  }, [])

  const handleCreateWorkspaceFromProject = useCallback(async (projectPath: string) => {
    const name = window.prompt('New workspace name')
    if (!name?.trim()) return
    try {
      const w = await window.api.app.workspaces.create({ name: name.trim() })
      setWorkspaces((prev) => [...prev, w])
      await handleAssignWorkspace(projectPath, w.id)
    } catch { /* best-effort */ }
  }, [handleAssignWorkspace])

  // Same-workspace drop → reorder + persist projectOrder.
  // Cross-workspace drop → reassign workspaceId; reorder is skipped (the
  // regroup picks up the new bucket on next refresh).
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const outcome = decideDragOutcome(projects, String(active.id), String(over.id))
    if (outcome.type === 'noop') return
    if (outcome.type === 'reassign') {
      void handleAssignWorkspace(outcome.projectPath, outcome.targetWorkspaceId)
      return
    }
    setProjects((prev) => {
      const reordered = arrayMove(prev, outcome.oldIndex, outcome.newIndex)
      const order = reordered.map((p) => p.path)
      window.api.settings.set('projectOrder', JSON.stringify(order)).catch(() => {})
      return reordered
    })
  }, [projects, handleAssignWorkspace])

  // Compute the workspace-grouped tree, then apply the (debounced) filter.
  // The filter expansion sets are merged with the persisted collapse sets:
  // when filtering, matching ancestors auto-expand without clobbering the
  // user's saved collapse state \u2014 clearing the filter restores it.
  const groups: WorkspaceGroup[] = useMemo(
    () => groupProjectsByWorkspace(projects, workspaces),
    [projects, workspaces]
  )
  const filtered = useMemo(() => applySidebarFilter(filterQuery, groups), [filterQuery, groups])
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
    return (
      <div className="sidebar-project">
        <div
          className="sidebar-project-header"
          onClick={() => !isDragging && toggleCollapse(project.path)}
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
          <span className="sidebar-chevron">
            {isCollapsed ? '\u25B6' : '\u25BC'}
          </span>
          <span className="sidebar-project-name">
            {project.name}
          </span>
          <span className="sidebar-project-count">
            {project.sessions.length || ''}
          </span>
          <button
            className="sidebar-project-compose"
            onClick={(e) => {
              e.stopPropagation()
              onNewChat?.(project.path)
            }}
            title="New thread in this project"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
        </div>

        {!isCollapsed && (
          <div className="sidebar-threads">
            {project.sessions.length > 0 ? (
              project.sessions.map((s) => {
                const isActive = activeSessionId === s.id
                return (
                  <div
                    key={s.id}
                    className={`sidebar-thread ${isActive ? 'sidebar-thread-active' : ''}`}
                    onClick={() => {
                      if (editingId !== s.id) {
                        onSessionSelect?.(s, project.path)
                      }
                    }}
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
                        <span className={`sidebar-thread-dot ${
                          isActive ? 'sidebar-thread-dot-active' : ''
                        }`} />
                        <span className="sidebar-thread-title">
                          {s.title}
                        </span>
                        <UnreadBadge sessionId={s.id} />
                        <span className="sidebar-thread-time">
                          {formatRelativeTime(s.startedAt)}
                        </span>
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
            ) : scannedPaths.has(project.path) ? (
              <div className="sidebar-empty">No conversations found</div>
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

  return (
    <div className="sidebar-root">
      {/* Header */}
      <div className="sidebar-header">
        <span className="sidebar-header-label">THREADS</span>
        <button
          className="sidebar-new-btn"
          onClick={() => {
            const project = projects[0]
            if (project) onNewChat?.(project.path)
          }}
          disabled={projects.length === 0}
          title="New thread"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </button>
      </div>

      {/* Filter input \u2014 debounced 100ms, fuzzy substring on session titles */}
      {projects.length > 0 && <SidebarFilter onChange={setFilterQuery} />}

      {/* Project + thread list */}
      <div className="sidebar-list">
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
              const wsId = group.workspace?.id ?? ungroupedKey
              const wsCollapsed = isWorkspaceCollapsed(wsId)
              const sessionTotal = group.projects.reduce((acc, p) => acc + p.sessions.length, 0)
              const spineColor = group.workspace ? colorTokenForWorkspace(group.workspace) : 'var(--text-muted)'
              return (
                <section
                  key={wsId}
                  className={`sidebar-workspace ${wsCollapsed ? 'collapsed' : ''} ${group.workspace ? '' : 'ungrouped'}`}
                  style={{ ['--spine' as string]: spineColor } as React.CSSProperties}
                >
                  <header
                    className="sidebar-workspace-header"
                    onClick={() => toggleSidebarWorkspace(wsId)}
                    onContextMenu={(e) => {
                      // Right-clicking a workspace header opens the manager
                      // \u2014 keeps the menu surface tiny without a second flavor.
                      e.preventDefault()
                      e.stopPropagation()
                      setManagerOpen(true)
                    }}
                  >
                    <span className="sidebar-chevron">{wsCollapsed ? '\u25B6' : '\u25BC'}</span>
                    <span className="sidebar-workspace-name">
                      {group.workspace?.name ?? 'Ungrouped'}
                    </span>
                    <WorkspaceUnreadBadge
                      sessionIds={group.projects.flatMap((p) => p.sessions.map((s) => s.id))}
                      expanded={!wsCollapsed}
                    />
                    <span
                      className="sidebar-workspace-count"
                      title={`${group.projects.length} project${group.projects.length === 1 ? '' : 's'}, ${sessionTotal} thread${sessionTotal === 1 ? '' : 's'}`}
                    >
                      {group.projects.length}{'\u00B7'}{sessionTotal}
                    </span>
                  </header>
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

      {/* Footer */}
      <div className="sidebar-footer">
        <button onClick={handleAddProject} className="sidebar-add-project-btn">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add Project
        </button>
        <button
          onClick={() => setManagerOpen(true)}
          className="sidebar-add-project-btn"
          title="Manage workspaces"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7h18M3 12h18M3 17h18" />
          </svg>
          Workspaces
        </button>
      </div>

      {/* Right-click context menu on sessions */}
      {contextMenu && (
        <SidebarContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          items={[
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

      {/* Right-click on a project header — workspace assignment */}
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
                setManagerOpen(true)
                setProjectMenu(null)
              },
            },
          ]}
        />
      )}

      {/* Workspace manager modal — rename / recolor / delete */}
      {managerOpen && (
        <WorkspaceManager
          workspaces={workspaces}
          onClose={() => setManagerOpen(false)}
          onMutated={() => {
            refreshWorkspaces()
            // Re-fetch projects too: deleting a workspace SET NULL'd their
            // workspace_id on the main side; the renderer cache needs a refresh
            // to reflect the move-back-to-Ungrouped.
            window.api.app.getProjects().then((saved: Project[]) => {
              if (saved?.length) setProjects(saved)
            }).catch(() => {})
          }}
        />
      )}

      {/* Merge-fragment picker — lists sibling chats in the same project. */}
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
    </div>
  )
}

/**
 * Modal picker for attaching a fragmented session into another thread.
 * Lists sibling chats in the same project — picking one re-parents the
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

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w`
  const months = Math.floor(days / 30)
  return `${months}mo`
}
