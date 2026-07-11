/**
 * ConnectionManager: drives a remote machine connect/disconnect lifecycle from
 * injected deps (port alloc, ssh spawn, health probe) so the orchestration is
 * tested without real ssh or sockets. Node-specific deps live in ipc/machines.
 */
import { describe, it, expect, vi } from 'vitest'
import { ConnectionManager, type ConnectionManagerDeps, type ProvisionHooks, type TunnelProcess } from '../../src/main/machines/connectionManager'
import type { Machine } from '@shared/machines'

const machine = (over: Partial<Machine> = {}): Machine => ({
  id: 'm1', name: 'prod', sshAlias: 'prod-vm', sshHost: '10.0.0.4', sshUser: 'ubuntu',
  sshPort: 22, sortOrder: 0, createdAt: 0, updatedAt: 0, ...over,
})

/** Macrotask tick - lets an in-flight attempt() progress past its awaits. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function fakeProc(): TunnelProcess & { fireExit: (reason?: string) => void } {
  let onExit: (reason?: string) => void = () => {}
  return {
    kill: vi.fn(),
    onExit: (cb) => { onExit = cb },
    fireExit: (reason?: string) => onExit(reason),
  }
}

function deps(over: Partial<ConnectionManagerDeps> = {}): ConnectionManagerDeps & { statuses: Array<[string, string]> } {
  const statuses: Array<[string, string]> = []
  return {
    allocatePort: async () => 7681,
    spawnTunnel: () => fakeProc(),
    waitForHealth: async () => ({ ok: true }),
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
    // The middle 'connecting' is the health-poll-start detail event.
    expect(d.statuses).toEqual([['m1', 'connecting'], ['m1', 'connecting'], ['m1', 'connected']])
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
    const d = deps({ spawnTunnel: () => proc, waitForHealth: async () => ({ ok: false, reason: "health check failed" }) })
    const mgr = new ConnectionManager(d)
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('error')
    expect(proc.kill).toHaveBeenCalled()
    expect(d.statuses.map((s) => s[1])).toEqual(['connecting', 'connecting', 'error'])
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

  it("surfaces the dying tunnel's stderr summary as the error reason", async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const proc = fakeProc()
    const mgr = new ConnectionManager(deps({ spawnTunnel: () => proc, onStatus }))
    await mgr.connect(machine())
    proc.fireExit('Permission denied (publickey).')
    expect(mgr.statusOf('m1')).toBe('error')
    expect(statuses.find((s) => s[1] === 'error')?.[3]).toBe('Permission denied (publickey).')
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

  it('a reconnect reuses the previous local port so the ws url stays stable through a blip', async () => {
    let fresh = 7681
    const allocatePort = vi.fn(async (preferred?: number) => preferred ?? fresh++)
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const timers: Array<() => void | Promise<void>> = []
    const mgr = new ConnectionManager(deps({ allocatePort, spawnTunnel, maxReconnects: 2, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())
    expect(mgr.urlOf('m1')).toBe('ws://127.0.0.1:7681')

    procs[0].fireExit()
    await timers[0]()
    expect(mgr.statusOf('m1')).toBe('connected')
    // The retry asked for the old port back - identical ws URL, so the
    // renderer's existing transport re-dials in place instead of being replaced.
    expect(allocatePort).toHaveBeenLastCalledWith(7681)
    expect(mgr.urlOf('m1')).toBe('ws://127.0.0.1:7681')
  })

  it('falls back to whatever fresh port the allocator returns when the old one was stolen', async () => {
    // Simulates connectDeps.allocatePort failing to re-bind the preferred port
    // (another process grabbed it during the blip) and handing back a new one.
    const allocatePort = vi.fn(async (preferred?: number) => (preferred === undefined ? 7681 : 7999))
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const timers: Array<() => void | Promise<void>> = []
    const mgr = new ConnectionManager(deps({ allocatePort, spawnTunnel, maxReconnects: 2, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())
    expect(mgr.urlOf('m1')).toBe('ws://127.0.0.1:7681')

    procs[0].fireExit()
    await timers[0]()
    expect(mgr.statusOf('m1')).toBe('connected')
    expect(mgr.urlOf('m1')).toBe('ws://127.0.0.1:7999')
    // The retry preferred the old port; the dep's fallback handed back a fresh one.
    expect(allocatePort).toHaveBeenLastCalledWith(7681)
  })

  it('a manual disconnect releases the pinned port - the next connect allocates fresh', async () => {
    const allocatePort = vi.fn(async (preferred?: number) => preferred ?? 7681)
    const mgr = new ConnectionManager(deps({ allocatePort }))
    await mgr.connect(machine())
    expect(allocatePort).toHaveBeenLastCalledWith(undefined)

    await mgr.disconnect('m1')
    await mgr.connect(machine())
    expect(allocatePort).toHaveBeenCalledTimes(2)
    expect(allocatePort).toHaveBeenLastCalledWith(undefined)
  })

  it('gives up and stays in error after maxReconnects failed retries', async () => {
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const waitForHealth = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: "health check failed" })
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
    // With retry budget left, the failed machine sits in 'reconnecting' (self-heal), not 'error'.
    expect(mgr.statusOf('m1')).toBe('reconnecting')

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

  it('surfaces the health failure reason (e.g. version mismatch) on the error transition', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const reason = 'server version mismatch (local 1.2.3, remote 0.0.1)'
    const mgr = new ConnectionManager(deps({ waitForHealth: async () => ({ ok: false, reason }), onStatus }))
    await mgr.connect(machine())
    expect(statuses.find((s) => s[1] === 'error')?.[3]).toBe(reason)
  })

  it('falls back to a generic reason when the health check gives none', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const mgr = new ConnectionManager(deps({ waitForHealth: async () => ({ ok: false }), onStatus }))
    await mgr.connect(machine())
    expect(statuses.find((s) => s[1] === 'error')?.[3]).toBe('health check failed')
  })

  it('emits no reason on a successful connect/healthy transition', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const mgr = new ConnectionManager(deps({ onStatus }))
    await mgr.connect(machine())
    expect(statuses.every((s) => s[3] === undefined)).toBe(true)
  })

  it('emits provisioning with a per-step detail while the provision steps run', async () => {
    const statuses: Array<[string, string | undefined]> = []
    const onStatus = (_id: string, status: string, _url: string | null, _reason?: string, detail?: string) =>
      statuses.push([status, detail])
    const provision = vi.fn(async (_m: Machine, hooks?: ProvisionHooks) => {
      hooks?.onProgress?.('upload server bundle')
      hooks?.onProgress?.('npm install (this can take a minute)')
      return { action: 'install' as const, reason: '' }
    })
    const mgr = new ConnectionManager(deps({ provision, onStatus }))
    await mgr.connect(machine())
    expect(statuses).toEqual([
      ['connecting', undefined],
      ['provisioning', 'upload server bundle'],
      ['provisioning', 'npm install (this can take a minute)'],
      ['connecting', 'waiting for server…'],
      ['connected', undefined],
    ])
  })

  it('skips provisioning entirely when the probe reports ready (no progress steps)', async () => {
    const statuses: string[] = []
    const onStatus = (_id: string, status: string) => statuses.push(status)
    const provision = vi.fn(async () => ({ action: 'ready' as const, reason: 'up to date' }))
    const mgr = new ConnectionManager(deps({ provision, onStatus }))
    await mgr.connect(machine())
    expect(statuses).not.toContain('provisioning')
    expect(mgr.statusOf('m1')).toBe('connected')
  })

  it('emits the health-poll start as a connecting event with a waiting detail', async () => {
    const statuses: Array<[string, string | undefined]> = []
    const onStatus = (_id: string, status: string, _url: string | null, _reason?: string, detail?: string) =>
      statuses.push([status, detail])
    const mgr = new ConnectionManager(deps({ onStatus }))
    await mgr.connect(machine())
    expect(statuses).toContainEqual(['connecting', 'waiting for server…'])
  })

  it('a drop with retry budget left emits reconnecting (not error) through the backoff wait and retry', async () => {
    const statuses: string[] = []
    const onStatus = (_id: string, status: string) => statuses.push(status)
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const timers: Array<() => void | Promise<void>> = []
    const mgr = new ConnectionManager(deps({ spawnTunnel, onStatus, maxReconnects: 2, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())

    procs[0].fireExit()
    expect(mgr.statusOf('m1')).toBe('reconnecting') // backoff wait
    await timers[0]() // the retry attempt itself must not flash 'connecting'
    expect(mgr.statusOf('m1')).toBe('connected')
    expect(statuses).not.toContain('error')
    expect(statuses.indexOf('reconnecting')).toBeGreaterThan(-1)
  })

  it('keeps error for a terminal failure with no retry budget', async () => {
    const statuses: string[] = []
    const onStatus = (_id: string, status: string) => statuses.push(status)
    const proc = fakeProc()
    const mgr = new ConnectionManager(deps({ spawnTunnel: () => proc, onStatus }))
    await mgr.connect(machine())
    proc.fireExit()
    expect(mgr.statusOf('m1')).toBe('error')
    expect(statuses).not.toContain('reconnecting')
  })

  it('disconnect during an in-flight provision kills the registered provisioning child', async () => {
    const childKill = vi.fn()
    let resolveProvision: (r: { action: string; reason: string }) => void = () => {}
    const spawnTunnel = vi.fn(() => fakeProc())
    const provision = vi.fn((_m: Machine, hooks?: ProvisionHooks) => {
      hooks?.onChild?.({ kill: childKill })
      return new Promise<{ action: string; reason: string }>((resolve) => { resolveProvision = resolve })
    })
    const mgr = new ConnectionManager(deps({ provision, spawnTunnel }))

    const connecting = mgr.connect(machine())
    await tick() // let the attempt reach the provision await
    await mgr.disconnect('m1')
    expect(childKill).toHaveBeenCalled()
    expect(mgr.statusOf('m1')).toBe('offline')

    // The provision eventually resolving must not resurrect the attempt.
    resolveProvision({ action: 'install', reason: '' })
    await connecting
    expect(spawnTunnel).not.toHaveBeenCalled()
    expect(mgr.statusOf('m1')).toBe('offline')
  })

  it('a child registered after the attempt was superseded is killed immediately', async () => {
    const childKill = vi.fn()
    let hooksRef: ProvisionHooks | undefined
    let resolveProvision: (r: { action: string; reason: string }) => void = () => {}
    const provision = vi.fn((_m: Machine, hooks?: ProvisionHooks) => {
      hooksRef = hooks
      return new Promise<{ action: string; reason: string }>((resolve) => { resolveProvision = resolve })
    })
    const mgr = new ConnectionManager(deps({ provision }))

    const connecting = mgr.connect(machine())
    await tick()
    await mgr.disconnect('m1')
    // The provisioner spawns its next step after the cancel already landed.
    hooksRef?.onChild?.({ kill: childKill })
    expect(childKill).toHaveBeenCalled()
    resolveProvision({ action: 'install', reason: '' })
    await connecting
    expect(mgr.statusOf('m1')).toBe('offline')
  })

  it('a stale progress callback after disconnect emits nothing', async () => {
    const statuses: string[] = []
    const onStatus = (_id: string, status: string) => statuses.push(status)
    let hooksRef: ProvisionHooks | undefined
    let resolveProvision: (r: { action: string; reason: string }) => void = () => {}
    const provision = vi.fn((_m: Machine, hooks?: ProvisionHooks) => {
      hooksRef = hooks
      return new Promise<{ action: string; reason: string }>((resolve) => { resolveProvision = resolve })
    })
    const mgr = new ConnectionManager(deps({ provision, onStatus }))

    const connecting = mgr.connect(machine())
    await tick()
    await mgr.disconnect('m1')
    const before = statuses.length
    hooksRef?.onProgress?.('npm install (this can take a minute)')
    expect(statuses.length).toBe(before)
    resolveProvision({ action: 'install', reason: '' })
    await connecting
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
