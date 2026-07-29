import { describe, it, expect } from 'vitest'
import { ExitDrain } from '../../src/main/terminal/exit-drain'

/**
 * ExitDrain tracks in-flight pty exits so the quit sequence can wait for
 * node-pty's ThreadSafeFunction callbacks to land on a live event loop.
 * Quitting while a callback is pending aborts the process (SIGABRT in
 * pty.node during node::FreeEnvironment - see the 0.7.28 crash report).
 */
describe('ExitDrain', () => {
  it('resolves drained immediately when nothing is pending', async () => {
    const drain = new ExitDrain()
    await expect(drain.wait(50)).resolves.toBe('drained')
  })

  it('waits for a tracked exit to settle', async () => {
    const drain = new ExitDrain()
    drain.track('pty-1')
    const result = drain.wait(500)
    drain.settle('pty-1')
    await expect(result).resolves.toBe('drained')
  })

  it('waits for ALL tracked exits, not just the first', async () => {
    const drain = new ExitDrain()
    drain.track('a')
    drain.track('b')
    const result = drain.wait(500)
    drain.settle('a')
    expect(drain.pendingCount).toBe(1)
    drain.settle('b')
    await expect(result).resolves.toBe('drained')
    expect(drain.pendingCount).toBe(0)
  })

  it('times out when an exit never settles', async () => {
    const drain = new ExitDrain()
    drain.track('stuck')
    await expect(drain.wait(20)).resolves.toBe('timed-out')
  })

  it('ignores settle for an unknown id', () => {
    const drain = new ExitDrain()
    drain.settle('never-tracked')
    expect(drain.pendingCount).toBe(0)
  })

  it('resolves multiple concurrent waiters', async () => {
    const drain = new ExitDrain()
    drain.track('x')
    const first = drain.wait(500)
    const second = drain.wait(500)
    drain.settle('x')
    await expect(first).resolves.toBe('drained')
    await expect(second).resolves.toBe('drained')
  })

  it('settle after a timed-out wait is a no-op, not a crash', async () => {
    const drain = new ExitDrain()
    drain.track('late')
    await drain.wait(10)
    expect(() => drain.settle('late')).not.toThrow()
    expect(drain.pendingCount).toBe(0)
  })
})
