/**
 * Plan B "new session in worktree mode" entry point. Builds on the
 * deterministic path scheme (worktreePaths.ts) — the test confirms it
 * issues `git worktree add -b <branch> <deterministic path> <baseRef>`
 * with the right argv to the right cwd.
 *
 * Branch naming: callers pass a desired branch slug; we prefix it with
 * `sb/` so it's easy to grep and so the user can `git branch -D sb/*`
 * to mass-clean. If the desired slug already starts with `sb/`, we
 * don't double-prefix.
 *
 * Caller-supplied baseRef defaults to `HEAD` so the simplest call
 * (`createSessionWorktree({ projectPath, branchSlug })`) just forks off
 * the current branch.
 */
import { describe, expect, it } from 'vitest'
import { join, sep } from 'node:path'
import { createSessionWorktree } from '../../src/main/worktree'
import type { GitRunner } from '../../src/main/worktree'

const userData = join(sep, 'tmp', 'switchboard-test')

describe('createSessionWorktree', () => {
  it('runs `git worktree add -b sb/<slug> <deterministic path> HEAD` in the project cwd', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      return { stdout: '', stderr: '' }
    }
    const out = await createSessionWorktree(
      { projectPath: '/repo', branchSlug: 'try-redis-cache', userDataDir: userData },
      runner,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe('/repo')
    expect(calls[0].args[0]).toBe('worktree')
    expect(calls[0].args[1]).toBe('add')
    expect(calls[0].args[2]).toBe('-b')
    expect(calls[0].args[3]).toBe('sb/try-redis-cache')
    expect(calls[0].args[4]).toContain('worktrees')
    expect(calls[0].args[4]).toContain('repo-')
    expect(calls[0].args[5]).toBe('HEAD')

    expect(out.branch).toBe('sb/try-redis-cache')
    expect(out.path).toBe(calls[0].args[4])
  })

  it('uses caller-supplied baseRef when provided', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      return { stdout: '', stderr: '' }
    }
    await createSessionWorktree(
      { projectPath: '/repo', branchSlug: 'foo', baseRef: 'origin/main', userDataDir: userData },
      runner,
    )
    expect(calls[0].args[calls[0].args.length - 1]).toBe('origin/main')
  })

  it('does not double-prefix slugs that already start with sb/', async () => {
    const calls: Array<{ args: string[]; cwd: string }> = []
    const runner: GitRunner = async (args, cwd) => {
      calls.push({ args, cwd })
      return { stdout: '', stderr: '' }
    }
    const out = await createSessionWorktree(
      { projectPath: '/repo', branchSlug: 'sb/already-prefixed', userDataDir: userData },
      runner,
    )
    expect(out.branch).toBe('sb/already-prefixed')
  })

  it('throws on a non-absolute project path (defense-in-depth)', async () => {
    const runner: GitRunner = async () => ({ stdout: '', stderr: '' })
    await expect(
      createSessionWorktree(
        { projectPath: 'relative/path', branchSlug: 'foo', userDataDir: userData },
        runner,
      ),
    ).rejects.toThrow(/absolute/i)
  })
})
