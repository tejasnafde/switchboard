import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RENAME_RETRY_DELAYS_MS, replaceFile, type ReplaceFileOps } from '../../src/main/files/replace-file'

const locked = (code = 'EPERM') => Object.assign(new Error(`${code}: operation not permitted, rename`), { code })

let dir: string | null = null
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

/** Real fs, with a rename that fails the way Windows does while the target is open. */
function setup(renameFailures: number, code = 'EPERM') {
  dir = mkdtempSync(join(tmpdir(), 'sb-replace-file-test-'))
  const target = join(dir, 'settings.json')
  let calls = 0
  const ops: ReplaceFileOps = {
    writeFile: (path, content) => writeFile(path, content, 'utf8'),
    rename: vi.fn(async (from: string, to: string) => {
      if (calls++ < renameFailures) throw locked(code)
      await rename(from, to)
    }),
    unlink,
  }
  const sleep = vi.fn(async () => {})
  const log = { warn: vi.fn() }
  return { dir, target, ops, sleep, log }
}

describe('replaceFile', () => {
  it('retries a locked rename and lands the content atomically', async () => {
    const { dir, target, ops, sleep, log } = setup(2)
    await replaceFile(target, 'new', { log, ops, sleep })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(ops.rename).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(RENAME_RETRY_DELAYS_MS.slice(0, 2))
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('writes in place once the retries run out, and removes the temp file', async () => {
    const { dir, target, ops, sleep, log } = setup(Infinity, 'EBUSY')
    await replaceFile(target, 'new', { log, ops, sleep })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(ops.rename).toHaveBeenCalledTimes(RENAME_RETRY_DELAYS_MS.length + 1)
    expect(RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500)
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('writing it in place'))
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('does not retry an error that is not a lock', async () => {
    const { dir, target, ops, sleep, log } = setup(Infinity, 'ENOSPC')
    await expect(replaceFile(target, 'new', { log, ops, sleep })).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(ops.rename).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })
})
