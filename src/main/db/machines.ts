/**
 * Machines registry: the remote (SSH) hosts the user has added. The local
 * machine is synthesized by the renderer and pinned first, so only remotes are
 * stored here. Drag-reorder maps to sort_order.
 */
import { randomUUID } from 'node:crypto'
import { getDb } from './database'
import type { Machine, MachineInput } from '@shared/machines'

export type { Machine, MachineInput }

interface DbRow {
  id: string
  name: string
  ssh_alias: string | null
  ssh_host: string
  ssh_user: string | null
  ssh_port: number
  sort_order: number
  created_at: number
  updated_at: number
}

function toRow(r: DbRow): Machine {
  return {
    id: r.id,
    name: r.name,
    sshAlias: r.ssh_alias,
    sshHost: r.ssh_host,
    sshUser: r.ssh_user,
    sshPort: r.ssh_port,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

export function listMachines(): Machine[] {
  const rows = getDb()
    .prepare('SELECT * FROM machines ORDER BY sort_order, created_at')
    .all() as DbRow[]
  return rows.map(toRow)
}

export function createMachine(input: MachineInput, now: number): Machine {
  const id = input.id ?? randomUUID()
  const nextOrder =
    (getDb().prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM machines').get() as { m: number }).m + 1
  getDb()
    .prepare(
      `INSERT INTO machines (id, name, ssh_alias, ssh_host, ssh_user, ssh_port, sort_order, created_at, updated_at)
       VALUES (@id, @name, @sshAlias, @sshHost, @sshUser, @sshPort, @sortOrder, @createdAt, @updatedAt)`,
    )
    .run({
      id,
      name: input.name,
      sshAlias: input.sshAlias ?? null,
      sshHost: input.sshHost,
      sshUser: input.sshUser ?? null,
      sshPort: input.sshPort ?? 22,
      sortOrder: nextOrder,
      createdAt: now,
      updatedAt: now,
    })
  return toRow(getDb().prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbRow)
}

export function updateMachine(id: string, patch: Partial<MachineInput>, now: number): Machine | null {
  const existing = getDb().prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbRow | undefined
  if (!existing) return null
  const merged = { ...toRow(existing) }
  if (patch.name !== undefined) merged.name = patch.name
  if (patch.sshAlias !== undefined) merged.sshAlias = patch.sshAlias
  if (patch.sshHost !== undefined) merged.sshHost = patch.sshHost
  if (patch.sshUser !== undefined) merged.sshUser = patch.sshUser
  if (patch.sshPort !== undefined) merged.sshPort = patch.sshPort
  getDb()
    .prepare(
      `UPDATE machines SET name=@name, ssh_alias=@sshAlias, ssh_host=@sshHost,
       ssh_user=@sshUser, ssh_port=@sshPort, updated_at=@updatedAt WHERE id=@id`,
    )
    .run({
      id,
      name: merged.name,
      sshAlias: merged.sshAlias,
      sshHost: merged.sshHost,
      sshUser: merged.sshUser,
      sshPort: merged.sshPort,
      updatedAt: now,
    })
  return toRow(getDb().prepare('SELECT * FROM machines WHERE id = ?').get(id) as DbRow)
}

export function deleteMachine(id: string): void {
  getDb().prepare('DELETE FROM machines WHERE id = ?').run(id)
}

export function reorderMachines(ids: string[], now: number): void {
  const stmt = getDb().prepare('UPDATE machines SET sort_order = ?, updated_at = ? WHERE id = ?')
  const tx = getDb().transaction((ordered: string[]) => {
    ordered.forEach((id, i) => stmt.run(i, now, id))
  })
  tx(ids)
}
