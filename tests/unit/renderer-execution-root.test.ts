/**
 * The renderer's single source of truth for "where does this session run".
 *
 * Five terminal-creation entry points used to read `session.projectPath`
 * directly, so a chat that had followed a worktree still opened terminals in
 * the parent checkout. These tests pin the helper they all now share.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAgentStore } from '../../src/renderer/stores/agent-store'
import {
  executionRootForSession,
  sessionExecutionRoot,
  sessionExecutionRootPath,
} from '../../src/renderer/services/executionRoot'

beforeEach(() => {
  useAgentStore.setState({ sessions: [], activeSessionId: null })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: { provider: { stopSession: vi.fn(() => Promise.resolve()) } },
  }
})

function addSession(overrides: Record<string, unknown>) {
  useAgentStore.getState().addSession({
    id: 's1',
    type: 'claude-code',
    status: 'idle',
    projectPath: '/repo/app',
    ...overrides,
  } as never)
}

describe('executionRootForSession', () => {
  it('returns null for a missing session', () => {
    expect(executionRootForSession(null)).toBeNull()
    expect(executionRootForSession(undefined)).toBeNull()
  })

  it('returns null when the session has no project path', () => {
    expect(executionRootForSession({ projectPath: undefined })).toBeNull()
  })

  it('uses the project path when no worktree is attached', () => {
    const root = executionRootForSession({ projectPath: '/repo/app' })
    expect(root?.path).toBe('/repo/app')
    expect(root?.isWorktree).toBe(false)
  })

  it('uses the worktree path and branch when one is attached', () => {
    const root = executionRootForSession({
      projectPath: '/repo/app',
      worktreePath: '/wt/feat',
      worktreeBranch: 'sb/feat',
    })
    expect(root?.path).toBe('/wt/feat')
    expect(root?.branch).toBe('sb/feat')
    expect(root?.isWorktree).toBe(true)
  })

  it('carries the session machine so a remote root is never read as local', () => {
    expect(executionRootForSession({ projectPath: '/srv/app', machineId: 'vm-7' })?.machineId)
      .toBe('vm-7')
  })

  it('defaults an absent machine to local', () => {
    expect(executionRootForSession({ projectPath: '/repo/app' })?.machineId).toBe('local')
  })

  it('carries the execution-root revision', () => {
    expect(executionRootForSession({ projectPath: '/repo/app', executionRootRevision: 5 })?.revision)
      .toBe(5)
  })
})

describe('sessionExecutionRoot / sessionExecutionRootPath', () => {
  it('returns null and undefined for a null session id', () => {
    expect(sessionExecutionRoot(null)).toBeNull()
    expect(sessionExecutionRootPath(null)).toBeUndefined()
  })

  it('returns null and undefined for an unknown session id', () => {
    addSession({})
    expect(sessionExecutionRoot('nope')).toBeNull()
    expect(sessionExecutionRootPath('nope')).toBeUndefined()
  })

  it('reads the parent checkout for a session with no worktree', () => {
    addSession({})
    expect(sessionExecutionRootPath('s1')).toBe('/repo/app')
  })

  it('reads the worktree for a session that followed one', () => {
    addSession({ worktreePath: '/wt/feat', worktreeBranch: 'sb/feat' })
    expect(sessionExecutionRootPath('s1')).toBe('/wt/feat')
  })

  it('follows a live setWorktree so a new terminal opens in the new root', () => {
    addSession({})
    expect(sessionExecutionRootPath('s1')).toBe('/repo/app')
    useAgentStore.getState().setWorktree('s1', '/wt/feat', 'sb/feat')
    expect(sessionExecutionRootPath('s1')).toBe('/wt/feat')
  })

  it('returns to the parent checkout when the worktree pointer is cleared', () => {
    addSession({ worktreePath: '/wt/feat', worktreeBranch: 'sb/feat' })
    useAgentStore.getState().setWorktree('s1', null, null)
    expect(sessionExecutionRootPath('s1')).toBe('/repo/app')
  })
})
