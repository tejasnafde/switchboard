/**
 * Pure helper tests for DB-only session injection and agentType stamping.
 *
 * `synthesizeDbOnlySessions` builds synthetic SessionSummary entries for any
 * conversation the file scanner missed - terminal sessions (never had a JSONL)
 * and provider conversations whose JSONL was pruned/rotated away (Claude Code
 * cleans out ~/.claude/projects). `stampAgentTypes` stamps `agentType` onto
 * file-scanned sessions that already have a DB record.
 *
 * These helpers power SCAN_SESSIONS and GET_PROJECTS in app.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  projectManagedRootSessions,
  synthesizeDbOnlySessions,
  stampAgentTypes,
  sessionSummaryToConversationRow,
} from '../../src/main/ipc/terminal-sessions'
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

// ─── SessionSummary fixture ───────────────────────────────────────────────────

function makeSession(over: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    source: 'claude-code',
    title: 'untitled',
    startedAt: 1000,
    messageCount: 0,
    filePath: '/some/file.jsonl',
    ...over,
  }
}

// ─── synthesizeDbOnlySessions ─────────────────────────────────────────────────

describe('synthesizeDbOnlySessions', () => {
  it('returns a SessionSummary for each terminal row', () => {
    const rows = [
      makeRow({ id: 't1', agent_type: 'terminal', title: 'claude session', created_at: 5000, updated_at: 7000 }),
      makeRow({ id: 't2', agent_type: 'terminal', title: 'codex session', created_at: 6000, updated_at: 8000 }),
    ]
    const result = synthesizeDbOnlySessions(rows, new Set(), new Set())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      id: 't1',
      source: 'switchboard',
      title: 'claude session',
      // updated_at, not created_at. The sidebar sorts on startedAt as last
      // activity, and a worktree chat renders ONLY through this synthesizer.
      startedAt: 7000,
      messageCount: 0,
      filePath: '',
      agentType: 'terminal',
    })
    expect(result[1].id).toBe('t2')
  })

  it('surfaces provider rows whose JSONL the scanner did not find (the someday bug)', () => {
    // Claude Code pruned ~/.claude/projects/<encoded>, so scannedIds is empty
    // even though the conversation and its messages live in the DB.
    const rows = [
      makeRow({ id: 'agent_1', agent_type: 'claude-code', title: 'v0', session_id: 'uuid-a' }),
      makeRow({ id: 'agent_2', agent_type: 'codex', title: 'Bug fixing', session_id: null }),
    ]
    const result = synthesizeDbOnlySessions(rows, new Set(), new Set())
    expect(result).toHaveLength(2)
    expect(result.map((s) => s.id)).toEqual(['agent_1', 'agent_2'])
  })

  it('maps agent_type to the correct SessionSource', () => {
    const rows = [
      makeRow({ id: 'a', agent_type: 'claude-code' }),
      makeRow({ id: 'b', agent_type: 'codex' }),
      makeRow({ id: 'c', agent_type: 'opencode' }),
      makeRow({ id: 'd', agent_type: 'terminal' }),
    ]
    const result = synthesizeDbOnlySessions(rows, new Set(), new Set())
    expect(result.map((s) => s.source)).toEqual(['claude-code', 'codex', 'opencode', 'switchboard'])
    expect(result.map((s) => s.agentType)).toEqual(['claude-code', 'codex', 'opencode', 'terminal'])
  })

  it('excludes a conversation whose session_id was scanned (no dup with disk entry)', () => {
    // Live Claude conversation: DB id is agent_*, disk JSONL is the session UUID.
    // Matching only on c.id would duplicate it; matching session_id dedups.
    const rows = [
      makeRow({ id: 'agent_live', agent_type: 'claude-code', session_id: 'uuid-on-disk' }),
      makeRow({ id: 'agent_gone', agent_type: 'claude-code', session_id: 'uuid-pruned' }),
    ]
    const scanned = new Set(['uuid-on-disk'])
    const result = synthesizeDbOnlySessions(rows, new Set(), scanned)
    expect(result.map((s) => s.id)).toEqual(['agent_gone'])
  })

  it('excludes archived rows', () => {
    const rows = [
      makeRow({ id: 'c1', agent_type: 'claude-code' }),
      makeRow({ id: 'c2', agent_type: 'claude-code' }),
    ]
    const result = synthesizeDbOnlySessions(rows, new Set(['c1']), new Set())
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('c2')
  })

  it('excludes IDs already present in scannedIds (dedup)', () => {
    const rows = [
      makeRow({ id: 't1', agent_type: 'terminal' }),
      makeRow({ id: 't2', agent_type: 'terminal' }),
    ]
    const result = synthesizeDbOnlySessions(rows, new Set(), new Set(['t1']))
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('t2')
  })

  it('excludes a session that is both archived and scanned (belt-and-suspenders)', () => {
    const rows = [makeRow({ id: 't1', agent_type: 'terminal' })]
    const result = synthesizeDbOnlySessions(rows, new Set(['t1']), new Set(['t1']))
    expect(result).toHaveLength(0)
  })

  it('does not treat a null session_id as a scanned match', () => {
    // scannedIds should never contain an empty string, but guard anyway.
    const rows = [makeRow({ id: 'c1', agent_type: 'claude-code', session_id: null })]
    const result = synthesizeDbOnlySessions(rows, new Set(), new Set(['']))
    expect(result).toHaveLength(1)
  })

  it('propagates worktree fields when set', () => {
    const rows = [
      makeRow({
        id: 't1',
        agent_type: 'terminal',
        worktree_path: '/repos/foo/.switchboard/worktrees/bar',
        worktree_branch: 'fork/bar',
      }),
    ]
    const result = synthesizeDbOnlySessions(rows, new Set(), new Set())
    expect(result[0].worktreePath).toBe('/repos/foo/.switchboard/worktrees/bar')
    expect(result[0].worktreeBranch).toBe('fork/bar')
  })

  it('sets worktreePath/worktreeBranch to null when row has none', () => {
    const rows = [makeRow({ id: 't1', agent_type: 'terminal' })]
    const result = synthesizeDbOnlySessions(rows, new Set(), new Set())
    expect(result[0].worktreePath).toBeNull()
    expect(result[0].worktreeBranch).toBeNull()
  })

  it('returns empty array for empty input', () => {
    expect(synthesizeDbOnlySessions([], new Set(), new Set())).toHaveLength(0)
  })
})

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

  it('excludes archived rows from the normal sidebar projection', () => {
    const rows = [
      makeRow({ id: 'active', updated_at: 10 }),
      makeRow({ id: 'archived', archived: 1, updated_at: 20 }),
    ]

    expect(projectManagedRootSessions(rows).map((session) => session.id)).toEqual(['active'])
  })

  it('keeps user-created forks as roots even though they have fork lineage', () => {
    const rows = [
      makeRow({ id: 'fork', parent_conversation_id: 'source', title: 'source · fork/fix' }),
    ]

    expect(projectManagedRootSessions(rows).map((session) => session.id)).toEqual(['fork'])
  })
})

// ─── stampAgentTypes ──────────────────────────────────────────────────────────

describe('stampAgentTypes', () => {
  it('stamps agentType onto sessions present in the map', () => {
    const sessions = [
      makeSession({ id: 's1' }),
      makeSession({ id: 's2' }),
    ]
    const map = new Map([['s1', 'claude-code'], ['s2', 'codex']])
    const result = stampAgentTypes(sessions, map)
    expect(result[0].agentType).toBe('claude-code')
    expect(result[1].agentType).toBe('codex')
  })

  it('leaves sessions absent from the map unchanged', () => {
    const sessions = [makeSession({ id: 's1' })]
    const result = stampAgentTypes(sessions, new Map())
    expect(result[0].agentType).toBeUndefined()
  })

  it('does not mutate the original session objects', () => {
    const original = makeSession({ id: 's1' })
    const sessions = [original]
    const result = stampAgentTypes(sessions, new Map([['s1', 'claude-code']]))
    expect(result[0]).not.toBe(original) // new object
    expect(original.agentType).toBeUndefined() // original untouched
  })

  it('preserves all existing fields when stamping', () => {
    const sessions = [
      makeSession({
        id: 's1',
        title: 'My session',
        startedAt: 9999,
        messageCount: 42,
        worktreePath: '/wt',
        worktreeBranch: 'sb/foo',
      }),
    ]
    const result = stampAgentTypes(sessions, new Map([['s1', 'opencode']]))
    expect(result[0]).toMatchObject({
      id: 's1',
      title: 'My session',
      startedAt: 9999,
      messageCount: 42,
      worktreePath: '/wt',
      worktreeBranch: 'sb/foo',
      agentType: 'opencode',
    })
  })

  it('handles empty session list', () => {
    expect(stampAgentTypes([], new Map([['s1', 'claude-code']]))).toHaveLength(0)
  })

  it('handles empty map (no DB records)', () => {
    const sessions = [makeSession({ id: 's1' }), makeSession({ id: 's2' })]
    const result = stampAgentTypes(sessions, new Map())
    expect(result).toHaveLength(2)
    result.forEach((s) => expect(s.agentType).toBeUndefined())
  })

  it('mixed: some sessions in map, some not', () => {
    const sessions = [
      makeSession({ id: 'known' }),
      makeSession({ id: 'unknown' }),
    ]
    const result = stampAgentTypes(sessions, new Map([['known', 'codex']]))
    expect(result.find((s) => s.id === 'known')?.agentType).toBe('codex')
    expect(result.find((s) => s.id === 'unknown')?.agentType).toBeUndefined()
  })
})

describe('why a scanned transcript was hidden decides whether to synthesize', () => {
  const conv = (over: Record<string, unknown>) =>
    [{ id: 'c1', session_id: null, title: 't', agent_type: 'claude-code', ...over }] as never

  it('keeps the row when childSet hid the transcript, or the chat renders nowhere', () => {
    // A chat started on the phone wrote its JSONL under a non-default Claude
    // profile dir, so the scanner saw it and thread_sessions recorded it as a
    // rotation child. The scanned entry was dropped as a child and the row was
    // dropped as its duplicate.
    const rows = conv({ id: 'mob-1', session_id: 'uuid-a' })
    expect(synthesizeDbOnlySessions(rows, new Set(), new Set(['uuid-a']), new Set(['uuid-a']))).toHaveLength(1)
  })

  it('suppresses the row when the transcript was hidden by archiving', () => {
    // Archiving a live chat archives the SCANNED id, leaving the parent row
    // unarchived. Synthesizing it here would resurrect the chat one refresh later.
    const rows = conv({ id: 'agent_1000', session_id: 'uuid-a' })
    expect(synthesizeDbOnlySessions(rows, new Set(), new Set(['uuid-a']), new Set())).toHaveLength(0)
  })

  it('suppresses a merged fragment, which has a row of its own under the scanned id', () => {
    // attach-to-thread promises the fragment disappears; it is in childSet, so
    // only the own-id check can suppress it.
    const rows = conv({ id: 'uuid-frag', session_id: null })
    expect(synthesizeDbOnlySessions(rows, new Set(), new Set(['uuid-frag']), new Set(['uuid-frag']))).toHaveLength(0)
  })

  it('suppresses a duplicate of a transcript that is plainly visible', () => {
    const rows = conv({ id: 'c1', session_id: 'uuid-b' })
    expect(synthesizeDbOnlySessions(rows, new Set(), new Set(['uuid-b']), new Set())).toHaveLength(0)
  })
})

/**
 * GET_CONVERSATIONS (the phone's list) is built from these, so the phone and the
 * desktop address a chat by one id. Filtering conversation ROWS by the visible
 * id set was tried and drops 98 chats on a real install: a desktop Claude chat
 * is a row keyed `agent_<ms>` whose visible id is the transcript UUID, so the
 * intersection is empty.
 */
describe('sessionSummaryToConversationRow', () => {
  const summary = (over: Partial<SessionSummary> = {}): SessionSummary => ({
    id: 'a3717923-940a-47bf-a15e-cfd4f9cc194a',
    source: 'claude-code',
    title: 'Lat Lng',
    startedAt: 7000,
    messageCount: 0,
    filePath: '/x.jsonl',
    ...over,
  } as SessionSummary)

  it('carries the summary id, which is the id runtime events are keyed on', () => {
    expect(sessionSummaryToConversationRow(summary(), '/repo').id)
      .toBe('a3717923-940a-47bf-a15e-cfd4f9cc194a')
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
    expect(sessionSummaryToConversationRow(summary({ startedAt: 12345 }), '/repo').updated_at)
      .toBe(12345)
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
