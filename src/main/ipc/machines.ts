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
import { listMachines, createMachine, updateMachine, deleteMachine, reorderMachines, getMachineSnapshots, saveMachineSnapshot, type MachineInput } from '../db/machines'
import type { MachineSnapshot } from '@shared/machines'
import { parseSshConfig } from '../machines/sshConfig'
import { ConnectionManager } from '../machines/connectionManager'
import { allocatePort, spawnTunnel, waitForHealth, REMOTE_PORT, REMOTE_COMMAND, REMOTE_IDE_PORT } from '../machines/connectDeps'
import { makeProvision } from '../machines/provisionDeps'
import { getSetting, setSetting } from '../db/database'
import { createServer } from 'node:net'

const log = createMainLogger('ipc:machines')

/**
 * Stable local forward port for a machine's code-server, persisted per
 * machine: the workbench origin (http://127.0.0.1:<port>) scopes extension
 * state in IndexedDB, so the port must survive reconnects AND app restarts
 * or remote extension auth/state is orphaned every time. Falls back to a
 * fresh port (and re-persists) only when the stored one is taken.
 */
async function stableIdePort(machineId: string): Promise<number> {
  const key = `machines.idePort.${machineId}`
  const stored = Number(getSetting(key))
  if (Number.isInteger(stored) && stored > 1024 && stored < 65536 && (await portFree(stored))) {
    return stored
  }
  const fresh = await allocatePort()
  setSetting(key, String(fresh))
  return fresh
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const srv = createServer()
    srv.once('error', () => resolvePromise(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolvePromise(true)))
  })
}

// Hoisted to module scope: registerMachineHandlers runs again on macOS
// 'activate' (window reopened after all windows closed), and a fresh
// ConnectionManager per call would strand any live tunnels held by the old
// instance. `currentHost` is kept mutable so the singleton's onStatus always
// emits on whichever host is current.
let connections: ConnectionManager | null = null
let currentHost: BackendHost | null = null

export function registerMachineHandlers(host: BackendHost): void {
  currentHost = host
  if (!connections) {
    connections = new ConnectionManager({
      allocatePort,
      allocateIdePort: stableIdePort,
      remoteIdePort: REMOTE_IDE_PORT,
      spawnTunnel,
      waitForHealth,
      remotePort: REMOTE_PORT,
      remoteCommand: REMOTE_COMMAND,
      provision: makeProvision((msg) => log.info(msg)),
      maxReconnects: 5,
      onLog: (msg) => log.error(msg),
      onStatus: (machineId, status, url, reason, willRetry, idePort) => {
        log.info(`status ${machineId}: ${status}${url ? ` (${url})` : ''}${reason ? ` - ${reason}` : ''}${willRetry ? ' (will retry)' : ''}${idePort ? ` idePort=${idePort}` : ''}`)
        currentHost?.emit(MachineChannels.STATUS, machineId, status, url, reason, willRetry, idePort)
      },
    })
  }
  const mgr = connections

  host.handle(MachineChannels.CONNECT, (id: string) => {
    log.info(`connect requested: ${id}`)
    const machine = listMachines().find((m) => m.id === id)
    if (!machine) return { ok: false as const, error: 'unknown machine' }
    void mgr.connect(machine)
    return { ok: true as const }
  })

  host.handle(MachineChannels.LIST, () => listMachines())

  host.handle(MachineChannels.CREATE, (input: MachineInput) => createMachine(input, Date.now()))

  host.handle(MachineChannels.UPDATE, (id: string, patch: Partial<MachineInput>) =>
    updateMachine(id, patch, Date.now()),
  )

  host.handle(MachineChannels.DELETE, async (id: string) => {
    // Kill any live tunnel first, or it keeps auto-reconnecting a deleted machine.
    await mgr.disconnect(id)
    deleteMachine(id)
    return { ok: true }
  })

  host.handle(MachineChannels.REORDER, (ids: string[]) => {
    reorderMachines(ids, Date.now())
    return { ok: true }
  })

  host.handle(MachineChannels.GET_STATUSES, () => mgr.statuses())

  host.handle(MachineChannels.GET_SNAPSHOTS, () => getMachineSnapshots())

  host.handle(MachineChannels.SAVE_SNAPSHOT, (id: string, snapshot: MachineSnapshot) => {
    saveMachineSnapshot(id, snapshot)
    return { ok: true as const }
  })


  host.handle(MachineChannels.DISCONNECT, async (id: string) => {
    await mgr.disconnect(id)
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

/**
 * Kill every live tunnel. Call from `before-quit` - without this, ssh
 * reparents to launchd on app exit and both the tunnel and the remote server
 * it forwards to outlive Switchboard.
 */
export function stopAllMachineConnections(): Promise<void> {
  return connections?.disconnectAll() ?? Promise.resolve()
}
