/**
 * A quit that lands while ENSURE is booting closes the database under it. The
 * failure that follows is the shutdown, so ENSURE reports `shutting-down`
 * rather than an IDE error.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sb-ide-shutdown-test' } }))
vi.mock('../../src/main/logger', () => ({ createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))
vi.mock('../../src/main/path-access', () => ({ assertCwdReadable: async () => {} }))
vi.mock('../../src/main/db/database', () => ({ getSetting: () => null, setSetting: () => {} }))
const quit = vi.hoisted(() => ({ begin: () => {} }))
vi.mock('../../src/main/ide/binary', () => ({
  ensureBinary: async () => {
    quit.begin()
    throw new Error('The database connection is not open')
  },
}))

import { IdeChannels } from '../../src/shared/ipc-channels'
import { registerIdeHandlers, shutdownIde } from '../../src/main/ipc/ide'

describe('IDE ENSURE during quit', () => {
  it('reports shutting-down when the boot fails because quit began', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const host = { handle: (ch: string, fn: (...args: unknown[]) => unknown) => handlers.set(ch, fn), on: () => {}, send: () => {} }
    quit.begin = shutdownIde
    registerIdeHandlers(host as never)
    expect(await handlers.get(IdeChannels.ENSURE)!('/tmp/project')).toEqual({ ok: false, error: 'shutting-down' })
  })
})
