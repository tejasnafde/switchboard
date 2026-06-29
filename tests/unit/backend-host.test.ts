/**
 * Pins the files-handler channel contract via a FakeHost (so a future WsHost
 * can be validated against the same set) and proves handlers run without Electron.
 */
import { describe, it, expect } from 'vitest'
import { registerFilesHandlers } from '../../src/main/ipc/files'
import { FilesChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'

class FakeHost implements BackendHost {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as (...args: unknown[]) => unknown)
  }
  on(): void {}
  emit(): void {}
}

describe('registerFilesHandlers via BackendHost', () => {
  it('registers exactly the FilesChannels set', () => {
    const host = new FakeHost()
    registerFilesHandlers(host)
    expect([...host.handlers.keys()].sort()).toEqual(Object.values(FilesChannels).sort())
  })

  it('handlers run without Electron - grep-symbol rejects a non-identifier', async () => {
    const host = new FakeHost()
    registerFilesHandlers(host)
    const grep = host.handlers.get(FilesChannels.GREP_SYMBOL)!
    expect(await grep('/repo', 'not a symbol!!')).toEqual({ ok: true, hits: [] })
  })

  it('resolve reports a missing path as not-existing', async () => {
    const host = new FakeHost()
    registerFilesHandlers(host)
    const resolveFile = host.handlers.get(FilesChannels.RESOLVE)!
    expect(await resolveFile('/repo', 'definitely/missing/xyz.txt')).toEqual({ ok: true, exists: false })
  })
})
