/**
 * Sidebar machine display model. The local machine is synthesized, pinned
 * first, and always "connected"; remotes follow in sortOrder, each tagged with
 * its live connection status (default offline).
 */
import type { Machine } from '@shared/machines'

export type MachineStatus = 'connected' | 'connecting' | 'provisioning' | 'reconnecting' | 'offline' | 'error'

export interface MachineNode {
  id: string // 'local' or a Machine id
  name: string
  kind: 'local' | 'remote'
  status: MachineStatus
  sshUser?: string | null
  sshHost?: string
}

export function buildMachineList(
  remotes: Machine[],
  opts: { localName: string; connections: Record<string, MachineStatus> },
): MachineNode[] {
  const local: MachineNode = { id: 'local', name: opts.localName, kind: 'local', status: 'connected' }
  const sorted = [...remotes].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  const remoteNodes: MachineNode[] = sorted.map((m) => ({
    id: m.id,
    name: m.name,
    kind: 'remote',
    status: opts.connections[m.id] ?? 'offline',
    sshUser: m.sshUser,
    sshHost: m.sshHost,
  }))
  return [local, ...remoteNodes]
}
