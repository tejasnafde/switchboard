import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rename, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RENAME_RETRY_DELAYS_MS, TargetChangedError, replaceFile, type ReplaceFileOps } from '../../src/main/files/replace-file'

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

  it('throws the lock error once the retries run out, leaving the target as it was', async () => {
    const { dir, target, ops, sleep, log } = setup(Infinity, 'EBUSY')
    writeFileSync(target, 'old')
    await expect(replaceFile(target, 'new', { log, ops, sleep })).rejects.toMatchObject({ code: 'EBUSY' })
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(ops.rename).toHaveBeenCalledTimes(RENAME_RETRY_DELAYS_MS.length + 1)
    expect(RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500)
    expect(log.warn).toHaveBeenLastCalledWith(expect.stringContaining('left as it was'))
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('does not retry an error that is not a lock', async () => {
    const { dir, target, ops, sleep, log } = setup(Infinity, 'ENOSPC')
    await expect(replaceFile(target, 'new', { log, ops, sleep })).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(ops.rename).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it('removes a partly written temp file when its write fails', async () => {
    const { dir, target, ops, sleep, log } = setup(0)
    ops.writeFile = async (path, content) => {
      await writeFile(path, content.slice(0, 1), 'utf8')
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
    }
    await expect(replaceFile(target, 'new', { log, ops, sleep })).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(ops.rename).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it('does not treat a locked temp write as a locked rename', async () => {
    const { dir, target, ops, sleep, log } = setup(0)
    writeFileSync(target, 'old')
    ops.writeFile = async () => { throw locked() }
    await expect(replaceFile(target, 'new', { log, ops, sleep })).rejects.toMatchObject({ code: 'EPERM' })
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('keeps retrying while the target is unchanged', async () => {
    const { target, ops, sleep, log } = setup(2)
    writeFileSync(target, 'old')
    const stillSafe = vi.fn(async () => readFileSync(target, 'utf8') === 'old')
    await replaceFile(target, 'new', { log, ops, sleep, stillSafe })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(stillSafe).toHaveBeenCalledTimes(2)
  })

  it('leaves a target edited between retries alone', async () => {
    const { dir, target, ops, sleep, log } = setup(Infinity)
    writeFileSync(target, 'old')
    sleep.mockImplementationOnce(async () => { writeFileSync(target, 'edited') })
    const stillSafe = async () => readFileSync(target, 'utf8') === 'old'
    await expect(replaceFile(target, 'new', { log, ops, sleep, stillSafe })).rejects.toBeInstanceOf(TargetChangedError)
    expect(ops.rename).toHaveBeenCalledTimes(1)
    expect(readFileSync(target, 'utf8')).toBe('edited')
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('checks the target before every retry, not after the last one', async () => {
    const { target, ops, sleep, log } = setup(Infinity)
    writeFileSync(target, 'old')
    const stillSafe = vi.fn(async () => true)
    await expect(replaceFile(target, 'new', { log, ops, sleep, stillSafe })).rejects.toMatchObject({ code: 'EPERM' })
    expect(stillSafe).toHaveBeenCalledTimes(RENAME_RETRY_DELAYS_MS.length)
    expect(readFileSync(target, 'utf8')).toBe('old')
  })
})
