/**
 * Pins the files-handler channel contract via a FakeHost (so a future WsHost
 * can be validated against the same set) and proves handlers run without Electron.
 */
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { registerFilesHandlers } from '../../src/main/ipc/files'
import { FilesChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import { withBackendRequestContext } from '../../src/main/backend/request-context'

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

  it('handlers run without Electron - list-dir rejects a path escaping the root', async () => {
    const host = new FakeHost()
    registerFilesHandlers(host)
    const listDir = host.handlers.get(FilesChannels.LIST_DIR)!
    const res = (await listDir('/repo', '../../etc')) as { ok: boolean; entries: unknown[] }
    expect(res.ok).toBe(false)
    expect(res.entries).toEqual([])
  })

  it('resolve reports a missing path as not-existing', async () => {
    const host = new FakeHost()
    registerFilesHandlers(host)
    const resolveFile = host.handlers.get(FilesChannels.RESOLVE)!
    expect(await resolveFile('/repo', 'definitely/missing/xyz.txt')).toEqual({ ok: true, exists: false })
  })

  it('authorizes protected config after canonical path resolution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sb-files-auth-'))
    try {
      await mkdir(join(root, '.switchboard'))
      await mkdir(join(root, 'src'))
      await symlink(join(root, '.switchboard'), join(root, 'config-alias'), 'dir')
      const host = new FakeHost()
      registerFilesHandlers(host)
      const write = host.handlers.get(FilesChannels.WRITE_FILE)!
      const asPhone = (...args: unknown[]) => withBackendRequestContext(
        { clientScope: 'phone', transport: 'remote', deviceScopes: ['chat'] },
        () => write(...args),
      )

      await expect(asPhone(join(root, '.switchboard'), 'launch-config.yaml', 'command: evil'))
        .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not permitted/i) })
      await expect(asPhone(root, 'config-alias/workspace.yaml', 'command: evil'))
        .resolves.toMatchObject({ ok: false, error: expect.stringMatching(/not permitted/i) })
      await expect(asPhone(root, 'src/ordinary.ts', 'export const safe = true'))
        .resolves.toMatchObject({ ok: true })
      await expect(readFile(join(root, 'src/ordinary.ts'), 'utf8')).resolves.toBe('export const safe = true')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
