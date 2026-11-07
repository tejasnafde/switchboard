import { describe, expect, it } from 'vitest'
import { forkBlockedByStatus, offerForkIntoWorktree } from '../../src/shared/conversation-fork'

describe('forkBlockedByStatus', () => {
  it('blocks only a turn in flight', () => {
    expect(forkBlockedByStatus('running')).toBe(true)
    expect(forkBlockedByStatus('thinking')).toBe(true)
    expect(forkBlockedByStatus('idle')).toBe(false)
    // A failed last turn or an exited session leaves a settled history.
    expect(forkBlockedByStatus('error')).toBe(false)
    expect(forkBlockedByStatus('exited')).toBe(false)
  })
})

describe('offerForkIntoWorktree', () => {
  it('hides the worktree fork outside a git work tree', () => {
    expect(offerForkIntoWorktree({ ok: true })).toBe(true)
    expect(offerForkIntoWorktree({ ok: false, error: 'fatal: not a git repository (or any parent)' })).toBe(false)
    expect(offerForkIntoWorktree({ ok: false, error: 'Folder no longer exists: /gone', missing: true })).toBe(false)
  })

  it('keeps it when the read failed for another reason, or has not answered', () => {
    // A git binary error, a refused channel or a disconnected machine says
    // nothing about the folder. The backend refuses what it cannot serve.
    expect(offerForkIntoWorktree({ ok: false, error: 'Machine connection was lost' })).toBe(true)
    expect(offerForkIntoWorktree(null)).toBe(true)
    expect(offerForkIntoWorktree(undefined)).toBe(true)
  })
})
