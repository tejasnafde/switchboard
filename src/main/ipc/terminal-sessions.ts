/** Pure sidebar projections. Managed SQLite roots are authoritative. */
import type { ConversationRow } from '../db/database'
import type { SessionSummary, SessionSource } from '@shared/types'

function retainedWorktreeRecovery(conversation: ConversationRow): SessionSummary['worktreeRecovery'] {
  if (conversation.worktree_creation_status !== 'cleanup_required') return undefined
  try {
    const recovery = JSON.parse(conversation.worktree_creation_recovery_json ?? '{}') as { disposition?: unknown }
    return recovery.disposition === 'retained'
      ? { status: 'cleanup_required', cleanupDisposition: 'retained' }
      : undefined
  } catch {
    return undefined
  }
}

/** Project the app-owned roots that are allowed in the normal sidebar. */
export function projectManagedRootSessions(
  dbConversations: ConversationRow[],
  delegatedConversationIds: ReadonlySet<string> = new Set(),
): SessionSummary[] {
  return dbConversations
    .filter((conversation) => conversation.archived === 0 && !delegatedConversationIds.has(conversation.id))
    .map((conversation) => ({
      id: conversation.id,
      source: (conversation.origin_source ??
        (conversation.agent_type === 'terminal' ? 'switchboard' : conversation.agent_type)) as SessionSource,
      title: conversation.title,
      startedAt: conversation.updated_at,
      messageCount: 0,
      filePath: '',
      agentType: conversation.agent_type,
      worktreePath: conversation.worktree_path ?? null,
      worktreeBranch: conversation.worktree_branch ?? null,
      worktreeCreationId: conversation.worktree_creation_id ?? null,
      worktreeRecovery: retainedWorktreeRecovery(conversation),
      statusLine: conversation.status_line ?? null,
    }))
    .sort((a, b) => b.startedAt - a.startedAt)
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
export function sessionSummaryToConversationRow(s: SessionSummary, projectPath: string): ConversationRow {
  return {
    id: s.id,
    project_path: projectPath,
    agent_type: s.agentType ?? (s.source === 'switchboard' ? 'terminal' : s.source),
    session_id: null,
    title: s.title ?? 'Untitled',
    created_at: s.startedAt,
    updated_at: s.startedAt,
    origin_source: s.source === 'cursor' ? 'cursor' : null,
    archived: 0,
    worktree_path: s.worktreePath ?? null,
    worktree_branch: s.worktreeBranch ?? null,
    worktree_creation_id: s.worktreeCreationId ?? null,
    status_line: s.statusLine ?? null,
  } as ConversationRow
}
