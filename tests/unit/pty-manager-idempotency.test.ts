import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.fn()

vi.mock('node-pty', () => ({ spawn }))

describe('PtyManager stable-handle adoption', () => {
  beforeEach(() => spawn.mockReset())

  it('does not replace an already-live PTY when the renderer adopts its stable id', async () => {
    const callbacks = { data: (_value: string) => {}, exit: (_value: { exitCode: number; signal?: number }) => {} }
    spawn.mockReturnValue({
      onData: vi.fn((callback) => { callbacks.data = callback }),
      onExit: vi.fn((callback) => { callbacks.exit = callback }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    })
    const { PtyManager } = await import('../../src/main/terminal/pty-manager')
    const manager = new PtyManager(vi.fn(), vi.fn())

    await manager.create({ id: 'managed-terminal', cwd: '/repo' })
    await manager.create({ id: 'managed-terminal', cwd: '/different' })

    expect(spawn).toHaveBeenCalledOnce()
    expect(manager.has('managed-terminal')).toBe(true)
  })
})
