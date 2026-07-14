/**
 * Pure helpers for surfacing DB-only sessions in SCAN_SESSIONS / GET_PROJECTS.
 *
 * The sidebar list is disk-scan-first: `scanAllSessions` finds provider JSONL
 * under ~/.claude/projects, ~/.codex, etc. But some conversations have no live
 * JSONL - terminal sessions never had one, and Claude Code prunes/rotates its
 * projects dir out from under us. Those conversations still live in SQLite
 * (with their messages), so we synthesize SessionSummary entries for any DB
 * conversation the file scanner didn't turn up. Without this, a conversation
 * whose JSONL was pruned vanishes from the sidebar entirely even though all its
 * messages are safe in the DB.
 */
import type { ConversationRow } from '../db/database'
import type { SessionSummary, SessionSource } from '@shared/types'

/**
 * Build SessionSummary entries for DB conversations the file scanner missed.
 *
 * A conversation is considered "already on disk" (and skipped) when either its
 * own id or its recorded `session_id` appears in `scannedIds`. That second
 * check matters for live Claude conversations: their conversation id is
 * `agent_<ts>` while the scanned JSONL is named after the session UUID, so
 * without matching on `session_id` every healthy conversation would be
 * duplicated - once from the scan, once synthesized here.
 */
export function synthesizeDbOnlySessions(
  dbConversations: ConversationRow[],
  archivedSet: Set<string>,
  scannedIds: Set<string>,
): SessionSummary[] {
  return dbConversations
    .filter(
      (c) =>
        !archivedSet.has(c.id) &&
        !scannedIds.has(c.id) &&
        !(c.session_id !== null && scannedIds.has(c.session_id)),
    )
    .map((c) => ({
      id: c.id,
      // agent_type is 'claude-code' | 'codex' | 'opencode' | 'terminal'; the
      // first three are valid SessionSource values, terminal maps to switchboard.
      source: (c.agent_type === 'terminal' ? 'switchboard' : c.agent_type) as SessionSource,
      title: c.title,
      startedAt: c.created_at,
      messageCount: 0,
      filePath: '',
      agentType: c.agent_type,
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
