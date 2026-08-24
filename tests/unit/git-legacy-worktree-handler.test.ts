import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { BackendHost } from '../../src/main/backend/host'
import { registerGitHandlers } from '../../src/main/ipc/git'
import { GitChannels } from '../../src/shared/ipc-channels'

class FakeHost implements BackendHost {
  readonly handlers = new Map<string, (...args: unknown[]) => unknown>()

  handle<A extends unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    this.handlers.set(channel, fn as (...args: unknown[]) => unknown)
  }

  on(): void {}
  emit(): void {}
}

describe('legacy Git session worktree channel', () => {
  it('keeps the old request and response shape while delegating to the lease manager', async () => {
    const host = new FakeHost()
    const requests: unknown[] = []
    registerGitHandlers(host, {
      createLegacySessionWorktree: async (request) => {
        requests.push(request)
        return { path: '/data/worktrees/repo/feature', branch: 'sb/feature' }
      },
    })

    const handler = host.handlers.get(GitChannels.CREATE_SESSION_WORKTREE)!
    const result = await handler({
      projectPath: '/repo',
      branchSlug: 'feature',
      baseRef: 'main',
    })

    expect(requests).toEqual([{
      projectPath: '/repo',
      branchSlug: 'feature',
      baseRef: 'main',
    }])
    expect(result).toEqual({
      ok: true,
      path: '/data/worktrees/repo/feature',
      branch: 'sb/feature',
    })
  })

  it('preserves every plain Git ref channel', () => {
    const host = new FakeHost()
    registerGitHandlers(host, {
      createLegacySessionWorktree: async () => ({ path: '/worktree', branch: 'sb/test' }),
    })

    expect([...host.handlers.keys()].sort()).toEqual([
      GitChannels.CURRENT_BRANCH,
      GitChannels.CREATE_SESSION_WORKTREE,
      GitChannels.LIST_REFS,
      GitChannels.SWITCH_REF,
      GitChannels.UNWATCH_HEAD,
      GitChannels.WATCH_HEAD,
    ].sort())
  })

  it('does not call the unjournaled session worktree helper from production IPC', () => {
    const source = readFileSync('src/main/ipc/git.ts', 'utf8')
    expect(source).not.toMatch(/\bcreateSessionWorktree\s*\(/)
  })
})
