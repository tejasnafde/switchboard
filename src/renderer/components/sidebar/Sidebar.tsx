import { useState, useCallback, useEffect, useRef } from 'react'
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
import { onSessionRename, emitSessionRename, onSessionCreated } from '../../services/session-events'
import { serializeConversationToMarkdown, suggestedExportFilename } from '../../services/exportMarkdown'

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
  children: (props: { isDragging: boolean; dragHandleProps: Record<string, any> }) => React.ReactNode
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [scanning, setScanning] = useState<string | null>(null)
  const [scannedPaths, setScannedPaths] = useState<Set<string>>(new Set())
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const editRef = useRef<HTMLInputElement>(null)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  // Right-click context menu — at most one open at a time.
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    sessionId: string
    projectPath: string
    session: SessionSummary
  } | null>(null)
  // "Merge into…" picker state. Holds the fragment to attach; when set,
  // shows a modal listing sibling chats in the same project as merge targets.
  const [mergePickerFor, setMergePickerFor] = useState<{
    sessionId: string
    projectPath: string
    session: SessionSummary
  } | null>(null)

  // DnD sensors — small activation distance to distinguish click from drag
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  )

  useEffect(() => {
    window.api.app.getProjects().then((saved: Project[]) => {
      if (saved?.length) {
        // Start with all projects collapsed by default
        setCollapsed(new Set(saved.map((p) => p.path)))

        // Restore saved order from settings
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
  }, [])

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
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

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
      setCollapsed((prev) => {
        if (!prev.has(newSession.projectPath)) return prev
        const next = new Set(prev)
        next.delete(newSession.projectPath)
        return next
      })
    })
  }, [])

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
    await (window.api.app as any).exportMarkdown({
      suggestedFilename: suggestedExportFilename(session.title ?? 'conversation'),
      content,
    })
  }, [])

  const handleMerge = useCallback(async (
    fragment: { sessionId: string; projectPath: string; session: SessionSummary },
    rootThreadId: string,
  ) => {
    try {
      await (window.api.app as any).attachToThread(fragment.sessionId, rootThreadId)
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
    ;(window.api.app as any).archiveConversation(session.id, projectPath, session.title).catch(() => {
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

  // Drag-to-reorder handler
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    setProjects((prev) => {
      const oldIndex = prev.findIndex((p) => p.path === active.id)
      const newIndex = prev.findIndex((p) => p.path === over.id)
      if (oldIndex === -1 || newIndex === -1) return prev

      const reordered = arrayMove(prev, oldIndex, newIndex)

      // Persist order
      const order = reordered.map((p) => p.path)
      window.api.settings.set('projectOrder', JSON.stringify(order)).catch(() => {})

      return reordered
    })
  }, [])

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

      {/* Project + thread list */}
      <div className="sidebar-list">
        <DndContext
          sensors={sensors}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={projects.map((p) => p.path)}
            strategy={verticalListSortingStrategy}
          >
            {projects.map((project) => {
              const isCollapsed = collapsed.has(project.path)

              return (
                <SortableProject key={project.path} id={project.path}>
                  {({ isDragging, dragHandleProps }) => (
                    <div className="sidebar-project">
                      {/* Project header row */}
                      <div
                        className="sidebar-project-header"
                        onClick={() => !isDragging && toggleCollapse(project.path)}
                      >
                        {/* Drag handle */}
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

                      {/* Session threads */}
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
                  )}
                </SortableProject>
              )
            })}
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
