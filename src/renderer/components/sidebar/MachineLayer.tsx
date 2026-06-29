/**
 * Top sidebar layer: machines wrap the workspace tree. The local machine is
 * pinned first and renders the existing tree (passed as children); remotes are
 * rows below it. Connecting is not wired yet (M4) - remotes show offline and an
 * empty body. Add/remove + reorder of remotes is live.
 */
import type { ReactNode } from 'react'
import { useMachineStore } from '../../stores/machine-store'
import { buildMachineList, type MachineStatus } from './machineList'

const PIP_COLOR: Record<MachineStatus, string> = {
  connected: 'var(--success)',
  connecting: 'var(--warning)',
  offline: 'var(--text-muted)',
}

export function MachineLayer({ children, onAddMachine }: { children: ReactNode; onAddMachine: () => void }) {
  const remotes = useMachineStore((s) => s.remotes)
  const connections = useMachineStore((s) => s.connections)
  const collapsed = useMachineStore((s) => s.collapsed)
  const toggleCollapsed = useMachineStore((s) => s.toggleCollapsed)
  const remove = useMachineStore((s) => s.remove)

  const nodes = buildMachineList(remotes, { localName: 'This Mac', connections })

  return (
    <>
      {nodes.map((node) => {
        const isCollapsed = collapsed.has(node.id)
        return (
          <section key={node.id} className="sidebar-machine">
            <header className="sidebar-machine-header" onClick={() => toggleCollapsed(node.id)}>
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
      })}
      <button className="sidebar-add-machine" onClick={onAddMachine}>
        <span style={{ fontSize: '13px', lineHeight: 1 }}>+</span> Add machine
      </button>
    </>
  )
}
