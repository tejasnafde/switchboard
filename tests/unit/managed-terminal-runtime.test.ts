import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FileManagedTerminalCommandLedger,
  ManagedTerminalRuntime,
  type ManagedTerminalCommandLedger,
  type ManagedTerminalBackend,
} from '../../src/main/terminal/managed-terminal-runtime'

function fixture() {
  const live = new Set<string>()
  const backend: ManagedTerminalBackend = {
    has: vi.fn((id) => live.has(id)),
    create: vi.fn(async (options) => {
      live.add(options.id)
    }),
  }
  return { backend, live, runtime: new ManagedTerminalRuntime(() => backend) }
}

describe('ManagedTerminalRuntime', () => {
  it('persists opaque command claims without storing terminal ids or command text', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sb-terminal-ledger-'))
    try {
      const first = new FileManagedTerminalCommandLedger(() => directory)
      const recovered = new FileManagedTerminalCommandLedger(() => directory)

      await expect(first.claim('terminal-with-private-command')).resolves.not.toBeNull()
      await expect(recovered.claim('terminal-with-private-command')).resolves.toBeNull()

      const files = readdirSync(directory)
      expect(files).toHaveLength(1)
      expect(files[0]).not.toContain('private')
      expect(readFileSync(join(directory, files[0]), 'utf8')).toBe('')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('releases a claim receipt after a definite pre-spawn failure so retry keeps the initial command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'sb-terminal-ledger-'))
    try {
      const ledger = new FileManagedTerminalCommandLedger(() => directory)
      const live = new Set<string>()
      let attempts = 0
      const backend: ManagedTerminalBackend = {
        has: (id) => live.has(id),
        create: vi.fn(async (options) => {
          attempts += 1
          if (attempts === 1) throw new Error('spawn rejected before creating a PTY')
          live.add(options.id)
        }),
      }
      const runtime = new ManagedTerminalRuntime(() => backend, ledger)
      const terminal = {
        id: 'worktree-retry-r0-p0',
        cwd: '/managed/repo',
        initialCommand: 'private-start-command',
      }

      await expect(runtime.provision([terminal])).resolves.toEqual({ status: 'failed', terminalIds: [] })
      await expect(runtime.provision([terminal])).resolves.toEqual({
        status: 'succeeded',
        terminalIds: [terminal.id],
      })

      expect(backend.create).toHaveBeenNthCalledWith(1, terminal)
      expect(backend.create).toHaveBeenNthCalledWith(2, terminal)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('adopts stable live handles instead of spawning duplicates', async () => {
    const h = fixture()
    const terminals = [{
      id: 'worktree-a-r0-p0',
      cwd: '/managed/repo',
      initialCommand: 'npm run dev',
    }]

    await expect(h.runtime.provision(terminals)).resolves.toEqual({
      status: 'succeeded',
      terminalIds: ['worktree-a-r0-p0'],
    })
    await expect(h.runtime.provision(terminals)).resolves.toEqual({
      status: 'succeeded',
      terminalIds: ['worktree-a-r0-p0'],
    })

    expect(h.backend.create).toHaveBeenCalledOnce()
  })

  it('coalesces concurrent provisioning for the same stable handle', async () => {
    const h = fixture()
    let release!: () => void
    h.backend.create = vi.fn(async (options) => {
      await new Promise<void>((resolve) => { release = resolve })
      h.live.add(options.id)
    })
    const terminals = [{
      id: 'worktree-a-r0-p0',
      cwd: '/managed/repo',
      initialCommand: 'npm run dev',
    }]

    const first = h.runtime.provision(terminals)
    const second = h.runtime.provision(terminals)
    await vi.waitFor(() => expect(h.backend.create).toHaveBeenCalledOnce())
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { status: 'succeeded', terminalIds: ['worktree-a-r0-p0'] },
      { status: 'succeeded', terminalIds: ['worktree-a-r0-p0'] },
    ])
    expect(h.backend.create).toHaveBeenCalledOnce()
  })

  it('never executes an initial command twice for the same stable handle', async () => {
    const h = fixture()
    const terminal = {
      id: 'worktree-a-r0-p0',
      cwd: '/managed/repo',
      initialCommand: 'secret startup command',
    }

    await h.runtime.provision([terminal])
    h.live.delete(terminal.id)
    await h.runtime.provision([terminal])

    expect(h.backend.create).toHaveBeenCalledTimes(2)
    expect(h.backend.create).toHaveBeenNthCalledWith(1, terminal)
    expect(h.backend.create).toHaveBeenNthCalledWith(2, {
      id: terminal.id,
      cwd: terminal.cwd,
    })
  })

  it('preserves command at-most-once semantics across runtime recovery', async () => {
    const h = fixture()
    const claimed = new Set<string>()
    const ledger: ManagedTerminalCommandLedger = {
      claim: vi.fn(async (id) => {
        if (claimed.has(id)) return null
        claimed.add(id)
        return { release: vi.fn(async () => { claimed.delete(id) }) }
      }),
    }
    const terminal = {
      id: 'worktree-a-r0-p0',
      cwd: '/managed/repo',
      initialCommand: 'secret startup command',
    }

    await new ManagedTerminalRuntime(() => h.backend, ledger).provision([terminal])
    h.live.clear()
    await new ManagedTerminalRuntime(() => h.backend, ledger).provision([terminal])

    expect(h.backend.create).toHaveBeenNthCalledWith(1, terminal)
    expect(h.backend.create).toHaveBeenNthCalledWith(2, {
      id: terminal.id,
      cwd: terminal.cwd,
    })
    expect(ledger.claim).toHaveBeenCalledTimes(2)
  })

  it('returns already-created handles when a later terminal fails', async () => {
    const h = fixture()
    h.backend.create = vi.fn(async (options) => {
      if (options.id.endsWith('p1')) throw new Error('spawn failed')
      h.live.add(options.id)
    })

    await expect(h.runtime.provision([
      { id: 'worktree-a-r0-p0', cwd: '/managed/repo' },
      { id: 'worktree-a-r0-p1', cwd: '/managed/repo' },
    ])).resolves.toEqual({
      status: 'failed',
      terminalIds: ['worktree-a-r0-p0'],
    })
  })
})
