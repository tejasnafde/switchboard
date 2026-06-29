/**
 * ConnectionManager: drives a remote machine connect/disconnect lifecycle from
 * injected deps (port alloc, ssh spawn, health probe) so the orchestration is
 * tested without real ssh or sockets. Node-specific deps live in ipc/machines.
 */
import { describe, it, expect, vi } from 'vitest'
import { ConnectionManager, type ConnectionManagerDeps, type TunnelProcess } from '../../src/main/machines/connectionManager'
import type { Machine } from '@shared/machines'

const machine = (over: Partial<Machine> = {}): Machine => ({
  id: 'm1', name: 'prod', sshAlias: 'prod-vm', sshHost: '10.0.0.4', sshUser: 'ubuntu',
  sshPort: 22, sortOrder: 0, createdAt: 0, updatedAt: 0, ...over,
})

function fakeProc(): TunnelProcess & { fireExit: () => void } {
  let onExit = () => {}
  return {
    kill: vi.fn(),
    onExit: (cb) => { onExit = cb },
    fireExit: () => onExit(),
  }
}

function deps(over: Partial<ConnectionManagerDeps> = {}): ConnectionManagerDeps & { statuses: Array<[string, string]> } {
  const statuses: Array<[string, string]> = []
  return {
    allocatePort: async () => 7681,
    spawnTunnel: () => fakeProc(),
    waitForHealth: async () => true,
    remotePort: 8765,
    remoteCommand: 'switchboard-server',
    onStatus: (id, status) => statuses.push([id, status]),
    statuses,
    ...over,
  }
}

describe('ConnectionManager', () => {
  it('connect goes connecting then connected when health passes', async () => {
    const d = deps()
    const mgr = new ConnectionManager(d)
    await mgr.connect(machine())
    expect(d.statuses).toEqual([['m1', 'connecting'], ['m1', 'connected']])
    expect(mgr.statusOf('m1')).toBe('connected')
  })

  it('exposes the local ws url of a connected machine for transport routing', async () => {
    const mgr = new ConnectionManager(deps())
    await mgr.connect(machine())
    expect(mgr.urlOf('m1')).toBe('ws://127.0.0.1:7681')
  })

  it('forwards the allocated local port to the configured remote port', async () => {
    const spawnTunnel = vi.fn(() => fakeProc())
    await new ConnectionManager(deps({ spawnTunnel })).connect(machine())
    const [command, args] = spawnTunnel.mock.calls[0]
    expect(command).toBe('ssh')
    expect(args).toContain('7681:127.0.0.1:8765')
    expect(args[args.length - 1]).toBe('switchboard-server')
  })

  it('goes to error and kills the tunnel when health never passes', async () => {
    const proc = fakeProc()
    const d = deps({ spawnTunnel: () => proc, waitForHealth: async () => false })
    const mgr = new ConnectionManager(d)
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('error')
    expect(proc.kill).toHaveBeenCalled()
    expect(d.statuses.map((s) => s[1])).toEqual(['connecting', 'error'])
  })

  it('disconnect kills the tunnel and returns to offline', async () => {
    const proc = fakeProc()
    const mgr = new ConnectionManager(deps({ spawnTunnel: () => proc }))
    await mgr.connect(machine())
    await mgr.disconnect('m1')
    expect(proc.kill).toHaveBeenCalled()
    expect(mgr.statusOf('m1')).toBe('offline')
    expect(mgr.urlOf('m1')).toBeNull()
  })

  it('a tunnel exit while connected drops the machine to error', async () => {
    const proc = fakeProc()
    const d = deps({ spawnTunnel: () => proc })
    const mgr = new ConnectionManager(d)
    await mgr.connect(machine())
    proc.fireExit()
    expect(mgr.statusOf('m1')).toBe('error')
  })

  it('a second connect on an already-connected machine is a no-op', async () => {
    const spawnTunnel = vi.fn(() => fakeProc())
    const mgr = new ConnectionManager(deps({ spawnTunnel }))
    await mgr.connect(machine())
    await mgr.connect(machine())
    expect(spawnTunnel).toHaveBeenCalledTimes(1)
  })
})
