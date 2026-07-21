/**
 * Top sidebar layer: machines wrap the workspace tree. The local machine is
 * pinned first and renders the existing tree (passed as children); remotes are
 * rows below it, drag-reorderable. Connect/provision/tunnel is live (see
 * src/main/machines/); offline remotes show a cached read-only snapshot.
 */
import { useState, type MouseEvent, type ReactNode } from 'react'
import type { Project, SessionSummary } from '@shared/types'
import type { Machine } from '@shared/machines'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { useMachineStore } from '../../stores/machine-store'
import { useAgentStore } from '../../stores/agent-store'
import { buildMachineList, type MachineNode, type MachineStatus } from './machineList'
import { syncedAgoLabel, cachedProjects } from './machineSnapshot'
import { formatRelativeTime } from './sidebar-helpers'
import { ProjectFavicon } from './ProjectFavicon'
import { AddRemoteProjectModal } from './AddRemoteProjectModal'

const PIP_COLOR: Record<MachineStatus, string> = {
  connected: 'var(--success)',
  connecting: 'var(--warning)',
  offline: 'var(--text-muted)',
  error: 'var(--error)',
}

function SortableMachine({
  id,
  children,
}: {
  id: string
  children: (dragHandleProps: Record<string, unknown>) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
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
      {children({ ...attributes, ...listeners })}
    </div>
  )
}

/**
 * One project section on a CONNECTED remote - same classes and shape as the
 * local sidebar's project sections (favicon falls back to the folder glyph
 * because sb-favicon:// resolves against the local disk). Offline machines
 * keep the trimmed read-only snapshot list instead.
 */
