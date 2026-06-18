/**
 * Pure helpers for surfacing terminal sessions in SCAN_SESSIONS / GET_PROJECTS.
 * Terminal sessions are DB-only (no JSONL), so the file scanner never finds them.
 */
import type { ConversationRow } from '../db/database'
import type { SessionSummary } from '@shared/types'

/** Build SessionSummary entries for terminal sessions in the DB not found by the file scanner. */
export function synthesizeTerminalSessions(
  dbConversations: ConversationRow[],
  archivedSet: Set<string>,
  scannedIds: Set<string>,
): SessionSummary[] {
  return dbConversations
    .filter((c) => c.agent_type === 'terminal' && !archivedSet.has(c.id) && !scannedIds.has(c.id))
    .map((c) => ({
      id: c.id,
      source: 'switchboard' as const,
      title: c.title,
      startedAt: c.created_at,
      messageCount: 0,
      filePath: '',
      agentType: 'terminal',
      worktreePath: c.worktree_path ?? null,
      worktreeBranch: c.worktree_branch ?? null,
    }))
}

/** Stamp `agentType` from the DB map onto file-scanned sessions. */
export function stampAgentTypes(
  sessions: SessionSummary[],
  agentTypeMap: Map<string, string>,
): SessionSummary[] {
  return sessions.map((s) =>
    agentTypeMap.has(s.id) ? { ...s, agentType: agentTypeMap.get(s.id) } : s,
  )
}
