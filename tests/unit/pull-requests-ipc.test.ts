/**
 * The source control handlers: removing the Bitbucket account either
 * succeeds or rejects with the failure logged, never a silent success the
 * Settings card would read as "removed".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { logError, dirs } = vi.hoisted(() => ({ logError: vi.fn(), dirs: { root: '' } }))

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError }),
}))
vi.mock('../../src/main/db/database', () => ({ getProjects: () => [] }))
vi.mock('../../src/main/shell-env', () => ({ childProcessEnv: () => process.env }))
vi.mock('../../src/main/runtime', () => ({
  userDataDir: () => dirs.root,
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  }),
}))

import { registerPullRequestHandlers } from '../../src/main/ipc/pull-requests'
import { SourceControlChannels } from '../../src/shared/ipc-channels'
import { BITBUCKET_CREDENTIAL_FILE } from '../../src/main/pull-requests/credentials'

function handlers() {
  const map = new Map<string, (...args: unknown[]) => unknown>()
  registerPullRequestHandlers({
    handle: (channel, fn) => {
      map.set(channel, fn as never)
    },
    on: vi.fn(),
    emit: vi.fn(),
  })
  return map
}

beforeEach(() => {
  dirs.root = mkdtempSync(join(tmpdir(), 'sb-scm-ipc-'))
  logError.mockClear()
})
afterEach(() => rmSync(dirs.root, { recursive: true, force: true }))

describe('source-control:remove-bitbucket', () => {
  it('removes a saved account', async () => {
    const h = handlers()
    expect(
      await h.get(SourceControlChannels.SET_BITBUCKET)!({ email: 'me@example.com', apiToken: 'tok-12345678' }),
    ).toEqual({ ok: true })
    expect(await h.get(SourceControlChannels.REMOVE_BITBUCKET)!()).toEqual({ ok: true })
    expect(existsSync(join(dirs.root, BITBUCKET_CREDENTIAL_FILE))).toBe(false)
    expect(logError).not.toHaveBeenCalled()
  })

  it('logs a failed removal and still rejects', async () => {
    // A non-empty directory where the file should be: rmSync cannot remove it without recursive.
    const blocked = join(dirs.root, BITBUCKET_CREDENTIAL_FILE)
    mkdirSync(blocked, { recursive: true })
    writeFileSync(join(blocked, 'x'), 'x')
    const h = handlers()
    expect(() => h.get(SourceControlChannels.REMOVE_BITBUCKET)!()).toThrow()
    expect(logError).toHaveBeenCalledWith('removing Bitbucket credentials failed', expect.any(String))
    expect(JSON.stringify(logError.mock.calls)).not.toContain('tok-')
  })
})
