/**
 * Machines IPC: CRUD for the user's remote (SSH) hosts plus a read of
 * ~/.ssh/config to populate the "Add machine" picker. Machine management is a
 * local-app concern, so these always run against the local DB.
 */
import type { BackendHost } from '../backend/host'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MachineChannels } from '@shared/ipc-channels'
import { createMainLogger } from '../logger'
import { listMachines, createMachine, updateMachine, deleteMachine, reorderMachines, getMachineSnapshots, type MachineInput } from '../db/machines'
import { parseSshConfig } from '../machines/sshConfig'
import { ConnectionManager } from '../machines/connectionManager'
import { allocatePort, spawnTunnel, waitForHealth, REMOTE_PORT, REMOTE_COMMAND } from '../machines/connectDeps'

const log = createMainLogger('ipc:machines')

export function registerMachineHandlers(host: BackendHost): void {
  const connections = new ConnectionManager({
    allocatePort,
    spawnTunnel,
    waitForHealth,
    remotePort: REMOTE_PORT,
    remoteCommand: REMOTE_COMMAND,
    onStatus: (machineId, status, url) => host.emit(MachineChannels.STATUS, machineId, status, url),
  })

  host.handle(MachineChannels.LIST, () => listMachines())

  host.handle(MachineChannels.CREATE, (input: MachineInput) => createMachine(input, Date.now()))

  host.handle(MachineChannels.UPDATE, (id: string, patch: Partial<MachineInput>) =>
    updateMachine(id, patch, Date.now()),
  )

  host.handle(MachineChannels.DELETE, (id: string) => {
    deleteMachine(id)
    return { ok: true }
  })

  host.handle(MachineChannels.REORDER, (ids: string[]) => {
    reorderMachines(ids, Date.now())
    return { ok: true }
  })

  host.handle(MachineChannels.GET_SNAPSHOTS, () => getMachineSnapshots())

  host.handle(MachineChannels.CONNECT, (id: string) => {
    const machine = listMachines().find((m) => m.id === id)
    if (!machine) return { ok: false as const, error: 'unknown machine' }
    // Fire and forget: status flows to the renderer via MachineChannels.STATUS.
    void connections.connect(machine)
    return { ok: true as const }
  })

  host.handle(MachineChannels.DISCONNECT, async (id: string) => {
    await connections.disconnect(id)
    return { ok: true as const }
  })

  host.handle(MachineChannels.LIST_SSH_HOSTS, async () => {
    try {
      const text = await readFile(join(homedir(), '.ssh', 'config'), 'utf-8')
      return parseSshConfig(text)
    } catch (err) {
      // No ~/.ssh/config (or unreadable) is normal - the picker just shows none.
      log.info(`no ssh config: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  })
}
