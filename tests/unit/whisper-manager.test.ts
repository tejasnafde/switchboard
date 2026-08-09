/**
 * WhisperServerManager lifecycle (src/main/stt/whisper-manager.ts): shared
 * boot, EADDRINUSE retry-once, crash-then-respawn, idle shutdown. All deps are
 * injected, so no binary and no sockets.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildWhisperServerArgs,
  WhisperServerManager,
  type ChildLike,
  type WhisperManagerDeps,
} from '../../src/main/stt/whisper-manager'

class FakeChild implements ChildLike {
  killed = false
  private exitCbs: Array<(code: number | null) => void> = []
  on(_event: 'exit', cb: (code: number | null) => void): void {
    this.exitCbs.push(cb)
  }
  kill(): void {
    this.killed = true
    this.exit(null) // mirrors a real child: kill leads to an exit event
  }
  exit(code: number | null): void {
    for (const cb of this.exitCbs) cb(code)
  }
}

function makeHarness(opts: { healthy?: (attempt: number) => boolean } = {}) {
  const children: FakeChild[] = []
  const spawn = vi.fn((): ChildLike => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
  let nextPort = 9000
  let probes = 0
  const deps: WhisperManagerDeps = {
    spawn: (bin, args, env) => spawn(bin, args, env),
    allocatePort: vi.fn(async () => nextPort++),
    probeHealth: vi.fn(async () => (opts.healthy ?? (() => true))(probes++)),
    delay: async () => {},
  }
  return { children, spawn, deps, allocate: deps.allocatePort as ReturnType<typeof vi.fn> }
}

const cfg = { binaryPath: '/bin/whisper-server', modelPath: '/models/m.bin', env: {} }

describe('buildWhisperServerArgs', () => {
  it('binds loopback with the model and auto language detection', () => {
    expect(buildWhisperServerArgs({ port: 9001, modelPath: '/m.bin' })).toEqual([
      '--host', '127.0.0.1', '--port', '9001', '--model', '/m.bin', '--language', 'auto',
    ])
  })
})

describe('WhisperServerManager', () => {
  it('boots once and reuses the port for later callers', async () => {
    const h = makeHarness()
    const mgr = new WhisperServerManager(h.deps, cfg)
    const [a, b] = await Promise.all([mgr.ensureStarted(), mgr.ensureStarted()])
    expect(a).toBe(9000)
    expect(b).toBe(9000)
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(mgr.status).toBe('ready')
    expect(await mgr.ensureStarted()).toBe(9000)
    expect(h.spawn).toHaveBeenCalledTimes(1)
    mgr.stop()
  })

  it('retries once on a fresh port when the child exits during boot', async () => {
    const h = makeHarness()
    let first = true
    h.deps.probeHealth = async () => {
      if (first) {
        first = false
        h.children[0].exit(1) // EADDRINUSE-style early death
        return false
      }
      return true
    }
    const mgr = new WhisperServerManager(h.deps, cfg)
    const port = await mgr.ensureStarted()
    expect(port).toBe(9001)
    expect(h.spawn).toHaveBeenCalledTimes(2)
    expect(mgr.status).toBe('ready')
    mgr.stop()
  })

  it('does not retry a health timeout with a live process, and kills it', async () => {
    const h = makeHarness({ healthy: () => false })
    const mgr = new WhisperServerManager(h.deps, cfg)
    await expect(mgr.ensureStarted()).rejects.toThrow('never answered')
    expect(h.spawn).toHaveBeenCalledTimes(1)
    expect(h.children[0].killed).toBe(true)
    expect(mgr.status).toBe('error')
  })

  it('respawns after a crash and reports the exit', async () => {
    const h = makeHarness()
    const onExit = vi.fn()
    const mgr = new WhisperServerManager(h.deps, { ...cfg, onExit })
    await mgr.ensureStarted()
    h.children[0].exit(1) // crash after ready
    expect(onExit).toHaveBeenCalledTimes(1)
    expect(mgr.status).toBe('stopped')
    const port = await mgr.ensureStarted()
    expect(port).toBe(9001)
    expect(h.spawn).toHaveBeenCalledTimes(2)
    mgr.stop()
  })

  it('stops itself after the idle window and does not report that as a crash', async () => {
    const h = makeHarness()
    const onExit = vi.fn()
    const mgr = new WhisperServerManager(h.deps, { ...cfg, onExit, idleStopMs: 5 })
    await mgr.ensureStarted()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(h.children[0].killed).toBe(true)
    expect(mgr.status).toBe('stopped')
    expect(onExit).not.toHaveBeenCalled()
  })

  it('touch() defers the idle stop', async () => {
    const h = makeHarness()
    const mgr = new WhisperServerManager(h.deps, { ...cfg, idleStopMs: 50 })
    await mgr.ensureStarted()
    await new Promise((resolve) => setTimeout(resolve, 30))
    mgr.touch()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.children[0].killed).toBe(false)
    mgr.stop()
    expect(h.children[0].killed).toBe(true)
  })
})
