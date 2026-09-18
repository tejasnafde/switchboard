/**
 * Several clients watch one thread, so a committed root arrives out of order.
 *
 * The revision is what makes convergence safe: a phone that was asleep
 * replays an older event, and without the guard it would repaint the branch
 * chip backwards on the desktop that already moved on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'

beforeEach(() => {
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { provider: { stopSession: vi.fn(() => Promise.resolve()) } },
  }
  useAgentStore.getState().addSession({
    id: 's1',
    type: 'claude-code',
    status: 'idle',
    projectPath: '/repo/app',
  } as never)
})

const session = () => useAgentStore.getState().sessions.find((s) => s.id === 's1')

describe('applyExecutionRoot', () => {
  it('applies a newer revision', () => {
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/a', branch: 'sb/a', revision: 1 })
    expect(session()).toMatchObject({
      worktreePath: '/wt/a',
      worktreeBranch: 'sb/a',
      executionRootRevision: 1,
    })
  })

  it('ignores an older revision arriving late', () => {
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/b', branch: 'sb/b', revision: 5 })
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/a', branch: 'sb/a', revision: 2 })
    expect(session()).toMatchObject({ worktreePath: '/wt/b', executionRootRevision: 5 })
  })

  it('ignores a repeat of the revision it already holds', () => {
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/a', branch: 'sb/a', revision: 4 })
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/other', branch: 'x', revision: 4 })
    expect(session()?.worktreePath).toBe('/wt/a')
  })

  it('clears the pointer when the root returns to the parent checkout', () => {
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/a', branch: 'sb/a', revision: 1 })
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/repo/app', branch: 'main', revision: 2 })
    expect(session()?.worktreePath).toBeNull()
    expect(session()?.worktreeBranch).toBeNull()
  })

  it('clears a drift suggestion, so the move is not offered again', () => {
    useAgentStore.getState().setDriftSuggestion('s1', { worktreePath: '/wt/a', branch: 'sb/a' })
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/a', branch: 'sb/a', revision: 1 })
    expect(session()?.driftSuggestion).toBeNull()
  })

  it('leaves a stale suggestion alone when the revision is ignored', () => {
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/b', branch: 'sb/b', revision: 3 })
    useAgentStore.getState().setDriftSuggestion('s1', { worktreePath: '/wt/c', branch: 'sb/c' })
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/a', branch: 'sb/a', revision: 1 })
    expect(session()?.driftSuggestion).toEqual({ worktreePath: '/wt/c', branch: 'sb/c' })
  })

  it('does not touch another session', () => {
    useAgentStore.getState().addSession({
      id: 's2', type: 'claude-code', status: 'idle', projectPath: '/repo/app',
    } as never)
    useAgentStore.getState().applyExecutionRoot('s1', { path: '/wt/a', branch: 'sb/a', revision: 1 })
    expect(useAgentStore.getState().sessions.find((s) => s.id === 's2')?.worktreePath).toBeUndefined()
  })
})
