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
    waitForHealth: async () => ({ ok: true }),
    remotePort: 8765,
    remoteCommand: 'switchboard-server',
    onStatus: (id, status) => statuses.push([id, status]),
    statuses,
    ...over,
  }
}

describe('ConnectionManager', () => {
  /** Progress detail re-emits 'connecting'; collapse those for sequence checks. */
  const transitions = (statuses: Array<[string, string]>) =>
    statuses.map((s) => s[1]).filter((s, i, arr) => s !== arr[i - 1])

  it('connect goes connecting then connected when health passes', async () => {
    const d = deps()
    const mgr = new ConnectionManager(d)
    await mgr.connect(machine())
    expect(transitions(d.statuses)).toEqual(['connecting', 'connected'])
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
    expect(transitions(d.statuses)).toEqual(['connecting', 'error'])
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

  it('emits no reason on terminal transitions of a successful connect', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const mgr = new ConnectionManager(deps({ onStatus }))
    await mgr.connect(machine())
    // 'connecting' re-emissions carry progress detail in the reason slot; only
    // terminal statuses must be reason-free on success.
    expect(statuses.filter((s) => s[1] !== 'connecting').every((s) => s[3] === undefined)).toBe(true)
  })

  it('emits progress detail as repeated connecting statuses (tunnel + health + provision steps)', async () => {
    const statuses: Array<[string, string, string | null, string | undefined]> = []
    const onStatus = (id: string, status: string, url: string | null, reason?: string) =>
      statuses.push([id, status, url, reason])
    const provision = async (_m: Machine, onStep?: (label: string) => void) => {
      onStep?.('npm install (this can take a minute)')
      return { action: 'install' }
    }
    const mgr = new ConnectionManager(deps({ onStatus, provision }))
    await mgr.connect(machine())
    const details = statuses.filter((s) => s[1] === 'connecting').map((s) => s[3])
    expect(details).toContain('npm install (this can take a minute)')
    expect(details).toContain('opening ssh tunnel')
    expect(details).toContain('waiting for the remote server')
  })

  it('marks an auto-reconnecting error with willRetry, and the final give-up without it', async () => {
    const emissions: Array<{ status: string; willRetry?: boolean }> = []
    const onStatus = (_id: string, status: string, _url: string | null, _reason?: string, willRetry?: boolean) =>
      emissions.push({ status, willRetry })
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const waitForHealth = vi.fn().mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, reason: 'down' })
    const timers: Array<() => void | Promise<void>> = []
    const mgr = new ConnectionManager(deps({ onStatus, spawnTunnel, waitForHealth, maxReconnects: 1, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())

    procs[0].fireExit() // drop: schedules the one allowed retry
    expect(emissions.filter((e) => e.status === 'error').at(-1)?.willRetry).toBe(true)

    await timers[0]() // retry fails health, budget exhausted
    expect(mgr.statusOf('m1')).toBe('error')
    expect(emissions.filter((e) => e.status === 'error').at(-1)?.willRetry).toBeUndefined()
  })

  it('reuses the same local port across reconnects so the tunnel url stays stable', async () => {
    const allocatePort = vi.fn(async () => 7681)
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    const timers: Array<() => void | Promise<void>> = []
    const mgr = new ConnectionManager(deps({ allocatePort, spawnTunnel, maxReconnects: 2, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())
    const firstUrl = mgr.urlOf('m1')

    procs[0].fireExit()
    await timers[0]()
    expect(mgr.statusOf('m1')).toBe('connected')
    expect(mgr.urlOf('m1')).toBe(firstUrl)
    expect(allocatePort).toHaveBeenCalledTimes(1)
  })

  it('a manual connect after failures re-allocates the port instead of looping on a stolen one', async () => {
    let nextPort = 7681
    const allocatePort = vi.fn(async () => nextPort++)
    const waitForHealth = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'down' }).mockResolvedValue({ ok: true })
    const mgr = new ConnectionManager(deps({ allocatePort, waitForHealth }))
    await mgr.connect(machine()) // fails, no retry budget (maxReconnects 0)
    expect(mgr.statusOf('m1')).toBe('error')

    await mgr.connect(machine()) // manual retry must not inherit the old port
    expect(allocatePort).toHaveBeenCalledTimes(2)
    expect(mgr.urlOf('m1')).toBe('ws://127.0.0.1:7682')
  })

  it('a provision failure during auto-reconnect consumes the retry budget instead of dying terminally', async () => {
    const emissions: Array<{ status: string; willRetry?: boolean }> = []
    const onStatus = (_id: string, status: string, _url: string | null, _reason?: string, willRetry?: boolean) =>
      emissions.push({ status, willRetry })
    const procs: Array<ReturnType<typeof fakeProc>> = []
    const spawnTunnel = vi.fn(() => { const p = fakeProc(); procs.push(p); return p })
    // Provision succeeds on the first connect, then throws (network down) on the reconnect.
    const provision = vi.fn()
      .mockResolvedValueOnce({ action: 'ready' })
      .mockRejectedValueOnce(new Error('ssh probe failed (255)'))
      .mockResolvedValue({ action: 'ready' })
    const timers: Array<() => void | Promise<void>> = []
    const mgr = new ConnectionManager(deps({ onStatus, spawnTunnel, provision, maxReconnects: 3, setTimer: (fn) => timers.push(fn) }))
    await mgr.connect(machine())
    expect(mgr.statusOf('m1')).toBe('connected')

    procs[0].fireExit() // drop -> schedules retry 1
    await timers[0]()   // retry 1: provision throws -> must schedule retry 2, not die
    expect(emissions.filter((e) => e.status === 'error').at(-1)?.willRetry).toBe(true)
    expect(timers).toHaveLength(2)

    await timers[1]()   // retry 2: provision ready again -> reconnects
    expect(mgr.statusOf('m1')).toBe('connected')
  })

  it('surfaces the tunnel exitReason on a drop-to-error transition', async () => {
    const reasons: Array<string | undefined> = []
    const onStatus = (_id: string, status: string, _url: string | null, reason?: string) => {
      if (status === 'error') reasons.push(reason)
    }
    const proc = { ...fakeProc(), exitReason: () => 'tunnel closed: Permission denied (publickey).' }
    const mgr = new ConnectionManager(deps({ onStatus, spawnTunnel: () => proc }))
    await mgr.connect(machine())
    proc.fireExit()
    expect(reasons).toEqual(['tunnel closed: Permission denied (publickey).'])
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

describe('remote IDE forward', () => {
  it('allocates the machine-stable IDE port, forwards it, and exposes it when connected', async () => {
    const spawned: string[][] = []
    const d = deps({
      allocateIdePort: async (id) => (id === 'm1' ? 41800 : 0),
      remoteIdePort: 8766,
      spawnTunnel: (_cmd, args) => {
        spawned.push(args)
        return fakeProc()
      },
    })
    const mgr = new ConnectionManager(d)
    await mgr.connect(machine())

    const forwards = spawned[0].filter((_, i) => spawned[0][i - 1] === '-L')
    expect(forwards).toEqual(['7681:127.0.0.1:8765', '41800:127.0.0.1:8766'])
    expect(mgr.idePortOf('m1')).toBe(41800)
    expect(mgr.statuses().m1.idePort).toBe(41800)
  })

  it('without allocateIdePort the tunnel keeps its single forward and idePort is null', async () => {
    const spawned: string[][] = []
    const mgr = new ConnectionManager(
      deps({
        spawnTunnel: (_cmd, args) => {
          spawned.push(args)
          return fakeProc()
        },
      })
    )
    await mgr.connect(machine())

    expect(spawned[0].filter((a) => a === '-L')).toHaveLength(1)
    expect(mgr.idePortOf('m1')).toBeNull()
  })

  it('idePort is not exposed while disconnected', async () => {
    const d = deps({ allocateIdePort: async () => 41800, remoteIdePort: 8766 })
    const mgr = new ConnectionManager(d)
    await mgr.connect(machine())
    await mgr.disconnect('m1')
    expect(mgr.idePortOf('m1')).toBeNull()
  })

  it('rotates the IDE port after a tunnel failure instead of colliding forever', async () => {
    let idePortCalls = 0
    let proc: ReturnType<typeof fakeProc>
    const d = deps({
      allocateIdePort: async () => 41800 + idePortCalls++,
      remoteIdePort: 8766,
      maxReconnects: 1,
      reconnectDelayMs: () => 0,
      setTimer: (fn) => void fn(),
      spawnTunnel: () => {
        proc = fakeProc()
        return proc
      },
      waitForHealth: async () => {
        proc.fireExit() // tunnel dies (e.g. ExitOnForwardFailure on the IDE port)
        return { ok: false, reason: 'tunnel exited' }
      },
    })
    const mgr = new ConnectionManager(d)
    await mgr.connect(machine())

    expect(idePortCalls).toBeGreaterThanOrEqual(2) // re-allocated, not reused
  })
})
