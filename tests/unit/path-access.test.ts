import { describe, it, expect } from 'vitest'
import { isTccProtectedPath, assertCwdReadable, TccAccessError } from '../../src/main/path-access'
import { mkdtemp, chmod, rm } from 'node:fs/promises'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

const HOME = '/Users/tester'

describe('isTccProtectedPath', () => {
  if (platform() !== 'darwin') {
    it.skip('darwin-only', () => {})
    return
  }
  it('matches Desktop/Documents/Downloads roots and children', () => {
    expect(isTccProtectedPath(`${HOME}/Desktop`, HOME)).toBe(true)
    expect(isTccProtectedPath(`${HOME}/Desktop/work/ssg`, HOME)).toBe(true)
    expect(isTccProtectedPath(`${HOME}/Documents/foo`, HOME)).toBe(true)
    expect(isTccProtectedPath(`${HOME}/Downloads`, HOME)).toBe(true)
  })
  it('does not match unrelated paths', () => {
    expect(isTccProtectedPath(`${HOME}/code/repo`, HOME)).toBe(false)
    expect(isTccProtectedPath('/tmp/foo', HOME)).toBe(false)
    expect(isTccProtectedPath(`${HOME}/DesktopSomething`, HOME)).toBe(false)
  })
})

describe('assertCwdReadable', () => {
  it('passes for non-protected paths', async () => {
    await expect(assertCwdReadable('/tmp')).resolves.toBeUndefined()
  })

  if (platform() !== 'darwin') {
    it.skip('darwin-only TCC simulation', () => {})
    return
  }

  it('throws TccAccessError on EPERM under a protected path', async () => {
    // Simulate by creating a dir under ~/Downloads (a real TCC root) and
    // dropping read perms — fs.access(R_OK) will return EACCES, which we
    // map to TccAccessError. (We can't fabricate EPERM portably, but the
    // handler treats EACCES the same.)
    const home = process.env.HOME!
    const root = join(home, 'Downloads')
    let dir: string
    try {
      dir = await mkdtemp(join(root, 'switchboard-tcc-test-'))
    } catch {
      // No write access to ~/Downloads in this env — skip.
      return
    }
    try {
      await chmod(dir, 0o000)
      await expect(assertCwdReadable(dir)).rejects.toBeInstanceOf(TccAccessError)
    } finally {
      await chmod(dir, 0o700).catch(() => {})
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
