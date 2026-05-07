/**
 * Tests for the mergiraf detection / driver-config helpers and the
 * one-shot rerere enabler. Both modules shell out to git / `which`,
 * which we mock via injected runners. Filesystem reads/writes also
 * injectable so tests don't touch real `.gitattributes`.
 */

import { describe, it, expect, vi } from 'vitest'
import {
  detectMergiraf,
  installMergirafDriver,
  ensureGitattributesEntry,
} from '../../src/main/branches/mergeDriver'
import { enableRerere, isRerereEnabled } from '../../src/main/branches/rerere'

describe('detectMergiraf', () => {
  it('reports found + version when which succeeds and --version returns', async () => {
    const which = vi.fn(async (cmd: string) => {
      if (cmd === 'mergiraf') return '/opt/homebrew/bin/mergiraf'
      throw new Error(`unexpected which: ${cmd}`)
    })
    const runner = vi.fn(async () => ({ stdout: 'mergiraf 0.5.0\n', stderr: '' }))
    const result = await detectMergiraf({ which, runner })
    expect(result.found).toBe(true)
    expect(result.path).toBe('/opt/homebrew/bin/mergiraf')
    expect(result.version).toBe('mergiraf 0.5.0')
  })

  it('reports not found when which throws', async () => {
    const which = vi.fn(async () => { throw new Error('not in PATH') })
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const result = await detectMergiraf({ which, runner })
    expect(result.found).toBe(false)
    expect(result.path).toBeUndefined()
  })

  it('reports found-but-no-version when --version flakes', async () => {
    const which = vi.fn(async () => '/usr/bin/mergiraf')
    const runner = vi.fn(async () => { throw new Error('crash') })
    const result = await detectMergiraf({ which, runner })
    expect(result.found).toBe(true)
    expect(result.version).toBeUndefined()
  })
})

describe('installMergirafDriver', () => {
  it('writes both git config keys (name + driver)', async () => {
    const calls: Array<string[]> = []
    const runner = vi.fn(async (args: string[]) => {
      calls.push(args)
      return { stdout: '', stderr: '' }
    })
    await installMergirafDriver('/repo', runner)
    expect(calls).toEqual([
      ['config', 'merge.mergiraf.name', 'mergiraf AST-aware merge'],
      ['config', 'merge.mergiraf.driver', 'mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P'],
    ])
  })
})

describe('ensureGitattributesEntry', () => {
  it('creates a fresh .gitattributes when none exists', async () => {
    const written: Record<string, string> = {}
    const readFile = vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })
    const writeFile = vi.fn(async (p: string, c: string) => { written[p] = c })
    await ensureGitattributesEntry('/repo', { readFile, writeFile })
    expect(Object.keys(written)).toHaveLength(1)
    expect(Object.values(written)[0]).toContain('* merge=mergiraf')
  })

  it('appends if not present', async () => {
    const readFile = vi.fn(async () => '*.lock binary\n')
    const writes: Array<[string, string]> = []
    const writeFile = vi.fn(async (p: string, c: string) => { writes.push([p, c]) })
    await ensureGitattributesEntry('/repo', { readFile, writeFile })
    expect(writes).toHaveLength(1)
    expect(writes[0][1]).toBe('*.lock binary\n* merge=mergiraf\n')
  })

  it('is idempotent — does not duplicate the line', async () => {
    const readFile = vi.fn(async () => 'foo\n* merge=mergiraf\nbar\n')
    const writeFile = vi.fn(async () => undefined)
    await ensureGitattributesEntry('/repo', { readFile, writeFile })
    expect(writeFile).not.toHaveBeenCalled()
  })

  it('preserves user lines exactly when appending', async () => {
    const original = '# Custom rules\n*.bin -text\n'
    const readFile = vi.fn(async () => original)
    let captured = ''
    const writeFile = vi.fn(async (_p: string, c: string) => { captured = c })
    await ensureGitattributesEntry('/repo', { readFile, writeFile })
    expect(captured.startsWith(original)).toBe(true)
    expect(captured.endsWith('* merge=mergiraf\n')).toBe(true)
  })
})

describe('enableRerere', () => {
  it('runs `git config rerere.enabled true`', async () => {
    const runner = vi.fn(async () => ({ stdout: '', stderr: '' }))
    await enableRerere('/repo', runner)
    expect(runner).toHaveBeenCalledWith(
      ['config', 'rerere.enabled', 'true'],
      '/repo',
    )
  })
})

describe('isRerereEnabled', () => {
  it('returns true when git reports `true`', async () => {
    const runner = vi.fn(async () => ({ stdout: 'true\n', stderr: '' }))
    expect(await isRerereEnabled('/repo', runner)).toBe(true)
  })

  it('returns false when git reports false', async () => {
    const runner = vi.fn(async () => ({ stdout: 'false\n', stderr: '' }))
    expect(await isRerereEnabled('/repo', runner)).toBe(false)
  })

  it('returns false when the config key is unset (runner throws)', async () => {
    // `git config --get` exits 1 when the key isn't set
    const runner = vi.fn(async () => { throw Object.assign(new Error('exit 1'), { code: 1 }) })
    expect(await isRerereEnabled('/repo', runner)).toBe(false)
  })
})
