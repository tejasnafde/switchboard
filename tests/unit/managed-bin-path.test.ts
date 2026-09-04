/**
 * Managed CLI bin precedence for Claude and Codex.
 *
 * Field evidence: the remote server's runtime PATH omitted the directory
 * provisioning links its managed `claude`/`codex` into, so the adapters either
 * found nothing or silently latched onto a shadow binary earlier in the list.
 * Both failures look identical from the UI ("provider unavailable" / a CLI that
 * is the wrong version), so precedence has to be deterministic and asserted.
 *
 * Also covers the resolution cache: the remote backend is long-lived, and the
 * old `null`-forever cache meant a CLI installed by a LATER provisioning pass
 * was never picked up without restarting the server.
 */
import { describe, it, expect, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANAGED_BIN_ENV,
  createExecutableCache,
  executableIdentity,
  managedBinDir,
  managedPath,
  preferManagedExecutable,
} from '../../src/main/provider/managed-bin'

describe('managedBinDir', () => {
  it('defaults to ~/.local/bin, where provisioning links the managed CLIs', () => {
    expect(managedBinDir({ HOME: '/home/u' })).toBe('/home/u/.local/bin')
  })

  it('honours the dir the remote bootstrap exported, rather than re-guessing', () => {
    expect(managedBinDir({ HOME: '/home/u', [MANAGED_BIN_ENV]: '/opt/sb/bin' })).toBe('/opt/sb/bin')
  })

  it('ignores a blank override and a missing HOME', () => {
    expect(managedBinDir({ HOME: '/home/u', [MANAGED_BIN_ENV]: '   ' })).toBe('/home/u/.local/bin')
    expect(managedBinDir({})).toBeNull()
  })
})

describe('managedPath', () => {
  it('puts the managed bin dir FIRST, ahead of every fallback', () => {
    const path = managedPath({ HOME: '/home/u', PATH: '/usr/bin:/bin' }, ['/opt/homebrew/bin'])
    expect(path.split(':')[0]).toBe('/home/u/.local/bin')
  })

  it('keeps the inherited PATH reachable after the managed and fallback dirs', () => {
    const path = managedPath({ HOME: '/home/u', PATH: '/usr/bin:/bin' }, ['/usr/local/bin'])
    expect(path.split(':')).toEqual(['/home/u/.local/bin', '/usr/local/bin', '/usr/bin', '/bin'])
  })

  it('promotes the managed dir even when the inherited PATH already lists it later', () => {
    // An interactive-shell PATH may contain ~/.local/bin far down the list,
    // behind a shadowing /usr/local/bin. Deduping to the front is what makes
    // precedence deterministic instead of profile-dependent.
    const path = managedPath({ HOME: '/home/u', PATH: '/usr/local/bin:/home/u/.local/bin' }, [])
    expect(path.split(':')).toEqual(['/home/u/.local/bin', '/usr/local/bin'])
  })

  it('falls back to a usable PATH when the environment has none', () => {
    expect(managedPath({ HOME: '/home/u' }, []).split(':')).toEqual(['/home/u/.local/bin', '/usr/bin', '/bin'])
  })

  it('still produces a PATH when there is no managed dir to prefer', () => {
    expect(managedPath({ PATH: '/usr/bin' }, ['/usr/local/bin'])).toBe('/usr/local/bin:/usr/bin')
  })
})

describe('preferManagedExecutable', () => {
  const isExec = (present: string[]) => (p: string) => present.includes(p)

  it('prefers the managed CLI over an equally-present shadow', () => {
    const found = preferManagedExecutable('codex', {
      env: { HOME: '/home/u' },
      fallbackDirs: ['/usr/local/bin'],
      isExecutable: isExec(['/home/u/.local/bin/codex', '/usr/local/bin/codex']),
    })
    expect(found).toEqual({ path: '/home/u/.local/bin/codex', source: 'managed' })
  })

  it('skips an ABSENT managed link instead of returning a path that cannot run', () => {
    // The dangling-symlink case: provisioning linked it, npm later pruned the
    // target. Returning it anyway turns a fixable install into a spawn ENOENT.
    const found = preferManagedExecutable('codex', {
      env: { HOME: '/home/u' },
      fallbackDirs: ['/usr/local/bin'],
      isExecutable: isExec(['/usr/local/bin/codex']),
    })
    expect(found).toEqual({ path: '/usr/local/bin/codex', source: 'fallback' })
  })

  it('returns null when neither the managed nor any fallback candidate is executable', () => {
    const found = preferManagedExecutable('claude', {
      env: { HOME: '/home/u' },
      fallbackDirs: ['/usr/local/bin'],
      isExecutable: isExec([]),
    })
    expect(found).toBeNull()
  })

  it('keeps fallback order stable so resolution is reproducible', () => {
    const found = preferManagedExecutable('claude', {
      env: {},
      fallbackDirs: ['/opt/homebrew/bin', '/usr/local/bin'],
      isExecutable: isExec(['/opt/homebrew/bin/claude', '/usr/local/bin/claude']),
    })
    expect(found).toEqual({ path: '/opt/homebrew/bin/claude', source: 'fallback' })
  })
})

