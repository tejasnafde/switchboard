/**
 * Behavior 9: `resolveOauthDirForCreate` has two independent confinement
 * checks, and only the lexical one had coverage.
 *
 * The second check exists because collapsing `..` is not enough: if any
 * EXISTING ancestor of the requested path is a symlink pointing out of the
 * home dir, a lexically-innocent `~/.codex-work/creds` still mkdir's outside
 * the home the button is scoped to. That branch resolves every existing
 * ancestor through `realpathSync`, so proving it works needs a real symlink
 * on a real filesystem - a mocked `fs` would resolve nothing and the branch
 * would silently never run.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveOauthDirForCreate } from '../../src/main/provider/oauth-path'

describe('resolveOauthDirForCreate - symlink escape (behavior 9)', () => {
  const roots: string[] = []

  function tempRoot(): string {
    // realpath: macOS /var/folders tmpdirs are themselves symlinks, and the
    // home side of the comparison has to be the real path or every case here
    // would "escape" for the wrong reason.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sb-oauth-escape-')))
    roots.push(root)
    return root
  }

  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  it('rejects a path whose existing parent is a symlink out of the home dir', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const outside = join(root, 'outside')
    mkdirSync(home)
    mkdirSync(outside)
    symlinkSync(outside, join(home, '.codex-work'))

    const result = resolveOauthDirForCreate(join(home, '.codex-work', 'creds'), home)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/outside your home directory/)
  })

  it('rejects a path that IS a symlink out of the home dir', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    const outside = join(root, 'outside')
    mkdirSync(home)
    mkdirSync(outside)
    symlinkSync(outside, join(home, '.claude-evil'))

    const result = resolveOauthDirForCreate(join(home, '.claude-evil'), home)
    expect(result.ok).toBe(false)
  })

  it('accepts a symlink that stays inside the home dir', () => {
    const root = tempRoot()
    const home = join(root, 'home')
    mkdirSync(join(home, 'real'), { recursive: true })
    symlinkSync(join(home, 'real'), join(home, '.codex-link'))

    const result = resolveOauthDirForCreate(join(home, '.codex-link', 'creds'), home)
    expect(result).toEqual({ ok: true, path: join(home, '.codex-link', 'creds') })
  })

  it('accepts an ordinary not-yet-created dir under a real home', () => {
    const home = tempRoot()
    expect(resolveOauthDirForCreate(join(home, '.codex-work'), home))
      .toEqual({ ok: true, path: join(home, '.codex-work') })
  })
})
