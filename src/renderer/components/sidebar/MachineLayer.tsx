/**
 * Top sidebar layer: machines wrap the workspace tree. The local machine is
 * pinned first and renders the existing tree (passed as children); remotes are
 * rows below it, drag-reorderable. Connect/provision/tunnel is live (see
 * src/main/machines/); offline remotes show a cached read-only snapshot.
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import type { SessionSummary } from '@shared/types'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import type { Machine } from '@shared/machines'
import { useMachineStore } from '../../stores/machine-store'
import { useAgentStore } from '../../stores/agent-store'
import { buildMachineList, type MachineNode, type MachineStatus } from './machineList'
import { syncedAgoLabel, cachedProjects } from './machineSnapshot'
import { AddRemoteProjectModal } from './AddRemoteProjectModal'

const PIP_COLOR: Record<MachineStatus, string> = {
  connected: 'var(--success)',
  connecting: 'var(--warning)',
  provisioning: 'var(--warning)',
  // Self-healing backoff, deliberately not error-red - see connectionStatus.ts.
  reconnecting: 'var(--warning)',
  offline: 'var(--text-muted)',
  error: 'var(--error)',
}

/** Connect-in-flight statuses that render the spinner banner. */
const BUSY_STATUSES: readonly MachineStatus[] = ['connecting', 'provisioning', 'reconnecting']

/** Quick connects should not flash a counter - show elapsed only past this. */
const ELAPSED_VISIBLE_AFTER_S = 3

/**
 * Spinner + phase label + elapsed seconds + Cancel, shown while a connect
 * attempt is in flight. The 1s tick lives here so only busy machines re-render.
 */
function MachineBusyBanner({
  status,
  detail,
  startedAt,
  onCancel,
}: {
  status: MachineStatus
  detail: string | null
  startedAt: number | null
  onCancel: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const elapsedS = startedAt !== null ? Math.floor((now - startedAt) / 1000) : null
  const label = detail ?? (status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…')
  return (
    <>
      <span className="machine-spinner" aria-hidden />
      <span className="machine-busy-label" title={label}>
        {label}
      </span>
      {elapsedS !== null && elapsedS >= ELAPSED_VISIBLE_AFTER_S && (
        <span className="machine-elapsed">{elapsedS}s</span>
      )}
      <button className="machine-connect" onClick={onCancel}>
        Cancel
      </button>
    </>
  )
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
  const connect = useMachineStore((s) => s.connect)
  const disconnect = useMachineStore((s) => s.disconnect)
  const lastError = useMachineStore((s) => s.lastError)
  const connectionDetail = useMachineStore((s) => s.connectionDetail)
  const connectStartedAt = useMachineStore((s) => s.connectStartedAt)
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
    const offline = node.status === 'offline' || node.status === 'error'
    return (
      <div className="sidebar-machine-cached">
        <div className="cached-banner">
          {BUSY_STATUSES.includes(node.status) ? (
            <MachineBusyBanner
              status={node.status}
              detail={connectionDetail[node.id] ?? null}
              startedAt={connectStartedAt[node.id] ?? null}
              onCancel={() => void disconnect(node.id)}
            />
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
          {node.status === 'error' && lastError[node.id] && (
            <span className="machine-error-reason" title={lastError[node.id] ?? undefined}>
              {lastError[node.id]}
            </span>
          )}
          {offline && projects.length > 0 && (
            <span className="cached-label">{syncedAgoLabel(snap?.syncedAt, Date.now())} · read-only</span>
          )}
        </div>
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
                    title={openable ? undefined : 'Connect to open this chat'}
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
          {/* Always render the grip slot so local + remote headers align; only
              remotes (drag-reorderable) get the actual handle. */}
          {dragHandleProps ? (
            <span className="machine-grip" onClick={(e) => e.stopPropagation()} {...dragHandleProps}>
              ⠿
            </span>
          ) : (
            <span className="machine-grip" aria-hidden />
          )}
          <span className="sidebar-chevron">{isCollapsed ? '▶' : '▼'}</span>
          <span className="machine-pip" style={{ background: PIP_COLOR[node.status] }} />
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
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            </button>
          )}
          {node.kind === 'remote' && (
            <button
              className="machine-remove"
              title="Remove machine"
              onClick={(e) => {
                e.stopPropagation()
                if (!window.confirm(`Remove ${node.name}? Its cached snapshot is deleted too.`)) return
                void remove(node.id)
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
      {/* Always-visible header - keeps "+ Add machine" reachable without
          scrolling past the local tree and every remote. */}
      <div className="machine-layer-header">
        <span className="machine-layer-title">Machines</span>
        <button className="sidebar-add-machine" onClick={onAddMachine}>
          <span style={{ fontSize: '13px', lineHeight: 1 }}>+</span> Add machine
        </button>
      </div>
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
      {addProjectFor && (
        <AddRemoteProjectModal machineId={addProjectFor} onClose={() => setAddProjectFor(null)} />
      )}
    </>
  )
}
