/**
 * What the chat UI does with each relocation outcome.
 *
 * The old Follow button had one outcome, because it only wrote a pointer.
 * A real transaction has eight, and three of them are NOT failures: the move
 * happened, it was already there, or it is waiting for the current turn to
 * finish. Getting "queued" wrong would be the worst of them - the user would
 * see an error and click again, which is how you end up with two relocations
 * racing for one thread.
 */
import { describe, it, expect } from 'vitest'
import { resolveExecutionRoot } from '../../src/shared/execution-root'
import type { RelocateExecutionRootResult } from '../../src/shared/execution-root-relocation'
import { describeRelocationOutcome } from '../../src/renderer/services/execution-root-relocation'

const root = resolveExecutionRoot({
  projectPath: '/repo/app',
  worktreePath: '/wt/feat',
  worktreeBranch: 'sb/feat',
  executionRootRevision: 3,
})

function ok(outcome: 'relocated' | 'already-at-target' | 'queued'): RelocateExecutionRootResult {
  return { ok: true, outcome, root, continuity: 'preserved' }
}

function fail(code: RelocateExecutionRootResult extends { ok: false } ? never : string): RelocateExecutionRootResult {
  return { ok: false, code: code as never, message: 'nope', root }
}

describe('a successful move', () => {
  const view = describeRelocationOutcome(ok('relocated'))

  it('applies the committed root, revision included', () => {
    expect(view.applyRoot).toEqual({
      path: '/wt/feat', branch: 'sb/feat', revision: 3, isWorktree: true,
    })
  })

  it('clears the drift suggestion so it cannot be offered again', () => {
    expect(view.clearSuggestion).toBe(true)
  })

  it('says nothing, because the branch chip already moved', () => {
    expect(view.notice).toBeNull()
  })
})

describe('already at the target', () => {
  const view = describeRelocationOutcome(ok('already-at-target'))

  it('still clears the suggestion', () => {
    expect(view.clearSuggestion).toBe(true)
  })

  it('applies the root, so a client that drifted out of sync catches up', () => {
    expect(view.applyRoot).not.toBeNull()
  })

  it('stays silent rather than reporting a non-event', () => {
    expect(view.notice).toBeNull()
  })
})

describe('queued behind a running turn', () => {
  const view = describeRelocationOutcome(ok('queued'))

  it('is not an error', () => {
    expect(view.isError).toBe(false)
  })

  it('tells the user it will happen, so they do not click again', () => {
    expect(view.notice).toBe('Following when this turn finishes.')
  })

  it('does NOT apply the root yet - nothing has moved', () => {
    expect(view.applyRoot).toBeNull()
  })

  it('keeps the suggestion until it actually commits', () => {
    expect(view.clearSuggestion).toBe(false)
  })
})

describe('the stale-revision self-heal', () => {
  // The bug this exists for: reopen a conversation that has been relocated
  // once, and the client starts at revision 0 against a DB revision of 1.
  // Every Follow is then refused as stale, identically, forever. The refusal
  // carries the right number, so adopting it makes the retry work.
  it('adopts the revision the refusal reported', () => {
    const view = describeRelocationOutcome({
      ok: false, code: 'stale-revision', message: 'moved', root,
    })
    expect(view.syncRevision).toBe(3)
  })

  it('does not move anything while adopting it', () => {
    const view = describeRelocationOutcome({
      ok: false, code: 'stale-revision', message: 'moved', root,
    })
    expect(view.applyRoot).toBeNull()
    expect(view.clearSuggestion).toBe(false)
  })

  it('is not set for any other outcome', () => {
    for (const code of ['busy', 'target-missing', 'rollback-failed', 'source-stop-failed']) {
      expect(describeRelocationOutcome(fail(code)).syncRevision).toBeNull()
    }
    expect(describeRelocationOutcome(ok('relocated')).syncRevision).toBeNull()
    expect(describeRelocationOutcome(ok('queued')).syncRevision).toBeNull()
  })
})

describe('failures', () => {
  it('reports a failed stop as final, with nothing moved', () => {
    const view = describeRelocationOutcome(fail('source-stop-failed'))
    expect(view.isError).toBe(true)
    expect(view.retryable).toBe(false)
    expect(view.applyRoot).toBeNull()
    expect(view.notice).toContain('nothing moved')
  })

  it('explains a stale revision as something to retry', () => {
    const view = describeRelocationOutcome(fail('stale-revision'))
    expect(view.isError).toBe(true)
    expect(view.retryable).toBe(true)
    expect(view.notice).toContain('moved')
  })

  it('explains contention as something to retry', () => {
    expect(describeRelocationOutcome(fail('busy')).retryable).toBe(true)
  })

  it('reports a missing target as final, and clears the dead suggestion', () => {
    const view = describeRelocationOutcome(fail('target-missing'))
    expect(view.retryable).toBe(false)
    expect(view.clearSuggestion).toBe(true)
    expect(view.notice).toContain('no longer exists')
  })

  it('reports a cross-repository target as final', () => {
    const view = describeRelocationOutcome(fail('different-repository'))
    expect(view.retryable).toBe(false)
    expect(view.notice).toContain('different repository')
  })

  it('names the continuity problem instead of a generic failure', () => {
    const view = describeRelocationOutcome(fail('continuity-unsupported'))
    expect(view.notice).toContain('conversation')
    expect(view.offerRestart).toBe(true)
  })

  it('does not offer a cold restart for any other failure', () => {
    for (const code of ['busy', 'stale-revision', 'target-missing', 'rollback-failed']) {
      expect(describeRelocationOutcome(fail(code)).offerRestart).toBe(false)
    }
  })

  it('never applies a root on failure', () => {
    for (const code of ['busy', 'stale-revision', 'target-missing', 'rollback-failed', 'target-start-failed']) {
      expect(describeRelocationOutcome(fail(code)).applyRoot).toBeNull()
    }
  })

  it('says the conversation is back where it was when rollback worked', () => {
    const view = describeRelocationOutcome({
      ok: false, code: 'target-start-failed', message: 'x', rolledBack: true, root,
    })
    expect(view.notice).toContain('still in')
  })

  it('escalates a failed rollback, because neither directory is running', () => {
    const view = describeRelocationOutcome(fail('rollback-failed'))
    expect(view.isError).toBe(true)
    expect(view.notice).toContain('Restart')
  })

  it('falls back to the backend message for a code it does not know', () => {
    const view = describeRelocationOutcome({
      ok: false, code: 'unknown-thread', message: 'gone from this backend', root,
    })
    expect(view.notice).toBe('gone from this backend')
  })
})
