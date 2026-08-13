/** Pure sidebar projections. Managed SQLite roots are authoritative; the
 * older scan-merging helpers remain below for migration tests and rollback. */
import type { ConversationRow } from '../db/database'
import type { SessionSummary, SessionSource } from '@shared/types'

/** Project the app-owned roots that are allowed in the normal sidebar. */
export function projectManagedRootSessions(
  dbConversations: ConversationRow[],
  delegatedConversationIds: ReadonlySet<string> = new Set(),
): SessionSummary[] {
  return dbConversations
    .filter((conversation) => conversation.archived === 0 && !delegatedConversationIds.has(conversation.id))
    .map((conversation) => ({
      id: conversation.id,
      source: (conversation.agent_type === 'terminal' ? 'switchboard' : conversation.agent_type) as SessionSource,
      title: conversation.title,
      startedAt: conversation.updated_at,
      messageCount: 0,
      filePath: '',
      agentType: conversation.agent_type,
      worktreePath: conversation.worktree_path ?? null,
      worktreeBranch: conversation.worktree_branch ?? null,
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

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
  childSet: Set<string> = new Set(),
): SessionSummary[] {
  return dbConversations
    .filter(
      (c) =>
        !archivedSet.has(c.id) &&
        // Own id scanned: either shown already, or hidden on purpose by a merge.
        !scannedIds.has(c.id) &&
        // Transcript scanned: that entry represents this row - UNLESS childSet
        // hid it, in which case this row is the only thing left to render.
        !(c.session_id !== null && scannedIds.has(c.session_id) && !childSet.has(c.session_id)),
    )
    .map((c) => ({
      id: c.id,
      // agent_type is 'claude-code' | 'codex' | 'opencode' | 'terminal'; the
      // first three are valid SessionSource values, terminal maps to switchboard.
      source: (c.agent_type === 'terminal' ? 'switchboard' : c.agent_type) as SessionSource,
      title: c.title,
      // updated_at, not created_at: the sidebar sorts and labels by this as
      // "last activity" (see sessionActivity.ts), and saveMessage bumps it.
      // A worktree-run chat only ever renders through this path, so it sat in
      // the sidebar stamped with its creation time - measured 2 days stale.
      startedAt: c.updated_at,
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

/**
 * Project a visible SessionSummary into the ConversationRow shape the phone
 * consumes, so both clients address a chat by the SAME id.
 *
 * Filtering rows by the visible-id set does NOT work and is the trap here: a
 * desktop Claude chat is a row keyed `agent_<ms>` while its visible id is the
 * scanned transcript UUID, so the intersection is empty and the chat vanishes
 * (measured: 98 chats). The list has to come FROM the summaries. Taking `s.id`
 * is also the point of the exercise - runtime events are keyed on threadId, so
 * a phone opening the twin id saw none of the desktop's events.
 *
 * `updated_at` from `startedAt` is a bonus fix: the phone sorts on it, and it
 * was previously only ever moved by the desktop renderer's saveMessage, so a
 * phone-driven chat never rose to the top.
 */
export function sessionSummaryToConversationRow(
  s: SessionSummary,
  projectPath: string,
): ConversationRow {
  return {
    id: s.id,
    project_path: projectPath,
    agent_type: s.agentType ?? (s.source === 'switchboard' ? 'terminal' : s.source),
    session_id: null,
    title: s.title ?? 'Untitled',
    created_at: s.startedAt,
    updated_at: s.startedAt,
    archived: 0,
    worktree_path: s.worktreePath ?? null,
    worktree_branch: s.worktreeBranch ?? null,
  } as ConversationRow
}
