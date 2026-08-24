import { describe, expect, it } from 'vitest'
import { resolveWorktreeSetup } from '../../src/main/worktree-creation/setup-policy'

const configured = {
  command: 'npm ci',
  defaultPolicy: 'ask' as const,
  startupPolicy: 'wait-for-setup' as const,
}

describe('worktree setup policy resolution', () => {
  it('pauses an inherited ask policy without running the configured command', () => {
    expect(resolveWorktreeSetup('inherit', configured)).toEqual({
      action: 'await_decision',
      startupPolicy: 'wait-for-setup',
      command: 'npm ci',
      receipt: {
        requestedPolicy: 'inherit',
        resolvedPolicy: 'ask',
        status: 'awaiting_decision',
        commandSource: 'launch-config',
      },
    })
  })

  it('resolves inherited run and skip repository defaults', () => {
    expect(resolveWorktreeSetup('inherit', {
      ...configured,
      defaultPolicy: 'run',
    })).toMatchObject({ action: 'run', command: 'npm ci', receipt: { resolvedPolicy: 'run' } })

    expect(resolveWorktreeSetup('inherit', {
      ...configured,
      defaultPolicy: 'skip',
    })).toEqual({
      action: 'skip',
      startupPolicy: 'wait-for-setup',
      receipt: {
        requestedPolicy: 'inherit',
        resolvedPolicy: 'skip',
        status: 'skipped',
      },
    })
  })

  it('honors explicit run and skip over the repository default', () => {
    expect(resolveWorktreeSetup('run', configured)).toMatchObject({
      action: 'run',
      command: 'npm ci',
      receipt: { requestedPolicy: 'run', resolvedPolicy: 'run' },
    })
    expect(resolveWorktreeSetup('skip', { ...configured, defaultPolicy: 'run' })).toEqual({
      action: 'skip',
      startupPolicy: 'wait-for-setup',
      receipt: {
        requestedPolicy: 'skip',
        resolvedPolicy: 'skip',
        status: 'skipped',
      },
    })
  })

  it('returns not_configured instead of guessing a command', () => {
    expect(resolveWorktreeSetup('run', undefined)).toEqual({
      action: 'not_configured',
      startupPolicy: 'wait-for-setup',
      receipt: {
        requestedPolicy: 'run',
        resolvedPolicy: 'run',
        status: 'not_configured',
      },
    })
    expect(resolveWorktreeSetup('inherit', undefined)).toEqual({
      action: 'skip',
      startupPolicy: 'wait-for-setup',
      receipt: {
        requestedPolicy: 'inherit',
        resolvedPolicy: 'skip',
        status: 'not_configured',
      },
    })
  })

  it('preserves start-immediately independently from setup execution', () => {
    expect(resolveWorktreeSetup('run', {
      ...configured,
      defaultPolicy: 'run',
      startupPolicy: 'start-immediately',
    })).toMatchObject({ action: 'run', startupPolicy: 'start-immediately' })
  })
})