describe('executableIdentity', () => {
  let dir: string
  const mk = () => (dir = mkdtempSync(join(tmpdir(), 'sb-managed-')))

  it('changes when a managed link is repointed at a new install', () => {
    mk()
    try {
      const bin = join(dir, 'bin')
      mkdirSync(bin, { recursive: true })
      writeFileSync(join(dir, 'codex-old'), '#!/bin/sh\n')
      writeFileSync(join(dir, 'codex-new'), '#!/bin/sh\n')
      chmodSync(join(dir, 'codex-old'), 0o755)
      chmodSync(join(dir, 'codex-new'), 0o755)
      const link = join(bin, 'codex')
      symlinkSync(join(dir, 'codex-old'), link)
      const before = executableIdentity(link)
      rmSync(link)
      symlinkSync(join(dir, 'codex-new'), link)
      const after = executableIdentity(link)
      expect(before).not.toBeNull()
      expect(after).not.toBe(before)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is null for a dangling link, so a broken managed CLI reads as absent', () => {
    mk()
    try {
      const link = join(dir, 'codex')
      symlinkSync(join(dir, 'nope'), link)
      expect(executableIdentity(link)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('createExecutableCache', () => {
  it('re-resolves after a miss once the negative-cache TTL elapses, so a CLI installed later is picked up in-process', () => {
    // The long-lived remote backend: it boots before provisioning has installed
    // codex. Caching that miss forever meant the provider stayed unavailable
    // until someone restarted the 41h-old process.
    let clock = 0
    const resolve = vi.fn<[], string | null>()
      .mockReturnValueOnce(null)
      .mockReturnValue('/home/u/.local/bin/codex')
    const cache = createExecutableCache({ resolve, identify: () => 'id-1', now: () => clock })
    expect(cache.refresh()).toBeNull()
    clock += 5_000 // past the negative-cache TTL
    expect(cache.refresh()).toEqual({ path: '/home/u/.local/bin/codex', identity: 'id-1' })
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('does not re-probe on every call while a miss is still within the negative-cache TTL', () => {
    // Hardening: isAvailable()/listModels() can be called in a hot loop by the
    // UI. A genuine miss must not re-run a subprocess/filesystem probe on
    // every single call - but only briefly, never forever (see above).
    let clock = 0
    const resolve = vi.fn<[], string | null>(() => null)
    const cache = createExecutableCache({ resolve, identify: () => null, now: () => clock })
    expect(cache.refresh()).toBeNull()
    clock += 500
    expect(cache.refresh()).toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('reuses a hit while the resolved executable is unchanged', () => {
    const resolve = vi.fn(() => '/home/u/.local/bin/codex')
    const cache = createExecutableCache({ resolve, identify: () => 'id-1' })
    cache.refresh()
    cache.refresh()
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(cache.current()?.identity).toBe('id-1')
  })

  it('re-resolves when an upgrade repoints the executable', () => {
    const resolve = vi.fn(() => '/home/u/.local/bin/codex')
    const identify = vi.fn<[string], string | null>()
      .mockReturnValueOnce('id-old')
      .mockReturnValue('id-new')
    const cache = createExecutableCache({ resolve, identify })
    expect(cache.refresh()?.identity).toBe('id-old')
    expect(cache.refresh()?.identity).toBe('id-new')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('drops the cached hit when the executable disappears', () => {
    const resolve = vi.fn<[], string | null>()
      .mockReturnValueOnce('/home/u/.local/bin/codex')
      .mockReturnValue(null)
    const cache = createExecutableCache({ resolve, identify: () => null })
    expect(cache.refresh()).not.toBeNull()
    expect(cache.refresh()).toBeNull()
    expect(cache.current()).toBeNull()
  })
})

describe('adapter env precedence', () => {
  it('Claude CLI env puts the managed bin dir first', async () => {
    vi.stubEnv('HOME', '/home/u')
    vi.stubEnv(MANAGED_BIN_ENV, '')
    const { buildClaudeCliEnv } = await import('../../src/main/provider/adapters/claude-adapter')
    expect(buildClaudeCliEnv().PATH.split(':')[0]).toBe('/home/u/.local/bin')
    vi.unstubAllEnvs()
  })

  it('Codex CLI env puts the managed bin dir first', async () => {
    vi.stubEnv('HOME', '/home/u')
    vi.stubEnv(MANAGED_BIN_ENV, '')
    const { buildCodexCliEnv } = await import('../../src/main/provider/adapters/codex-adapter')
    expect(buildCodexCliEnv().PATH.split(':')[0]).toBe('/home/u/.local/bin')
    vi.unstubAllEnvs()
  })

  it('both adapters honour an explicitly exported managed bin dir', async () => {
    vi.stubEnv('HOME', '/home/u')
    vi.stubEnv(MANAGED_BIN_ENV, '/opt/sb/bin')
    const { buildClaudeCliEnv } = await import('../../src/main/provider/adapters/claude-adapter')
    const { buildCodexCliEnv } = await import('../../src/main/provider/adapters/codex-adapter')
    expect(buildClaudeCliEnv().PATH.split(':')[0]).toBe('/opt/sb/bin')
    expect(buildCodexCliEnv().PATH.split(':')[0]).toBe('/opt/sb/bin')
    vi.unstubAllEnvs()
  })
})
