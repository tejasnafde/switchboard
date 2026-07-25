import { describe, it, expect, vi } from 'vitest'
import { PtyManager } from '../../src/main/terminal/pty-manager'

/**
 * Regression test for the 0.7.21 crash-on-restart-and-install: killAll()
 * must actually wait for each pty to exit (bounded by a timeout) instead
 * of firing the kill signal and returning immediately - a caller that
 * tears down the Node env right after killAll() resolves would otherwise
 * race a still-live node-pty native callback and abort() the process.
 *
 * We inject fake `ManagedPty` entries directly into the private map
 * instead of going through `create()`, since that dynamically imports
 * the real `node-pty` native module (compiled for Electron, not plain
 * Node/vitest).
 */
function injectFakePty(manager: PtyManager, id: string, kill: () => void, onExit: (cb: () => void) => void) {
  const ptys: Map<string, unknown> = (manager as unknown as { ptys: Map<string, unknown> }).ptys
  ptys.set(id, { pty: { kill, onExit }, id })
}

describe('PtyManager.killAll', () => {
  it('resolves once every pty has actually exited', async () => {
    const manager = new PtyManager(
      () => {},
      () => {},
    )
    let exitCb: (() => void) | undefined
    injectFakePty(
      manager,
      'a',
      () => {}, // kill() sends the signal but doesn't exit synchronously
      (cb) => {
        exitCb = cb
      },
    )

    const done = manager.killAll()
    let resolved = false
    void done.then(() => {
      resolved = true
    })

    await Promise.resolve()
    expect(resolved).toBe(false) // still waiting on the real exit

    exitCb?.()
    await done
    expect(resolved).toBe(true)
  })

  it('gives up waiting on a wedged pty after the bounded timeout', async () => {
    vi.useFakeTimers()
    try {
      const manager = new PtyManager(
        () => {},
        () => {},
      )
      injectFakePty(
        manager,
        'stuck',
        () => {}, // kill() is a no-op - onExit never fires
        () => {},
      )

      const done = manager.killAll()
      let resolved = false
      void done.then(() => {
        resolved = true
      })

      await vi.advanceTimersByTimeAsync(1500)
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
