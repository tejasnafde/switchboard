/**
 * Deterministic worktree path scheme for the "new session in worktree
 * mode" flow (Plan B). Mirrors t3code's `worktreesDir/<repo>/<branch>`
 * but lands under switchboard's userData dir instead of inside the
 * project tree — keeps things off TCC-protected paths (~/Desktop, etc.)
 * and avoids polluting users' working dirs.
 *
 * Two pure functions tested here:
 *   - slugForBranch: filesystem-safe branch slug for use as a directory
 *     basename (lowercase, alnum + dash, no leading/trailing dashes,
 *     capped length). Distinct from `slugForCard` in worktree.ts because
 *     branch names commonly contain `/` which we want to flatten.
 *   - resolveSessionWorktreePath: build the full path from a userData
 *     root + a project path + a branch slug. Cross-platform: uses
 *     path.join everywhere; never embeds a literal separator.
 */
import { describe, expect, it } from 'vitest'
import { sep, join } from 'node:path'
import {
  slugForBranch,
  slugForRepo,
  resolveSessionWorktreePath,
} from '../../src/main/git/worktreePaths'

describe('slugForBranch', () => {
  it('lowercases, replaces non-alnum with dashes, trims', () => {
    expect(slugForBranch('Feat/Add-User Login')).toBe('feat-add-user-login')
  })

  it('flattens slashes (so `feat/foo` becomes `feat-foo`, not a nested dir)', () => {
    expect(slugForBranch('release/2024-01-01/rc1')).toBe('release-2024-01-01-rc1')
  })

  it('collapses runs of separators', () => {
    expect(slugForBranch('a   //   b')).toBe('a-b')
  })

  it('caps length at 60 chars', () => {
    expect(slugForBranch('x'.repeat(120)).length).toBeLessThanOrEqual(60)
  })

  it('falls back to "branch" for empty / all-junk input', () => {
    expect(slugForBranch('')).toBe('branch')
    expect(slugForBranch('!!!')).toBe('branch')
  })
})

describe('slugForRepo', () => {
  it('uses the basename of the project path', () => {
    expect(slugForRepo('/Users/me/projects/my-repo')).toBe('my-repo')
  })

  it('strips trailing separator', () => {
    expect(slugForRepo('/Users/me/projects/my-repo/')).toBe('my-repo')
  })

  it('handles Windows-style backslash paths', () => {
    expect(slugForRepo('C:\\Users\\me\\projects\\my-repo')).toBe('my-repo')
  })

  it('lowercases + alnum-dashes the basename', () => {
    expect(slugForRepo('/Users/me/projects/My Cool Repo!')).toBe('my-cool-repo')
  })

  it('falls back to "repo" for unusable basenames', () => {
    expect(slugForRepo('/')).toBe('repo')
    expect(slugForRepo('')).toBe('repo')
  })
})

describe('resolveSessionWorktreePath', () => {
  const userData = join(sep, 'tmp', 'switchboard')

  it('joins userData/worktrees/<repoSlug>-<hash>/<branchSlug>', () => {
    // The hash suffix is mandatory for collision avoidance (see the
    // "two repos sharing a basename" test below); we assert its general
    // shape (8 hex chars) without pinning to a specific digest so this
    // test doesn't lock in the algorithm choice.
    const path = resolveSessionWorktreePath({
      userDataDir: userData,
      projectPath: '/Users/me/projects/my-repo',
      branch: 'feat/awesome-thing',
    })
    const re = new RegExp(
      `^${join(userData, 'worktrees').replace(/\\/g, '\\\\')}.my-repo-[0-9a-f]{8}.feat-awesome-thing$`,
    )
    expect(path).toMatch(re)
  })

  it('produces the same path for the same inputs (deterministic)', () => {
    const a = resolveSessionWorktreePath({
      userDataDir: userData,
      projectPath: '/r/foo',
      branch: 'main',
    })
    const b = resolveSessionWorktreePath({
      userDataDir: userData,
      projectPath: '/r/foo',
      branch: 'main',
    })
    expect(a).toBe(b)
  })

  it('disambiguates two different repos with the same basename via project hash', () => {
    // Two different absolute paths that happen to share the same trailing
    // dir name must NOT collide on disk — otherwise two unrelated projects
    // step on each other's worktrees. Implementation appends a stable
    // hash of the absolute project path so the dirs differ.
    const a = resolveSessionWorktreePath({
      userDataDir: userData,
      projectPath: '/Users/me/work/api',
      branch: 'main',
    })
    const b = resolveSessionWorktreePath({
      userDataDir: userData,
      projectPath: '/Users/me/personal/api',
      branch: 'main',
    })
    expect(a).not.toBe(b)
  })
})
