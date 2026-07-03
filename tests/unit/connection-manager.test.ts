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
    // The remote command is wrapped (base64 + nvm preamble) by buildTunnelCommand.
    const last = args[args.length - 1] as string
    const b64 = /printf %s '([^']+)' \| base64 -d \| bash/.exec(last)?.[1] ?? ''
    expect(Buffer.from(b64, 'base64').toString('utf8')).toContain('switchboard-server')
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

  it('provisions before spawning the tunnel', async () => {
    const order: string[] = []
    const provision = vi.fn(async () => { order.push('provision'); return { action: 'install' as const, reason: '' } })
    const spawnTunnel = vi.fn(() => { order.push('spawn'); return fakeProc() })
    const mgr = new ConnectionManager(deps({ provision, spawnTunnel }))
    await mgr.connect(machine())
    expect(order).toEqual(['provision', 'spawn'])
    expect(mgr.statusOf('m1')).toBe('connected')
  })

  it('fails without spawning a tunnel when the remote has no node', async () => {
    const spawnTunnel = vi.fn(() => fakeProc())
    const provision = vi.fn(async () => ({ action: 'no-node' as const, reason: 'no node' }))
    const mgr = new ConnectionManager(deps({ provision, spawnTunnel }))
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('error')
    expect(spawnTunnel).not.toHaveBeenCalled()
  })

  it('fails without spawning a tunnel when provisioning throws', async () => {
    const spawnTunnel = vi.fn(() => fakeProc())
    const provision = vi.fn(async () => { throw new Error('upload failed') })
    const mgr = new ConnectionManager(deps({ provision, spawnTunnel }))
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('error')
    expect(spawnTunnel).not.toHaveBeenCalled()
  })

  it('reconnects after an established tunnel drops', async () => {
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const timers: Array<() => void> = []
    const mgr = new ConnectionManager(deps({ spawnTunnel, maxReconnects: 2, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('connected')

    procs[0].fireExit()
    expect(timers).toHaveLength(1)
    await timers[0]()
    expect(spawnTunnel).toHaveBeenCalledTimes(2)
    expect(mgr.statusOf('m1')).toBe('connected')
  })

  it('gives up and stays in error after maxReconnects failed retries', async () => {
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const waitForHealth = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const timers: Array<() => void> = []
    const mgr = new ConnectionManager(deps({ spawnTunnel, waitForHealth, maxReconnects: 1, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())

    procs[0].fireExit()
    await timers[0]() // reconnect attempt: health fails this time
    expect(mgr.statusOf('m1')).toBe('error')
    expect(timers).toHaveLength(1) // no further retry past the cap
  })

  it('does not reconnect after a deliberate disconnect', async () => {
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const timers: Array<() => void> = []
    const mgr = new ConnectionManager(deps({ spawnTunnel, maxReconnects: 2, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())
    await mgr.disconnect('m1')
    procs[0].fireExit() // the kill's exit event arrives
    expect(timers).toHaveLength(0)
    expect(mgr.statusOf('m1')).toBe('offline')
  })

  it('two rapid connect() calls on the same machine only spawn one tunnel', async () => {
    let resolvePort: (n: number) => void = () => {}
    const portPromise = new Promise<number>((resolve) => { resolvePort = resolve })
    const spawnTunnel = vi.fn(() => fakeProc())
    const mgr = new ConnectionManager(deps({ spawnTunnel, allocatePort: () => portPromise }))

    const p1 = mgr.connect(machine())
    const p2 = mgr.connect(machine()) // fires while p1 is still awaiting allocatePort()
    resolvePort(7681)
    await Promise.all([p1, p2])

    expect(spawnTunnel).toHaveBeenCalledTimes(1)
    expect(mgr.statusOf('m1')).toBe('connected')
  })

  it('a stale reconnect timer from a superseded attempt does not fire an interleaved retry', async () => {
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const timers: Array<() => void | Promise<void>> = []
    const mgr = new ConnectionManager(deps({ spawnTunnel, maxReconnects: 5, setTimer: (fn) => timers.push(fn) }))

    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('connected')

    procs[0].fireExit() // first failure schedules timers[0]
    expect(timers).toHaveLength(1)

    // Manual reconnect lands before the backoff timer fires.
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('connected')
    expect(spawnTunnel).toHaveBeenCalledTimes(2)

    procs[1].fireExit() // second failure schedules timers[1] for the new epoch
    expect(timers).toHaveLength(2)

    // The stale timer from the first failure must be a no-op now.
    await timers[0]()
    expect(spawnTunnel).toHaveBeenCalledTimes(2)
    expect(mgr.statusOf('m1')).toBe('error')

    // The current timer still drives a real retry.
    await timers[1]()
    expect(spawnTunnel).toHaveBeenCalledTimes(3)
    expect(mgr.statusOf('m1')).toBe('connected')
  })

  it('logs the provisioner error via onLog instead of swallowing it', async () => {
    const onLog = vi.fn()
    const provision = vi.fn(async () => { throw new Error('npm install failed: EACCES') })
    const mgr = new ConnectionManager(deps({ provision, onLog }))
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('error')
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('npm install failed: EACCES'))
  })

  it('a rejecting allocatePort transitions to error instead of hanging in connecting', async () => {
    const onLog = vi.fn()
    const mgr = new ConnectionManager(
      deps({ allocatePort: async () => { throw new Error('EMFILE: no free ports') }, onLog }),
    )
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('error')
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('EMFILE: no free ports'))
  })

  it('emits the provisioner error message as the reason on a provision throw', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const provision = vi.fn(async () => { throw new Error('upload failed') })
    const mgr = new ConnectionManager(deps({ provision, onStatus }))
    await mgr.connect(machine())
    expect(statuses.find((s) => s[1] === 'error')?.[3]).toBe('upload failed')
  })

  it('emits a fixed reason when provisioning reports no node runtime', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const provision = vi.fn(async () => ({ action: 'no-node' as const, reason: 'no node' }))
    const mgr = new ConnectionManager(deps({ provision, onStatus }))
    await mgr.connect(machine())
    expect(statuses.find((s) => s[1] === 'error')?.[3]).toBe('no node runtime found on the remote')
  })

  it('emits a timeout reason when the health check never passes', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const mgr = new ConnectionManager(deps({ waitForHealth: async () => false, onStatus }))
    await mgr.connect(machine())
    expect(statuses.find((s) => s[1] === 'error')?.[3]).toBe('health check failed (timeout)')
  })

  it('emits no reason on a successful connect/healthy transition', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const mgr = new ConnectionManager(deps({ onStatus }))
    await mgr.connect(machine())
    expect(statuses.every((s) => s[3] === undefined)).toBe(true)
  })

  it('disconnectAll kills every tracked tunnel', async () => {
    const procA = fakeProc()
    const procB = fakeProc()
    let calls = 0
    const spawnTunnel = vi.fn(() => (calls++ === 0 ? procA : procB))
    const mgr = new ConnectionManager(deps({ spawnTunnel }))
    await mgr.connect(machine({ id: 'a' }))
    await mgr.connect(machine({ id: 'b' }))

    await mgr.disconnectAll()

    expect(procA.kill).toHaveBeenCalled()
    expect(procB.kill).toHaveBeenCalled()
    expect(mgr.statusOf('a')).toBe('offline')
    expect(mgr.statusOf('b')).toBe('offline')
  })
})
