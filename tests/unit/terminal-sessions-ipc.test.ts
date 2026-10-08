/** Pure sidebar projection tests for SCAN_SESSIONS and GET_PROJECTS in app.ts. */
import { describe, it, expect } from 'vitest'
import { projectManagedRootSessions, sessionSummaryToConversationRow } from '../../src/main/ipc/terminal-sessions'
import type { ConversationRow } from '../../src/main/db/database'
import type { SessionSummary } from '../../src/shared/types'

// ─── ConversationRow fixture ──────────────────────────────────────────────────

function makeRow(over: Partial<ConversationRow> & { id: string }): ConversationRow {
  return {
    project_path: '/projects/foo',
    agent_type: 'claude-code',
    session_id: null,
    title: 'untitled',
    created_at: 1000,
    updated_at: 1000,
    archived: 0,
    parent_conversation_id: null,
    forked_at_message_id: null,
    worktree_path: null,
    worktree_branch: null,
    ...over,
  }
}

describe('projectManagedRootSessions', () => {
  it('uses managed database conversations as the complete sidebar source', () => {
    const rows = [
      makeRow({ id: 'v0', title: 'v0', updated_at: 9000 }),
      makeRow({ id: 'codex-child', agent_type: 'codex', title: 'Codex 45', updated_at: 9500 }),
    ]

    const result = projectManagedRootSessions(rows, new Set(['codex-child']))

    expect(result.map((session) => session.id)).toEqual(['v0'])
    expect(result[0]).toMatchObject({ title: 'v0', startedAt: 9000, filePath: '' })
  })

  it('carries the stored status line into the session list every client loads', () => {
    const rows = [makeRow({ id: 'summarised', status_line: 'Tests pass, PR open' }), makeRow({ id: 'bare' })]
    const sessions = projectManagedRootSessions(rows)

    expect(sessions.map((s) => s.statusLine)).toEqual(['Tests pass, PR open', null])
    expect(sessionSummaryToConversationRow(sessions[0], '/projects/foo').status_line).toBe('Tests pass, PR open')
    expect(sessionSummaryToConversationRow(sessions[1], '/projects/foo').status_line).toBeNull()
  })

  it('excludes archived rows from the normal sidebar projection', () => {
    const rows = [makeRow({ id: 'active', updated_at: 10 }), makeRow({ id: 'archived', archived: 1, updated_at: 20 })]

    expect(projectManagedRootSessions(rows).map((session) => session.id)).toEqual(['active'])
  })

  it('keeps user-created forks as roots even though they have fork lineage', () => {
    const rows = [makeRow({ id: 'fork', parent_conversation_id: 'source', title: 'source · fork/fix' })]

    expect(projectManagedRootSessions(rows).map((session) => session.id)).toEqual(['fork'])
  })

  it('marks a retained worktree conversation as recoverable instead of ready', () => {
    const rows = [
      makeRow({
        id: 'retained',
        worktree_creation_id: 'creation-retained',
        worktree_creation_status: 'cleanup_required',
        worktree_creation_recovery_json: JSON.stringify({ disposition: 'retained' }),
      }),
    ]

    expect(projectManagedRootSessions(rows)).toMatchObject([
      {
        id: 'retained',
        worktreeCreationId: 'creation-retained',
        worktreeRecovery: {
          status: 'cleanup_required',
          cleanupDisposition: 'retained',
        },
      },
    ])
  })
})

describe('sessionSummaryToConversationRow', () => {
  const summary = (over: Partial<SessionSummary> = {}): SessionSummary =>
    ({
      id: 'a3717923-940a-47bf-a15e-cfd4f9cc194a',
      source: 'claude-code',
      title: 'Lat Lng',
      startedAt: 7000,
      messageCount: 0,
      filePath: '/x.jsonl',
      ...over,
    }) as SessionSummary

  it('carries the summary id, which is the id runtime events are keyed on', () => {
    expect(sessionSummaryToConversationRow(summary(), '/repo').id).toBe('a3717923-940a-47bf-a15e-cfd4f9cc194a')
  })

  it('carries the worktree so the phone starts the agent in the right tree', () => {
    const row = sessionSummaryToConversationRow(
      summary({ worktreePath: '/private/tmp/wt-slack-channel', worktreeBranch: 'feat/x' }),
      '/repo',
    )
    expect(row.worktree_path).toBe('/private/tmp/wt-slack-channel')
    expect(row.worktree_branch).toBe('feat/x')
  })

  it('leaves worktree fields null when the chat has none', () => {
    const row = sessionSummaryToConversationRow(summary(), '/repo')
    expect(row.worktree_path).toBeNull()
    expect(row.worktree_branch).toBeNull()
  })

  it('sorts by real activity: updated_at comes from startedAt', () => {
    // The phone sorts on updated_at, which only the desktop renderer ever moved.
    expect(sessionSummaryToConversationRow(summary({ startedAt: 12345 }), '/repo').updated_at).toBe(12345)
  })

  it('prefers the stamped agentType over the scan source', () => {
    const row = sessionSummaryToConversationRow(summary({ source: 'claude-code', agentType: 'codex' }), '/repo')
    expect(row.agent_type).toBe('codex')
  })

  it('maps a terminal session back to its agent_type', () => {
    const row = sessionSummaryToConversationRow(summary({ source: 'switchboard', agentType: undefined }), '/repo')
    expect(row.agent_type).toBe('terminal')
  })

  it('stamps the project path it was listed under', () => {
    expect(sessionSummaryToConversationRow(summary(), '/repo').project_path).toBe('/repo')
  })
})
