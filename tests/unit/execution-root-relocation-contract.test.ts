import { describe, it, expect } from 'vitest'
import { resolveExecutionRoot } from '../../src/shared/execution-root'
import {
  classifyRelocationPreconditions,
  isRelocationRetryable,
  type RelocationPreconditionState,
} from '../../src/shared/execution-root-relocation'

const currentRoot = resolveExecutionRoot({
  projectPath: '/repo/app',
  executionRootRevision: 3,
})

function state(overrides: Partial<RelocationPreconditionState> = {}): RelocationPreconditionState {
  return {
    request: {
      threadId: 't1',
      expectedRevision: 3,
      targetPath: '/repo/app/.switchboard/worktrees/feat',
      targetBranch: 'sb/feat',
      machineId: 'local',
      reason: 'drift-follow',
    },
    currentRoot,
    threadIsLive: true,
    relocating: false,
    starting: false,
    switchingProfile: false,
    preparingTurn: false,
    turnActive: false,
    provider: 'claude',
    ...overrides,
  }
}

describe('classifyRelocationPreconditions', () => {
  it('admits a clean relocation', () => {
    expect(classifyRelocationPreconditions(state())).toEqual({ verdict: 'proceed' })
  })

  it('reports already-at-target when the target is the current root', () => {
    expect(classifyRelocationPreconditions(state({
      request: { ...state().request, targetPath: '/repo/app' },
    }))).toEqual({ verdict: 'already-at-target' })
  })

  it('ignores a trailing separator when comparing against the current root', () => {
    expect(classifyRelocationPreconditions(state({
      request: { ...state().request, targetPath: '/repo/app/' },
    }))).toEqual({ verdict: 'already-at-target' })
  })

  it('rejects a stale expected revision so a slow client cannot undo a newer move', () => {
    expect(classifyRelocationPreconditions(state({
      request: { ...state().request, expectedRevision: 2 },
    }))).toMatchObject({ verdict: 'reject', code: 'stale-revision' })
  })

  it('rejects an expected revision from the future', () => {
    expect(classifyRelocationPreconditions(state({
      request: { ...state().request, expectedRevision: 9 },
    }))).toMatchObject({ verdict: 'reject', code: 'stale-revision' })
  })

  it('rejects a request aimed at a different machine', () => {
    expect(classifyRelocationPreconditions(state({
      request: { ...state().request, machineId: 'vm-7' },
    }))).toMatchObject({ verdict: 'reject', code: 'wrong-machine' })
  })

  it('rejects a relative target path', () => {
    expect(classifyRelocationPreconditions(state({
      request: { ...state().request, targetPath: '../feat' },
    }))).toMatchObject({ verdict: 'reject', code: 'invalid-target' })
  })

  it('rejects a blank target path', () => {
    expect(classifyRelocationPreconditions(state({
      request: { ...state().request, targetPath: '   ' },
    }))).toMatchObject({ verdict: 'reject', code: 'invalid-target' })
  })

  it('queues behind an active turn instead of killing it', () => {
    expect(classifyRelocationPreconditions(state({ turnActive: true })))
      .toEqual({ verdict: 'queue' })
    expect(classifyRelocationPreconditions(state({ preparingTurn: true })))
      .toEqual({ verdict: 'queue' })
  })

  it('rejects while another relocation, a start, or a profile switch holds the thread', () => {
    for (const busy of ['relocating', 'starting', 'switchingProfile'] as const) {
      expect(classifyRelocationPreconditions(state({ [busy]: true })))
        .toMatchObject({ verdict: 'reject', code: 'busy' })
    }
  })

  it('proceeds without provider work when the thread is not live', () => {
    expect(classifyRelocationPreconditions(state({ threadIsLive: false, turnActive: false })))
      .toEqual({ verdict: 'proceed-detached' })
  })

  it('still rejects a stale revision on a detached thread', () => {
    expect(classifyRelocationPreconditions(state({
      threadIsLive: false,
      request: { ...state().request, expectedRevision: 1 },
    }))).toMatchObject({ verdict: 'reject', code: 'stale-revision' })
  })

  // Regression for a queued-then-rejected path: an OpenCode Follow arriving
  // mid-turn was answered `ok: queued`, then refused at the turn boundary
  // where the failure only reached a log. The user saw a Follow that never
  // happened and never learned why.
  it('refuses an unsupported provider DURING a turn, rather than queuing it', () => {
    expect(classifyRelocationPreconditions(state({ provider: 'opencode', turnActive: true })))
      .toMatchObject({ verdict: 'reject', code: 'continuity-unsupported' })
  })

  it('still queues a capable provider during a turn', () => {
    expect(classifyRelocationPreconditions(state({ provider: 'codex', turnActive: true })))
      .toEqual({ verdict: 'queue' })
  })

  it('queues an unsupported provider that accepted the continuity loss', () => {
    expect(classifyRelocationPreconditions(state({
      provider: 'opencode',
      turnActive: true,
      request: { ...state().request, acceptContinuityLoss: true },
    }))).toEqual({ verdict: 'queue' })
  })

  it('reports an unsupported provider rather than silently dropping context', () => {
    expect(classifyRelocationPreconditions(state({ provider: 'opencode' })))
      .toMatchObject({ verdict: 'reject', code: 'continuity-unsupported' })
  })

  it('lets an unsupported provider through when the caller accepts a cold restart', () => {
    expect(classifyRelocationPreconditions(state({
      provider: 'opencode',
      request: { ...state().request, acceptContinuityLoss: true },
    }))).toEqual({ verdict: 'proceed' })
  })

  it('does not gate a detached opencode thread on continuity', () => {
    expect(classifyRelocationPreconditions(state({ provider: 'opencode', threadIsLive: false })))
      .toEqual({ verdict: 'proceed-detached' })
  })
})

describe('isRelocationRetryable', () => {
  it('marks contention and staleness retryable', () => {
    expect(isRelocationRetryable('busy')).toBe(true)
    expect(isRelocationRetryable('stale-revision')).toBe(true)
  })

  it('marks a bad target and a failed rollback not retryable', () => {
    expect(isRelocationRetryable('target-missing')).toBe(false)
    expect(isRelocationRetryable('different-repository')).toBe(false)
    expect(isRelocationRetryable('rollback-failed')).toBe(false)
    expect(isRelocationRetryable('invalid-target')).toBe(false)
  })
})
