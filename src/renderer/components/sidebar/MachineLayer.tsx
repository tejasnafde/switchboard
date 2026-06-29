/**
 * Top sidebar layer: machines wrap the workspace tree. The local machine is
 * pinned first and renders the existing tree (passed as children); remotes are
 * rows below it, drag-reorderable. Connecting is not wired yet (M4) - remotes
 * show offline and an empty body. Add/remove/reorder of remotes is live.
 */
import type { ReactNode } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { CSS } from '@dnd-kit/utilities'
import { useMachineStore } from '../../stores/machine-store'
import { buildMachineList, type MachineNode, type MachineStatus } from './machineList'

const PIP_COLOR: Record<MachineStatus, string> = {
  connected: 'var(--success)',
  connecting: 'var(--warning)',
  offline: 'var(--text-muted)',
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

export function MachineLayer({ children, onAddMachine }: { children: ReactNode; onAddMachine: () => void }) {
  const remotes = useMachineStore((s) => s.remotes)
  const connections = useMachineStore((s) => s.connections)
  const collapsed = useMachineStore((s) => s.collapsed)
  const toggleCollapsed = useMachineStore((s) => s.toggleCollapsed)
  const remove = useMachineStore((s) => s.remove)
  const reorder = useMachineStore((s) => s.reorder)

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

  const renderNode = (node: MachineNode, dragHandleProps?: Record<string, unknown>) => {
    const isCollapsed = collapsed.has(node.id)
    return (
      <section className="sidebar-machine">
        <header className="sidebar-machine-header" onClick={() => toggleCollapsed(node.id)}>
          {dragHandleProps && (
            <span className="machine-grip" onClick={(e) => e.stopPropagation()} {...dragHandleProps}>
              ⠿
            </span>
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
          {node.kind === 'remote' && (
            <button
              className="machine-remove"
              title="Remove machine"
              onClick={(e) => {
                e.stopPropagation()
                void remove(node.id)
              }}
            >
              ×
            </button>
          )}
        </header>
        {!isCollapsed && (
          <div className="sidebar-machine-body">
            {node.kind === 'local' ? (
              children
            ) : (
              <div className="sidebar-machine-empty">Not connected. Remote connect ships in a later update.</div>
            )}
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
    </>
  )
}
