/**
 * Pure helper tests for terminal session injection and agentType stamping.
 *
 * Terminal sessions are DB-only - they have no JSONL file so the file
 * scanner never finds them. `synthesizeTerminalSessions` builds synthetic
 * SessionSummary entries from conversations rows; `stampAgentTypes` stamps
 * `agentType` onto file-scanned sessions that already have a DB record.
 *
 * These helpers power SCAN_SESSIONS and GET_PROJECTS in app.ts.
 */
import { describe, it, expect } from 'vitest'
import {
  synthesizeTerminalSessions,
  stampAgentTypes,
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

// ─── synthesizeTerminalSessions ───────────────────────────────────────────────

describe('synthesizeTerminalSessions', () => {
  it('returns a SessionSummary for each terminal row', () => {
    const rows = [
      makeRow({ id: 't1', agent_type: 'terminal', title: 'claude session', created_at: 5000 }),
      makeRow({ id: 't2', agent_type: 'terminal', title: 'codex session', created_at: 6000 }),
    ]
    const result = synthesizeTerminalSessions(rows, new Set(), new Set())
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      id: 't1',
      source: 'switchboard',
      title: 'claude session',
      startedAt: 5000,
      messageCount: 0,
      filePath: '',
      agentType: 'terminal',
    })
    expect(result[1].id).toBe('t2')
  })

  it('excludes non-terminal rows', () => {
    const rows = [
      makeRow({ id: 'c1', agent_type: 'claude-code' }),
      makeRow({ id: 'x1', agent_type: 'codex' }),
      makeRow({ id: 't1', agent_type: 'terminal' }),
    ]
    const result = synthesizeTerminalSessions(rows, new Set(), new Set())
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('t1')
  })

  it('excludes archived terminal sessions', () => {
    const rows = [
      makeRow({ id: 't1', agent_type: 'terminal' }),
      makeRow({ id: 't2', agent_type: 'terminal' }),
    ]
    const archived = new Set(['t1'])
    const result = synthesizeTerminalSessions(rows, archived, new Set())
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('t2')
  })

  it('excludes IDs already present in scannedIds (dedup)', () => {
    const rows = [
      makeRow({ id: 't1', agent_type: 'terminal' }),
      makeRow({ id: 't2', agent_type: 'terminal' }),
    ]
    const scanned = new Set(['t1'])
    const result = synthesizeTerminalSessions(rows, new Set(), scanned)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('t2')
  })

  it('excludes a session that is both archived and scanned (belt-and-suspenders)', () => {
    const rows = [makeRow({ id: 't1', agent_type: 'terminal' })]
    const result = synthesizeTerminalSessions(rows, new Set(['t1']), new Set(['t1']))
    expect(result).toHaveLength(0)
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
    const result = synthesizeTerminalSessions(rows, new Set(), new Set())
    expect(result[0].worktreePath).toBe('/repos/foo/.switchboard/worktrees/bar')
    expect(result[0].worktreeBranch).toBe('fork/bar')
  })

  it('sets worktreePath/worktreeBranch to null when row has none', () => {
    const rows = [makeRow({ id: 't1', agent_type: 'terminal' })]
    const result = synthesizeTerminalSessions(rows, new Set(), new Set())
    expect(result[0].worktreePath).toBeNull()
    expect(result[0].worktreeBranch).toBeNull()
  })

  it('returns empty array when there are no terminal rows', () => {
    const rows = [makeRow({ id: 'c1', agent_type: 'claude-code' })]
    expect(synthesizeTerminalSessions(rows, new Set(), new Set())).toHaveLength(0)
  })

  it('returns empty array for empty input', () => {
    expect(synthesizeTerminalSessions([], new Set(), new Set())).toHaveLength(0)
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