function RemoteProject({
  project,
  collapsed,
  onToggle,
  activeSessionId,
  onOpen,
  onNewChat,
  onContextMenu,
}: {
  project: Project
  collapsed: boolean
  onToggle: () => void
  activeSessionId: string | null
  onOpen?: (session: SessionSummary) => void
  onNewChat?: () => void
  onContextMenu?: (e: MouseEvent, session: SessionSummary) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.path })
  const sessions = [...project.sessions].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  return (
    <div
      ref={setNodeRef}
      className="sidebar-project"
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
        opacity: isDragging ? 0.7 : 1,
      }}
    >
      <div className="sidebar-project-header" onClick={() => !isDragging && onToggle()}>
        <span
          {...attributes}
          {...listeners}
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
          onClick={(e) => e.stopPropagation()}
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
        <span className="sidebar-chevron">{collapsed ? '▶' : '▼'}</span>
        <ProjectFavicon projectPath={project.path} />
        <span className="sidebar-project-name">{project.name}</span>
        <span className="sidebar-project-count">{project.sessions.length || ''}</span>
        {onNewChat && (
          <button
            className="sidebar-project-compose"
            onClick={(e) => {
              e.stopPropagation()
              onNewChat()
            }}
            title="New thread in this project"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="sidebar-threads">
          {sessions.map((s) => {
            const isActive = activeSessionId === s.id
            return (
              <div
                key={s.id}
                className={`sidebar-thread ${isActive ? 'sidebar-thread-active' : ''}`}
                onClick={() => onOpen?.(s)}
                onContextMenu={onContextMenu ? (e) => onContextMenu(e, s) : undefined}
              >
                <span className={`sidebar-thread-dot ${isActive ? 'sidebar-thread-dot-active' : ''}`} />
                <span className="sidebar-thread-title">{s.title}</span>
                <span className="sidebar-thread-time">{formatRelativeTime(s.startedAt)}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function MachineLayer({
  children,
  onAddMachine,
  onEditMachine,
  onOpenRemoteSession,
  onNewRemoteChat,
  onSessionContextMenu,
}: {
  children: ReactNode
  onAddMachine: () => void
  onEditMachine?: (machine: Machine) => void
  onOpenRemoteSession?: (machineId: string, projectPath: string, session: SessionSummary) => void
  onNewRemoteChat?: (machineId: string, projectPath: string) => void
  onSessionContextMenu?: (e: MouseEvent, machineId: string, projectPath: string, session: SessionSummary) => void
}) {
  const remotes = useMachineStore((s) => s.remotes)
  const connections = useMachineStore((s) => s.connections)
  const collapsed = useMachineStore((s) => s.collapsed)
  const toggleCollapsed = useMachineStore((s) => s.toggleCollapsed)
  const remove = useMachineStore((s) => s.remove)
  const reorder = useMachineStore((s) => s.reorder)
  const snapshots = useMachineStore((s) => s.snapshots)
  const machineProjects = useMachineStore((s) => s.projects)
  const reorderMachineProjects = useMachineStore((s) => s.reorderMachineProjects)
  const connect = useMachineStore((s) => s.connect)
  const disconnect = useMachineStore((s) => s.disconnect)
  const lastError = useMachineStore((s) => s.lastError)
  const progress = useMachineStore((s) => s.progress)
  const reconnecting = useMachineStore((s) => s.reconnecting)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const [addProjectFor, setAddProjectFor] = useState<string | null>(null)
  // Per-remote-project collapse, keyed `${machineId}\0${path}`. Session-local
  // (not persisted) - matches how little we persist for remote view state.
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set())
  const toggleProject = (machineId: string, path: string) => {
    setCollapsedProjects((prev) => {
      const key = `${machineId}\0${path}`
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const handleProjectDragEnd = (machineId: string, live: Project[], e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const paths = live.map((p) => p.path)
    const from = paths.indexOf(String(active.id))
    const to = paths.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    void reorderMachineProjects(machineId, arrayMove(paths, from, to))
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  const nodes = buildMachineList(remotes, { localName: 'This Mac', connections })
  const local = nodes[0]
  const remoteNodes = nodes.slice(1)

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = remoteNodes.map((n) => n.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    void reorder(arrayMove(ids, from, to))
  }

  const renderRemoteBody = (node: MachineNode) => {
    const snap = snapshots[node.id]
    const projects = cachedProjects(snap)
    // Connected machines render the full live tree (same sections as the
    // local sidebar); the trimmed snapshot list is the offline fallback and
    // the brief connected-but-not-yet-synced window.
    const live = node.status === 'connected' ? machineProjects[node.id] : undefined
    const isReconnecting = node.status === 'error' && reconnecting[node.id]
    const offline = node.status === 'offline' || node.status === 'error'
    return (
      <div className="sidebar-machine-cached" data-offline={offline || undefined}>
        <div className="cached-banner">
          {node.status === 'connecting' || isReconnecting ? (
            <>
              <span className="machine-spinner" aria-hidden />
              <span className="machine-progress">
                {isReconnecting ? 'Reconnecting…' : (progress[node.id] ?? 'Connecting…')}
              </span>
              <button className="machine-connect" onClick={() => void disconnect(node.id)}>
                Cancel
              </button>
            </>
          ) : node.status === 'connected' ? (
            <>
              <button className="machine-connect" onClick={() => void disconnect(node.id)}>
                Disconnect
              </button>
              <button className="machine-connect" onClick={() => setAddProjectFor(node.id)}>
                + Add project
              </button>
            </>
          ) : (
            <button className="machine-connect" onClick={() => void connect(node.id)}>
              {node.status === 'error' ? 'Retry connect' : 'Connect'}
            </button>
          )}
          {offline && projects.length > 0 && (
            <span className="cached-label">{syncedAgoLabel(snap?.syncedAt, Date.now())} · read-only</span>
          )}
        </div>
        {node.status === 'error' && !isReconnecting && lastError[node.id] && (
          <div className="machine-error-reason">{lastError[node.id]}</div>
        )}
        {live && live.length > 0 ? (
          <DndContext
            sensors={sensors}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={(e) => handleProjectDragEnd(node.id, live, e)}
          >
            <SortableContext items={live.map((p) => p.path)} strategy={verticalListSortingStrategy}>
              {live.map((p) => (
                <RemoteProject
                  key={p.path}
                  project={p}
                  collapsed={collapsedProjects.has(`${node.id}\0${p.path}`)}
                  onToggle={() => toggleProject(node.id, p.path)}
                  activeSessionId={activeSessionId}
                  onOpen={onOpenRemoteSession ? (s) => onOpenRemoteSession(node.id, p.path, s) : undefined}
                  onNewChat={onNewRemoteChat ? () => onNewRemoteChat(node.id, p.path) : undefined}
                  onContextMenu={
                    onSessionContextMenu
                      ? (e, s) => {
                          e.preventDefault()
                          e.stopPropagation()
                          onSessionContextMenu(e, node.id, p.path, s)
                        }
                      : undefined
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
        ) : projects.length === 0 ? (
          <div className="sidebar-machine-empty">
            {node.status === 'connected'
              ? 'No projects on this machine yet.'
              : 'Not connected. Connect to browse this machine.'}
          </div>
        ) : (
          projects.map((p) => (
            <div key={p.path} className="cached-project">
              <div className="cached-project-name">
                {p.name}
                {node.status === 'connected' && onNewRemoteChat && (
                  <button
                    className="cached-new-chat"
                    title="New chat on this machine"
                    onClick={() => onNewRemoteChat(node.id, p.path)}
                  >
                    +
                  </button>
                )}
              </div>
              {p.sessions.map((s) => {
                const connected = node.status === 'connected'
                const openable = connected && !!onOpenRemoteSession
                const summary: SessionSummary = {
                  id: s.id,
                  title: s.title,
                  source:
                    s.agentType === 'codex'
                      ? 'codex'
                      : s.agentType === 'opencode'
                        ? 'opencode'
                        : 'claude-code',
                  agentType: s.agentType ?? null,
                  startedAt: 0,
                  messageCount: 0,
                  filePath: '',
                }
                return (
                  <div
                    key={s.id}
                    className={`cached-chat${s.id === activeSessionId ? ' sidebar-thread-active' : ''}`}
                    data-openable={openable || undefined}
                    title={openable ? undefined : 'Connect to this machine to open'}
                    onClick={openable ? () => onOpenRemoteSession!(node.id, p.path, summary) : undefined}
                    onContextMenu={
                      // Menu actions route to the machine - connected only.
                      connected && onSessionContextMenu
                        ? (e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            onSessionContextMenu(e, node.id, p.path, summary)
                          }
                        : undefined
                    }
                  >
                    {s.title}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    )
  }

  const renderNode = (node: MachineNode, dragHandleProps?: Record<string, unknown>) => {
    const isCollapsed = collapsed.has(node.id)
    return (
      <section className="sidebar-machine">
        <header className="sidebar-machine-header" onClick={() => toggleCollapsed(node.id)}>
          {/* Grip is an absolute overlay in the left padding gutter, so local +
              remote headers align without reserving layout width. */}
          {dragHandleProps && (
            <span className="machine-grip" onClick={(e) => e.stopPropagation()} {...dragHandleProps}>
              ⠿
            </span>
          )}
          <span className="sidebar-chevron">{isCollapsed ? '▶' : '▼'}</span>
          {/* An auto-reconnecting error shows the amber connecting pip, not red - it's in progress, not dead. */}
          <span
            className="machine-pip"
            style={{ background: PIP_COLOR[node.status === 'error' && reconnecting[node.id] ? 'connecting' : node.status] }}
          />
          <span className="sidebar-machine-name">{node.name}</span>
          {node.kind === 'local' ? (
            <span className="machine-tag">local</span>
          ) : (
            <span className="machine-host">
              {node.sshUser ? `${node.sshUser}@` : ''}
              {node.sshHost}
            </span>
          )}
          {node.kind === 'remote' && onEditMachine && (
            <button
              className="machine-edit"
              title="Edit machine"
              onClick={(e) => {
                e.stopPropagation()
                const machine = remotes.find((m) => m.id === node.id)
                if (machine) onEditMachine(machine)
              }}
            >
              ✎
            </button>
          )}
          {node.kind === 'remote' && (
            <button
              className="machine-remove"
              title="Remove machine"
              onClick={(e) => {
                e.stopPropagation()
                // Deleting also drops the offline snapshot; not undoable.
                if (window.confirm(`Remove machine "${node.name}"?`)) void remove(node.id)
              }}
            >
              ×
            </button>
          )}
        </header>
        {!isCollapsed && (
          <div className="sidebar-machine-body">
            {node.kind === 'local' ? children : renderRemoteBody(node)}
          </div>
        )}
      </section>
    )
  }

  return (
    <>
      {renderNode(local)}
      <DndContext sensors={sensors} modifiers={[restrictToVerticalAxis]} onDragEnd={handleDragEnd}>
        <SortableContext items={remoteNodes.map((n) => n.id)} strategy={verticalListSortingStrategy}>
          {remoteNodes.map((node) => (
            <SortableMachine key={node.id} id={node.id}>
              {(dragHandleProps) => renderNode(node, dragHandleProps)}
            </SortableMachine>
          ))}
        </SortableContext>
      </DndContext>
      <button className="sidebar-add-machine" onClick={onAddMachine}>
        <span style={{ fontSize: '13px', lineHeight: 1 }}>+</span> Add machine
      </button>
      {addProjectFor && (
        <AddRemoteProjectModal machineId={addProjectFor} onClose={() => setAddProjectFor(null)} />
      )}
    </>
  )
}
