/**
 * CodeServerManager lifecycle against an injected spawn stub - no binary, no
 * network, no real timers (delay is injected). Covers the design-doc claims:
 * one process per app, EADDRINUSE retry-once, capped health poll, respawn on
 * next open after a crash.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { CodeServerManager, type ChildLike } from '../../src/main/ide/code-server-manager'

class StubChild implements ChildLike {
  killed = false
  private exitCbs: Array<(code: number | null) => void> = []
  on(event: 'exit', cb: (code: number | null) => void): void {
    if (event === 'exit') this.exitCbs.push(cb)
  }
  kill(): void {
    this.killed = true
    this.emitExit(0)
  }
  emitExit(code: number | null): void {
    for (const cb of this.exitCbs) cb(code)
  }
}

interface Harness {
  manager: CodeServerManager
  spawned: Array<{ args: string[]; child: StubChild }>
  ports: number[]
  healthResults: boolean[]
  healthProbes: string[]
}

function makeHarness(overrides: { healthResults?: boolean[]; failFirstSpawn?: boolean } = {}): Harness {
  const spawned: Harness['spawned'] = []
  const ports = [40001, 40002, 40003]
  let portIdx = 0
  const healthResults = overrides.healthResults ?? [true]
  let healthIdx = 0
  const healthProbes: string[] = []
  const manager = new CodeServerManager(
    {
      spawn: (_binary, args) => {
        const child = new StubChild()
        spawned.push({ args, child })
        if (overrides.failFirstSpawn && spawned.length === 1) {
          // EADDRINUSE: code-server exits 1 cleanly, immediately
          queueMicrotask(() => child.emitExit(1))
        }
        return child
      },
      allocatePort: async () => ports[portIdx++],
      probeHealth: async (url) => {
        healthProbes.push(url)
        return healthResults[Math.min(healthIdx++, healthResults.length - 1)]
      },
      delay: async () => {},
    },
    {
      binaryPath: '/fake/code-server',
      extensionsDir: '/fake/ext',
      userDataDir: '/fake/data',
      env: { SB_BRIDGE_PORT: '9999', SB_BRIDGE_TOKEN: 'tok' },
    }
  )
  return { manager, spawned, ports, healthResults, healthProbes }
}

describe('CodeServerManager', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  it('spawns once and resolves the allocated port after /healthz succeeds', async () => {
    const port = await h.manager.ensureStarted()
    expect(port).toBe(40001)
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0].args).toContain('127.0.0.1:40001')
    expect(h.healthProbes[0]).toBe('http://127.0.0.1:40001/healthz')
    expect(h.manager.status).toBe('ready')
  })

  it('reuses the running process on subsequent calls (one server per app)', async () => {
    const p1 = await h.manager.ensureStarted()
    const p2 = await h.manager.ensureStarted()
    expect(p2).toBe(p1)
    expect(h.spawned).toHaveLength(1)
  })

  it('coalesces concurrent ensureStarted calls into one spawn', async () => {
    const [p1, p2] = await Promise.all([h.manager.ensureStarted(), h.manager.ensureStarted()])
    expect(p1).toBe(p2)
    expect(h.spawned).toHaveLength(1)
  })

  it('retries once on a new port when the first spawn exits before becoming healthy', async () => {
    h = makeHarness({ failFirstSpawn: true })
    const port = await h.manager.ensureStarted()
    expect(port).toBe(40002)
    expect(h.spawned).toHaveLength(2)
    expect(h.spawned[1].args).toContain('127.0.0.1:40002')
  })

  it('gives up with status error when /healthz never succeeds within the cap', async () => {
    h = makeHarness({ healthResults: [false] })
    await expect(h.manager.ensureStarted()).rejects.toThrow(/health/i)
    expect(h.manager.status).toBe('error')
    // capped: bounded probe count, not an infinite poll
    expect(h.healthProbes.length).toBeLessThanOrEqual(40)
  })

  it('respawns on the next ensureStarted after the child crashes', async () => {
    await h.manager.ensureStarted()
    h.spawned[0].child.emitExit(1)
    expect(h.manager.status).toBe('stopped')
    const port = await h.manager.ensureStarted()
    expect(h.spawned).toHaveLength(2)
    expect(port).toBe(40002)
  })

  it('stop() kills the child and returns to stopped', async () => {
    await h.manager.ensureStarted()
    h.manager.stop()
    expect(h.spawned[0].child.killed).toBe(true)
    expect(h.manager.status).toBe('stopped')
  })

  it('passes the bridge env through to spawn', async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined
    const manager = new CodeServerManager(
      {
        spawn: (_b, _a, env) => {
          seenEnv = env
          return new StubChild()
        },
        allocatePort: async () => 40001,
        probeHealth: async () => true,
        delay: async () => {},
      },
      {
        binaryPath: '/fake/code-server',
        extensionsDir: '/fake/ext',
        userDataDir: '/fake/data',
        env: { SB_BRIDGE_PORT: '9999', SB_BRIDGE_TOKEN: 'tok' },
      }
    )
    await manager.ensureStarted()
    expect(seenEnv?.SB_BRIDGE_PORT).toBe('9999')
    expect(seenEnv?.SB_BRIDGE_TOKEN).toBe('tok')
  })
})
