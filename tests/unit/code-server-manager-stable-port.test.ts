import { describe, it, expect } from 'vitest'
import { CodeServerManager, type ChildLike, type ManagerDeps } from '../../src/main/ide/code-server-manager'

/**
 * The workbench origin must be STABLE across app restarts: extension
 * globalState and secrets in VS Code web live in the webview's IndexedDB,
 * which is scoped to scheme+host+port. A fresh random port per launch
 * orphaned all extension state every restart (atlascode re-onboarding,
 * lost auth, forgotten kernel picks).
 */

class FakeChild implements ChildLike {
  exitCb: ((code: number | null) => void) | null = null
  on(_event: 'exit', cb: (code: number | null) => void): void {
    this.exitCb = cb
  }
  kill(): void {}
}

const deps = (opts: { healthyPorts?: number[]; earlyExitPorts?: number[] } = {}): ManagerDeps & { spawnedPorts: number[] } => {
  const spawnedPorts: number[] = []
  let next = 60000
  return {
    spawnedPorts,
    spawn: (_bin, args) => {
      const port = Number(args[args.indexOf('--bind-addr') + 1].split(':')[1])
      spawnedPorts.push(port)
      const child = new FakeChild()
      if (opts.earlyExitPorts?.includes(port)) queueMicrotask(() => child.exitCb?.(1))
      return child
    },
    allocatePort: async () => next++,
    probeHealth: async (url) => {
      const port = Number(new URL(url).port)
      return !(opts.earlyExitPorts?.includes(port)) && (opts.healthyPorts?.includes(port) ?? true)
    },
    delay: async () => {},
  }
}

const cfg = { binaryPath: '/bin/cs', extensionsDir: '/ext', userDataDir: '/data', env: {} }

describe('CodeServerManager stable port', () => {
  it('binds the preferred port when it is available', async () => {
    const d = deps()
    const manager = new CodeServerManager(d, { ...cfg, preferredPort: 41234 })

    const port = await manager.ensureStarted()

    expect(port).toBe(41234)
    expect(d.spawnedPorts).toEqual([41234])
  })

  it('falls back to a fresh port when the preferred port is taken (EADDRINUSE early exit)', async () => {
    const d = deps({ earlyExitPorts: [41234] })
    const manager = new CodeServerManager(d, { ...cfg, preferredPort: 41234 })

    const port = await manager.ensureStarted()

    expect(port).toBe(60000)
    expect(d.spawnedPorts).toEqual([41234, 60000])
  })

  it('allocates dynamically when no preferred port is configured (existing behavior)', async () => {
    const d = deps()
    const manager = new CodeServerManager(d, cfg)

    const port = await manager.ensureStarted()

    expect(port).toBe(60000)
  })
})

describe('needsJupyterSeed', () => {
  it('detects presence/absence of the notebook extension stack', async () => {
    const { mkdtempSync, rmSync, mkdirSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { needsJupyterSeed } = await import('../../src/main/ide/code-server-manager')

    const dir = mkdtempSync(join(tmpdir(), 'sb-ext-seed-test-'))
    try {
      expect(needsJupyterSeed(join(dir, 'missing'))).toBe(true)
      expect(needsJupyterSeed(dir)).toBe(true)
      mkdirSync(join(dir, 'ms-toolsai.jupyter-2025.9.1'))
      expect(needsJupyterSeed(dir)).toBe(true) // python still missing
      mkdirSync(join(dir, 'ms-python.python-2026.4.0-universal'))
      expect(needsJupyterSeed(dir)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
