/**
 * Top sidebar layer: machines wrap the workspace tree. The local machine is
 * pinned first and renders the existing tree (passed as children); remotes are
 * rows below it, drag-reorderable. Connect/provision/tunnel is live (see
 * src/main/machines/); offline remotes show a cached read-only snapshot.
 */
import { useState, type ReactNode } from 'react'
import type { SessionSummary } from '@shared/types'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { useMachineStore } from '../../stores/machine-store'
import { useAgentStore } from '../../stores/agent-store'
import { buildMachineList, type MachineNode, type MachineStatus } from './machineList'
import { syncedAgoLabel, cachedProjects } from './machineSnapshot'
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

export function MachineLayer({
  children,
  onAddMachine,
  onOpenRemoteSession,
  onNewRemoteChat,
}: {
  children: ReactNode
  onAddMachine: () => void
  onOpenRemoteSession?: (machineId: string, projectPath: string, session: SessionSummary) => void
  onNewRemoteChat?: (machineId: string, projectPath: string) => void
}) {
  const remotes = useMachineStore((s) => s.remotes)
  const connections = useMachineStore((s) => s.connections)
  const collapsed = useMachineStore((s) => s.collapsed)
  const toggleCollapsed = useMachineStore((s) => s.toggleCollapsed)
  const remove = useMachineStore((s) => s.remove)
  const reorder = useMachineStore((s) => s.reorder)
  const snapshots = useMachineStore((s) => s.snapshots)
  const connect = useMachineStore((s) => s.connect)
  const disconnect = useMachineStore((s) => s.disconnect)
  const lastError = useMachineStore((s) => s.lastError)
  const progress = useMachineStore((s) => s.progress)
  const reconnecting = useMachineStore((s) => s.reconnecting)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const [addProjectFor, setAddProjectFor] = useState<string | null>(null)

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
        {projects.length === 0 ? (
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
                const openable = node.status === 'connected' && !!onOpenRemoteSession
                return (
                  <div
                    key={s.id}
                    className={`cached-chat${s.id === activeSessionId ? ' sidebar-thread-active' : ''}`}
                    data-openable={openable || undefined}
                    title={openable ? undefined : 'Connect to this machine to open'}
                    onClick={
                      openable
                        ? () =>
                            onOpenRemoteSession!(node.id, p.path, {
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
                            })
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
