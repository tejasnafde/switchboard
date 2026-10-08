import { createMainLogger as createLogger } from '../logger'
import type { RuntimeMode } from '@shared/provider-events'
import type { SessionSource } from '@shared/types'
import type { ConversationSidebarRole } from './conversation-sidebar-role'
import type { WorktreeCreationStatus } from '@shared/worktree-creation'
import { commitConversationProfileSwitch } from './conversation-profile-commit'
import { SqliteConversationForkStore } from './conversation-fork'
import type { ForkLineageMetadata } from '@shared/conversation-fork'
import { agentLabel, type AgentProvider, type AgentType } from '@shared/types'
import { AGENT_SWITCH_MARKER_PREFIX } from '@shared/rotation-marker'
import { nextPendingHandoffFrom } from '@shared/handoff'
import { getDb } from './database'
import type { ReasoningEffort } from '@shared/models'
import { isReasoningEffort, normalizeProviderOptionMemory, switchProviderOptions } from '@shared/provider-option-memory'
import { parseFollowSuggestionMode, recordWorkedWorktree, type FollowSuggestionMode } from '@shared/follow-suggestions'

const log = createLogger('db')

// ─── Conversation CRUD ──────────────────────────────────────────

export function createConversation(
  id: string,
  projectPath: string,
  agentType: string,
  title?: string,
  worktreePath?: string | null,
  worktreeBranch?: string | null,
): boolean {
  const now = Date.now()
  const catalogued = worktreePath
    ? getDb().prepare(`
        SELECT id FROM managed_worktrees
         WHERE machine_id = 'local' AND project_path = ? AND worktree_path = ?
           AND lifecycle != 'removed'
         ORDER BY CASE management_origin WHEN 'legacy' THEN 0 ELSE 1 END, created_at
         LIMIT 1
      `).get(projectPath, worktreePath) as { id: string } | undefined
    : undefined
  const info = getDb().prepare(
    `INSERT OR IGNORE INTO conversations (
       id, project_path, agent_type, title, created_at, updated_at,
       worktree_path, worktree_branch, worktree_id, sidebar_role
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'managed')`
  ).run(
    id,
    projectPath,
    agentType,
    title ?? 'New conversation',
    now,
    now,
    worktreePath ?? null,
    worktreeBranch ?? null,
    catalogued?.id ?? null,
  )
  return info.changes > 0
}

export function promoteConversationToManaged(
  id: string,
  projectPath: string,
  agentType: string,
  title: string,
): void {
  const database = getDb()
  createConversation(id, projectPath, agentType, title)
  database.prepare(
    `UPDATE conversations
     SET sidebar_role = 'managed', archived = 0, agent_type = ?, title = ?,
         session_id = COALESCE(session_id, ?), updated_at = ?
     WHERE id = ? AND project_path = ?`
  ).run(agentType, title, id, Date.now(), id, projectPath)
}

export type RecoveryReviveResult = 'revived' | 'missing' | 'project-mismatch'

/** Restore an existing logical conversation without changing how it resumes. */
export function reviveConversationForRecovery(
  id: string,
  projectPath: string,
  title: string,
): RecoveryReviveResult {
  const database = getDb()
  const existing = database.prepare(
    'SELECT project_path FROM conversations WHERE id = ?'
  ).get(id) as { project_path: string } | undefined
  if (!existing) return 'missing'
  if (existing.project_path !== projectPath) return 'project-mismatch'
  const result = database.prepare(
    `UPDATE conversations
     SET sidebar_role = 'managed', archived = 0, title = ?, updated_at = ?
     WHERE id = ? AND project_path = ?`
  ).run(title, Date.now(), id, projectPath)
  return result.changes > 0 ? 'revived' : 'missing'
}

export function getRecoveryConversationTitles(nativeSessionId: string): {
  nativeTitle: string | null
  rootTitle: string | null
} {
  const database = getDb()
  const native = database.prepare(
    'SELECT title FROM conversations WHERE id = ?'
  ).get(nativeSessionId) as { title: string } | undefined
  const rootId = resolveRootThreadId(nativeSessionId)
  const root = rootId === nativeSessionId
    ? native
    : database.prepare('SELECT title FROM conversations WHERE id = ?')
      .get(rootId) as { title: string } | undefined
  return {
    nativeTitle: native?.title ?? null,
    rootTitle: root?.title ?? null,
  }
}

/**
 * Update the worktree pointer on an existing conversation. Used by the
 * branch picker when the user picks a branch that already has a
 * worktree on disk.
 */
export function setConversationWorktree(
  id: string,
  worktreePath: string | null,
  worktreeBranch: string | null,
): void {
  // `resolveRootThreadId` for the reason recorded in CLAUDE.md: Claude
  // rotates a chat's session id mid-conversation, the sidebar then hands that
  // rotated id back as `session.id`, and a raw `WHERE id = ?` updates zero
  // rows in silence. This setter shipped without the fallback and so could
  // persist nothing at all after a rotation.
  getDb().prepare(
    `UPDATE conversations SET worktree_path = ?, worktree_branch = ?, updated_at = ? WHERE id = ?`
  ).run(worktreePath, worktreeBranch, Date.now(), resolveRootThreadId(id))
}

export interface StoredExecutionRoot {
  projectPath: string | null
  worktreePath: string | null
  worktreeBranch: string | null
  /** 0 for a row that has never been relocated, including a pre-migration row. */
  revision: number
}

/** The committed execution root for a conversation, or null if there is no row. */
export function getConversationExecutionRoot(id: string): StoredExecutionRoot | null {
  const row = getDb().prepare(
    'SELECT worktree_path, worktree_branch, execution_root_revision, project_path FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as {
    worktree_path: string | null
    worktree_branch: string | null
    execution_root_revision: number | null
    project_path: string | null
  } | undefined
  if (!row) return null
  return {
    projectPath: row.project_path ?? null,
    worktreePath: row.worktree_path ?? null,
    worktreeBranch: row.worktree_branch ?? null,
    revision: row.execution_root_revision ?? 0,
  }
}

/**
 * Move the durable execution root and bump its revision in ONE statement.
 *
 * Splitting these would make the revision decorative: a reader that saw the
 * new path against the old revision would still admit a second client holding
 * that old revision, which is exactly the race the token exists to stop.
 *
 * `COALESCE` rather than a backfill, so a database written before the column
 * existed needs no migration pass. Returns the new revision, or null when the
 * conversation does not exist - callers must not treat a missing row as a
 * successful relocation.
 */
export function commitConversationExecutionRoot(
  id: string,
  worktreePath: string | null,
  worktreeBranch: string | null,
): number | null {
  const rootId = resolveRootThreadId(id)
  const info = getDb().prepare(
    `UPDATE conversations
        SET worktree_path = ?, worktree_branch = ?,
            execution_root_revision = COALESCE(execution_root_revision, 0) + 1,
            updated_at = ?
      WHERE id = ?`
  ).run(worktreePath, worktreeBranch, Date.now(), rootId)
  if (info.changes === 0) return null
  return getConversationExecutionRoot(rootId)?.revision ?? null
}

export function updateConversationSessionId(id: string, sessionId: string): void {
  getDb().prepare(
    'UPDATE conversations SET session_id = ?, updated_at = ? WHERE id = ?'
  ).run(sessionId, Date.now(), id)
}

/** Returns false when the title was already this, so callers can skip a broadcast. */
export function updateConversationTitle(id: string, title: string): boolean {
  const info = getDb().prepare(
    'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND title IS NOT ?'
  ).run(title, Date.now(), resolveRootThreadId(id), title)
  return info.changes > 0
}

/**
 * One conversation's display title, or null when no row exists.
 *
 * Resolves through `resolveRootThreadId` for the same reason as the
 * per-conversation settings below: a caller holding Claude's rotated session
 * UUID would otherwise read nothing and label the chat with a raw id.
 */
export function getConversationTitle(id: string): string | null {
  const row = getDb().prepare(
    'SELECT title FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { title: string } | undefined
  return row?.title ?? null
}

export function getConversationsForProject(projectPath: string): ConversationRow[] {
  return getDb().prepare(
    'SELECT * FROM conversations WHERE project_path = ? ORDER BY updated_at DESC'
  ).all(projectPath) as ConversationRow[]
}

const MANAGED_ROOT_PREDICATE = `
  c.sidebar_role = 'managed' AND c.archived = 0
  AND NOT EXISTS (
    SELECT 1
    FROM thread_sessions ts
    JOIN conversations root ON root.id = ts.thread_id
    WHERE ts.claude_session_id = c.id
      AND ts.thread_id != c.id
      AND root.sidebar_role = 'managed'
  )
`

export function getManagedRootConversationsForProject(projectPath: string): ConversationRow[] {
  return getDb().prepare(
    `SELECT c.*,
            wc.status AS worktree_creation_status,
            wc.recovery_json AS worktree_creation_recovery_json
       FROM conversations c
       LEFT JOIN worktree_creations wc
         ON wc.creation_id = c.worktree_creation_id
     WHERE c.project_path = ? AND ${MANAGED_ROOT_PREDICATE}
       AND (
         c.worktree_creation_id IS NULL
         OR wc.status = 'ready'
         OR (
           wc.status = 'cleanup_required'
           AND CASE
             WHEN json_valid(wc.recovery_json)
             THEN json_extract(wc.recovery_json, '$.disposition')
           END = 'retained'
         )
       )
     ORDER BY c.updated_at DESC`
  ).all(projectPath) as ConversationRow[]
}

export function getManagedRootConversationsForProjects(projectPaths: string[]): Map<string, ConversationRow[]> {
  const result = new Map<string, ConversationRow[]>()
  for (const path of projectPaths) result.set(path, [])
  const database = getDb()
  const chunkSize = 500
  for (let offset = 0; offset < projectPaths.length; offset += chunkSize) {
    const chunk = projectPaths.slice(offset, offset + chunkSize)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = database.prepare(
      `SELECT c.*,
              wc.status AS worktree_creation_status,
              wc.recovery_json AS worktree_creation_recovery_json
         FROM conversations c
         LEFT JOIN worktree_creations wc
           ON wc.creation_id = c.worktree_creation_id
       WHERE c.project_path IN (${placeholders}) AND ${MANAGED_ROOT_PREDICATE}
         AND (
           c.worktree_creation_id IS NULL
           OR wc.status = 'ready'
           OR (
             wc.status = 'cleanup_required'
             AND CASE
               WHEN json_valid(wc.recovery_json)
               THEN json_extract(wc.recovery_json, '$.disposition')
             END = 'retained'
           )
         )
       ORDER BY c.updated_at DESC`
    ).all(...chunk) as ConversationRow[]
    for (const row of rows) result.get(row.project_path)?.push(row)
  }
  return result
}

export interface ConversationRow {
  id: string
  project_path: string
  agent_type: string
  session_id: string | null
  title: string
  created_at: number
  updated_at: number
  archived: number
  origin_source?: SessionSource | null
  sidebar_role?: ConversationSidebarRole | null
  /** ID of the source conversation a fork was spun from. Null for native conversations. */
  parent_conversation_id?: string | null
  /** ID of the source message the fork was anchored at. Null for non-forks. */
  forked_at_message_id?: string | null
  /** Absolute path to the git worktree backing this conversation. Null if the
   *  fork did not opt into a worktree (or this is not a fork at all). */
  worktree_path?: string | null
  /** Branch checked out in the fork's worktree (e.g. `fork/fix-redis-timeout`).
   *  Null when `worktree_path` is null. */
  worktree_branch?: string | null
  /** Optimistic-concurrency token for the execution root. Null on a row that
   *  predates the column, which reads as 0: it has never been relocated. */
  execution_root_revision?: number | null
  worktree_id?: string | null
  worktree_creation_id?: string | null
  worktree_creation_status?: WorktreeCreationStatus | null
  worktree_creation_recovery_json?: string | null
  provider_instance_id?: string | null
  runtime_mode?: RuntimeMode | null
  model?: string | null
  reasoning_effort?: string | null
  launch_config_name?: string | null
  pending_handoff_from?: string | null
  fork_anchor_digest?: string | null
  fork_anchor_role?: string | null
  fork_anchor_timestamp?: number | null
  fork_anchor_canonical_count?: number | null
  fork_resume_mode?: string | null
  fork_anchor_preview?: string | null
  fork_git_base_sha?: string | null
  fork_source_dirty?: number | null
  fork_omitted_change_summary?: string | null
  /** Last finished turn's preview line - see `setConversationStatusLine`. */
  status_line?: string | null
}

/** Look up a single conversation by id. Used by search navigation to
 *  hydrate a session the user jumped into from ⌘⇧F. */
export function getConversationById(id: string): ConversationRow | undefined {
  return getDb().prepare(
    'SELECT * FROM conversations WHERE id = ?'
  ).get(id) as ConversationRow | undefined
}

/** Resolve a provider-rotated session UUID to Switchboard's durable thread row. */
export function getConversationByThreadId(id: string): ConversationRow | undefined {
  return getConversationById(resolveRootThreadId(id))
}

export function getConversationForkMetadata(id: string): ForkLineageMetadata | null {
  const result = new SqliteConversationForkStore(getDb()).getResultForConversation(id)
  if (!result) return null
  return {
    ...(result.conversation.machineId ? { machineId: result.conversation.machineId } : {}),
    parentConversationId: result.conversation.parentConversationId,
    parentTitle: result.conversation.parentTitle,
    anchor: result.conversation.anchor,
    resumeMode: result.conversation.resumeMode,
    ...(result.git ? { git: result.git } : {}),
    warnings: result.warnings,
  }
}

// ─── Thread ancestry ─────────────────────────────────────────────

/**
 * Record that `claudeSessionId` belongs to `threadId`.
 *
 * FLATTENS the chain on insert - if `threadId` is itself a child of some
 * deeper root, we resolve to that root first. And if `claudeSessionId`
 * already has descendants, we re-parent them too. Result: the table
 * always stores a two-level relationship (leaf → ultimate root), never
 * chains like `A → B → C`.
 *
 * Without flattening, `listSessionIdsForThread(C)` would miss A because
 * A's direct parent is B, not C.
 */
export function recordThreadSession(claudeSessionId: string, threadId: string): void {
  if (claudeSessionId === threadId) return // self-reference - nothing to track
  const db = getDb()
  const now = Date.now()

  // Walk up from `threadId` to the ultimate root (in case the caller
  // passed an intermediate that's itself a child of something else).
  const root = resolveRootThreadId(threadId)
  if (root === claudeSessionId) return // would create a cycle; refuse

  db.transaction(() => {
    // Set claudeSessionId → root
    db.prepare(
      'INSERT OR REPLACE INTO thread_sessions (claude_session_id, thread_id, recorded_at) VALUES (?, ?, ?)'
    ).run(claudeSessionId, root, now)
    // Re-parent anything that previously pointed at claudeSessionId so
    // they all point at the new root (chain flattening).
    db.prepare(
      'UPDATE thread_sessions SET thread_id = ? WHERE thread_id = ?'
    ).run(root, claudeSessionId)
  })()
}

/**
 * Return the root thread_id for a given claude_session_id. Walks the
 * parent chain until it hits a terminal (no row) - handles legacy rows
 * from before `recordThreadSession` flattened on insert.
 */
export function resolveRootThreadId(claudeSessionId: string): string {
  const stmt = getDb().prepare(
    'SELECT thread_id FROM thread_sessions WHERE claude_session_id = ?'
  )
  let cur = claudeSessionId
  const seen = new Set<string>()
  while (true) {
    if (seen.has(cur)) return cur // cycle guard (shouldn't happen)
    seen.add(cur)
    const row = stmt.get(cur) as { thread_id: string } | undefined
    if (!row || row.thread_id === cur) return cur
    cur = row.thread_id
  }
}

/**
 * Every claude_session_id that belongs to a given thread (as root). Walks
 * down all descendant links, so a chain `A → B → C` where we ask for `C`
 * returns `[C, B, A]` regardless of how the chain was recorded.
 *
 * Always includes `threadId` itself so callers don't need to special-case.
 */
/**
 * Every conversation id one thread answers to: root plus rotated session ids.
 * Per-thread WRITES need all of them, since a rotated chat owns a row per id
 * and updating one leaves the rest stale. Reads can use `resolveRootThreadId`.
 */
export function threadFamilyIds(id: string): string[] {
  return listSessionIdsForThread(resolveRootThreadId(id))
}

/** Native-session ids persisted before typed segments shipped. */
export function conversationSessionHints(id: string): string[] {
  const familyIds = threadFamilyIds(id)
  const hints: string[] = []
  const seen = new Set<string>()
  const stmt = getDb().prepare('SELECT session_id FROM conversations WHERE id = ?')
  for (const familyId of familyIds) {
    const row = stmt.get(familyId) as { session_id: string | null } | undefined
    if (!row?.session_id || seen.has(row.session_id)) continue
    seen.add(row.session_id)
    hints.push(row.session_id)
  }
  return hints
}

export function listSessionIdsForThread(threadId: string): string[] {
  const db = getDb()
  const directStmt = db.prepare(
    'SELECT claude_session_id, recorded_at FROM thread_sessions WHERE thread_id = ? ORDER BY recorded_at ASC'
  )
  const result: string[] = [threadId]
  const visited = new Set<string>([threadId])
  // BFS - each queued id's direct children are added. With flattening
  // this is usually a single layer, but the walk handles legacy chains.
  const queue: string[] = [threadId]
  while (queue.length > 0) {
    const id = queue.shift()!
    const rows = directStmt.all(id) as Array<{ claude_session_id: string; recorded_at: number }>
    for (const r of rows) {
      if (visited.has(r.claude_session_id)) continue
      visited.add(r.claude_session_id)
      result.push(r.claude_session_id)
      queue.push(r.claude_session_id)
    }
  }
  return result
}

export type ConversationSegmentProvider = AgentProvider

export interface ConversationSegmentRow {
  id: string
  conversation_id: string
  provider: ConversationSegmentProvider
  provider_session_id: string
  provider_instance_id: string | null
  ordinal: number
  created_at: number
  updated_at: number
}

export function recordConversationSegment(input: {
  conversationId: string
  provider: ConversationSegmentProvider
  providerSessionId: string
  providerInstanceId?: string | null
}): void {
  const database = getDb()
  const conversationId = resolveRootThreadId(input.conversationId)
  const now = Date.now()
  database.transaction(() => {
    const existing = database.prepare(
      `SELECT id FROM conversation_segments
       WHERE conversation_id = ? AND provider = ? AND provider_session_id = ?`
    ).get(conversationId, input.provider, input.providerSessionId) as { id: string } | undefined
    if (existing) {
      database.prepare(
        `UPDATE conversation_segments
         SET provider_instance_id = COALESCE(?, provider_instance_id), updated_at = ?
         WHERE id = ?`
      ).run(input.providerInstanceId ?? null, now, existing.id)
      return
    }
    const next = database.prepare(
      'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM conversation_segments WHERE conversation_id = ?'
    ).get(conversationId) as { ordinal: number }
    database.prepare(
      `INSERT INTO conversation_segments (
         id, conversation_id, provider, provider_session_id,
         provider_instance_id, ordinal, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${conversationId}:${input.provider}:${input.providerSessionId}`,
      conversationId,
      input.provider,
      input.providerSessionId,
      input.providerInstanceId ?? null,
      next.ordinal,
      now,
      now,
    )
  })()
}

export function listConversationSegments(conversationId: string): ConversationSegmentRow[] {
  return getDb().prepare(
    `SELECT * FROM conversation_segments
     WHERE conversation_id = ? ORDER BY ordinal ASC, created_at ASC`
  ).all(resolveRootThreadId(conversationId)) as ConversationSegmentRow[]
}

/** Resolve an explicitly managed root that already owns a native session.
 * `promotedOnly` keeps a delegated run from resolving to its original parent;
 * promotion is a new root and is idempotent on subsequent imports. */
export function findManagedConversationForNativeSession(
  provider: ConversationSegmentProvider,
  providerSessionId: string,
  promotedOnly = false,
): string | null {
  const row = getDb().prepare(
    `SELECT c.id
     FROM conversation_segments s
     JOIN conversations c ON c.id = s.conversation_id
     WHERE s.provider = ? AND s.provider_session_id = ?
       AND c.sidebar_role = 'managed'
       AND (? = 0 OR c.id LIKE 'import\_%' ESCAPE '\')
     ORDER BY s.ordinal DESC
     LIMIT 1`
  ).get(provider, providerSessionId, promotedOnly ? 1 : 0) as { id: string } | undefined
  return row?.id ?? null
}

export function resolveResumeSegment(
  conversationId: string,
  provider: ConversationSegmentProvider,
  providerInstanceId?: string | null,
): ConversationSegmentRow | null {
  return selectResumeSegment(listConversationSegments(conversationId), provider, providerInstanceId)
}

export function selectResumeSegment(
  segments: readonly ConversationSegmentRow[],
  provider: ConversationSegmentProvider,
  providerInstanceId?: string | null,
): ConversationSegmentRow | null {
  let providerFallback: ConversationSegmentRow | null = null
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]
    if (segment.provider !== provider) continue
    providerFallback ??= segment
    if (!providerInstanceId || segment.provider_instance_id === providerInstanceId) return segment
  }
  return providerFallback
}

/**
 * Per-conversation runtime mode (plan/sandbox/accept-edits/full-access).
 * Returns null if never set. Callers should fall back to a user default.
 *
 * Resolves `id` through `resolveRootThreadId` first: the sidebar hands back
 * whatever id the disk scanner currently considers canonical for this chat,
 * which is the Claude UUID once one has been assigned - but the mode was
 * saved against the synthetic `agent_<ts>` id this chat was created under.
 * Without this, every conversation "forgot" its runtime mode (and provider
 * instance, below) the first time it was reopened after Claude assigned it
 * a session id, since the raw id used to save it isn't the one being read
 * back. `resolveRootThreadId` no-ops when `id` was never rotated.
 */
export function getConversationRuntimeMode(id: string): string | null {
  const row = getDb().prepare(
    'SELECT runtime_mode FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { runtime_mode: string | null } | undefined
  return row?.runtime_mode ?? null
}

/**
 * Persist the per-conversation runtime mode. Called when the user picks a
 * mode in the chat header so reopening the conversation (incl. via a kanban
 * card click) restores their selection instead of resetting to 'sandbox'.
 *
 * Resolves through `resolveRootThreadId` for the same reason as the getter
 * above, so a pick made while viewing a rotated-id session lands on the same
 * row the getter will read from, instead of a stray row keyed by the UUID.
 */
export function setConversationRuntimeMode(id: string, mode: string): void {
  getDb().prepare(
    'UPDATE conversations SET runtime_mode = ?, updated_at = ? WHERE id = ?'
  ).run(mode, Date.now(), resolveRootThreadId(id))
}

export interface ConversationFollowSuggestions {
  mode: FollowSuggestionMode
  /** The user closed the "off" notice; it stays closed until a mode is chosen again. */
  noticeDismissed: boolean
  /** Distinct worktree paths the conversation has worked in. */
  workedWorktrees: readonly string[]
}

function parseWorkedWorktrees(value: string | null | undefined): readonly string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch (err) {
    log.warn('worked_worktrees is not valid JSON, starting over', err)
    return []
  }
}

/**
 * The Follow chip's per-conversation state. Resolves through
 * `resolveRootThreadId` like every per-conversation setting (see AGENTS.md).
 */
export function getConversationFollowSuggestions(id: string): ConversationFollowSuggestions {
  const row = getDb().prepare(
    'SELECT follow_suggestions, follow_notice_dismissed, worked_worktrees FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as {
    follow_suggestions: string | null
    follow_notice_dismissed: number | null
    worked_worktrees: string | null
  } | undefined
  return {
    mode: parseFollowSuggestionMode(row?.follow_suggestions),
    noticeDismissed: row?.follow_notice_dismissed === 1,
    workedWorktrees: parseWorkedWorktrees(row?.worked_worktrees),
  }
}

/**
 * Choosing a mode clears a dismissed notice, so turning suggestions off again
 * later says so once. Leaves `updated_at` alone: a display preference must not
 * reorder the sidebar.
 */
export function setConversationFollowSuggestions(id: string, mode: FollowSuggestionMode): boolean {
  return getDb().prepare(
    'UPDATE conversations SET follow_suggestions = ?, follow_notice_dismissed = NULL WHERE id = ?'
  ).run(mode === 'auto' ? null : mode, resolveRootThreadId(id)).changes > 0
}

/** The x on the "Follow suggestions are off" notice. */
export function setConversationFollowNoticeDismissed(id: string): boolean {
  return getDb().prepare(
    'UPDATE conversations SET follow_notice_dismissed = 1 WHERE id = ?'
  ).run(resolveRootThreadId(id)).changes > 0
}

/** Add the worktrees a drift check saw the agent in; returns the new state. */
export function recordConversationWorkedWorktrees(id: string, paths: readonly string[]): ConversationFollowSuggestions {
  const current = getConversationFollowSuggestions(id)
  const worked = paths.reduce(recordWorkedWorktree, current.workedWorktrees)
  if (worked !== current.workedWorktrees) {
    getDb().prepare(
      'UPDATE conversations SET worked_worktrees = ? WHERE id = ?'
    ).run(JSON.stringify(worked), resolveRootThreadId(id))
  }
  return { ...current, workedWorktrees: worked }
}

/**
 * Store the list preview of the thread's last finished turn. Leaves
 * `updated_at` alone, and writes every id of the thread like
 * `setConversationLastRead`, so a rotated id lands on the row lists read.
 */
export function setConversationStatusLine(id: string, line: string): void {
  const stmt = getDb().prepare('UPDATE conversations SET status_line = ? WHERE id = ?')
  for (const memberId of threadFamilyIds(id)) stmt.run(line, memberId)
}

/**
 * The history backfill's write: only rows still without a line, in the same
 * statement, so a turn that ended while history loaded keeps its newer line.
 * Returns whether any row took it.
 */
export function setConversationStatusLineIfMissing(id: string, line: string): boolean {
  const stmt = getDb().prepare('UPDATE conversations SET status_line = ? WHERE id = ? AND status_line IS NULL')
  let changed = 0
  for (const memberId of threadFamilyIds(id)) changed += stmt.run(line, memberId).changes
  return changed > 0
}

/**
 * Stamp when a thread was read. Deliberately does NOT touch `updated_at` -
 * that drives sidebar ordering, and reading a chat must not reorder the list.
 *
 * Returns false when no row matched, which happens for a session that was
 * scanned off disk but never persisted. The caller still broadcasts, so the
 * badge clears everywhere either way.
 */
export function setConversationLastRead(id: string, at: number): boolean {
  // Every id of the thread: stamping one row left the badge lit under the other.
  const stmt = getDb().prepare('UPDATE conversations SET last_read_at = ? WHERE id = ?')
  let changed = 0
  for (const memberId of threadFamilyIds(id)) changed += stmt.run(at, memberId).changes
  return changed > 0
}

export function getConversationLastRead(id: string): number | null {
  const row = getDb().prepare(
    'SELECT last_read_at FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { last_read_at: number | null } | undefined
  return row?.last_read_at ?? null
}

/**
 * Per-conversation provider instance id. Returns null if the column was
 * not yet populated (extremely old conversation, or one created before
 * the multi-instance migration ran). Callers fall back to the
 * `<agentType>-default` instance.
 *
 * Resolves through `resolveRootThreadId` first - see the comment on
 * `getConversationRuntimeMode` above. This is the fix for the sidebar
 * "provider instance keeps resetting to default" bug: the row that holds
 * the user's pick is keyed by the synthetic `agent_<ts>` id, but a chat
 * reopened from the sidebar arrives here keyed by its rotated Claude UUID.
 */
export function getConversationProviderInstanceId(id: string): string | null {
  const row = getDb().prepare(
    'SELECT provider_instance_id FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { provider_instance_id: string | null } | undefined
  return row?.provider_instance_id ?? null
}

export function setConversationProviderInstanceId(id: string, instanceId: string): void {
  // Keep `session_id`. The claude-adapter migrates the JSONL across
  // CLAUDE_CONFIG_DIR profiles when oauth_dir differs, so resume by UUID
  // still works after a switch. Nulling here would drop history.
  //
  // Resolved through `resolveRootThreadId` so a pick made against a rotated
  // id lands on the same row the getter above reads from, instead of a
  // stray row keyed by the UUID that the getter would never see.
  getDb().prepare(
    'UPDATE conversations SET provider_instance_id = ?, updated_at = ? WHERE id = ?'
  ).run(instanceId, Date.now(), resolveRootThreadId(id))
}

export function commitConversationProviderSwitch(input: {
  conversationId: string
  provider: ConversationSegmentProvider
  providerInstanceId: string
  providerSessionId: string | null
  pendingHandoffFrom?: string
}): void {
  commitConversationProfileSwitch(getDb(), {
    ...input,
    conversationId: resolveRootThreadId(input.conversationId),
  })
}

/**
 * Per-conversation pinned model. Returns null if the user never pinned one
 * (callers fall back to the adapter's own default).
 *
 * Resolves through `resolveRootThreadId` first - see the comment on
 * `getConversationRuntimeMode` above. Same fallback as runtime mode and
 * provider instance, so a chat reopened from the sidebar under its rotated
 * Claude UUID still finds the pin saved under its original id.
 */
export function getConversationModel(id: string): string | null {
  const row = getDb().prepare(
    'SELECT model FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { model: string | null } | undefined
  return row?.model ?? null
}

/**
 * Which agent this conversation's stored `model` belongs to. Switching agent
 * clears the model in the store but not in this table, so a stored model only
 * means anything next to its agent - `sessionDefaultsFor` drops it otherwise.
 * Same `resolveRootThreadId` fallback as the other per-conversation getters.
 */
export function getConversationAgentType(id: string): string | null {
  const row = getDb().prepare(
    'SELECT agent_type FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { agent_type: string | null } | undefined
  return row?.agent_type ?? null
}

export function setConversationModel(id: string, model: string): void {
  getDb().prepare(
    'UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?'
  ).run(model, Date.now(), resolveRootThreadId(id))
}

export function setConversationReasoningEffort(id: string, effort: string): void {
  getDb().prepare(
    'UPDATE conversations SET reasoning_effort = ?, updated_at = ? WHERE id = ?'
  ).run(effort, Date.now(), resolveRootThreadId(id))
}

/**
 * Persist a provider switch as one SQLite write. Provider, credential
 * profile, model pin, and native resume id must never describe different
 * providers after a reload. The model and effort in use are remembered under
 * the old agent type, and the new one gets back what this chat last used on
 * it (null model = provider default). Returns what was restored.
 */
export function setConversationProviderSelection(
  id: string,
  agentType: string,
  instanceId: string,
): { model: string | null; reasoningEffort: ReasoningEffort | null } {
  const db = getDb()
  const rootId = resolveRootThreadId(id)
  // ponytail: read then write with no transaction - better-sqlite3 is
  // synchronous on one connection, so nothing can run between the two.
  const row = db.prepare(
    'SELECT agent_type, model, reasoning_effort, provider_options_json FROM conversations WHERE id = ?'
  ).get(rootId) as {
    agent_type: string | null
    model: string | null
    reasoning_effort: string | null
    provider_options_json: string | null
  } | undefined
  let stored: unknown = null
  if (row?.provider_options_json) {
    try {
      stored = JSON.parse(row.provider_options_json)
    } catch (err) {
      log.warn(`provider options for ${rootId} are not valid JSON, starting over`, err)
    }
  }
  const next = switchProviderOptions(
    normalizeProviderOptionMemory(stored),
    { agentType: row?.agent_type ?? null, model: row?.model ?? null, reasoningEffort: isReasoningEffort(row?.reasoning_effort) ? row.reasoning_effort : null },
    agentType,
  )
  db.prepare(
    `UPDATE conversations SET agent_type = ?, model = ?, reasoning_effort = ?, provider_options_json = ?, provider_instance_id = ?,
     session_id = NULL, updated_at = ? WHERE id = ?`
  ).run(agentType, next.model, next.reasoningEffort, JSON.stringify(next.memory), instanceId, Date.now(), rootId)
  return { model: next.model, reasoningEffort: next.reasoningEffort }
}

/**
 * An agent switch as one transaction: the provider selection, the switch
 * marker row and the pending context handoff, so a reload or a failed call
 * can never leave the new agent selected without the handoff. Returns what
 * was restored, the marker (absent when nothing changed or the chat has no
 * history yet) and the pending handoff source.
 */
export function switchConversationAgent(
  id: string,
  agentType: string,
  instanceId: string,
  opts: { hasHistory: boolean; markerId: string },
): {
  model: string | null
  reasoningEffort: ReasoningEffort | null
  pendingHandoffFrom: string | null
  marker?: { id: string; content: string; timestamp: number }
} {
  const db = getDb()
  const rootId = resolveRootThreadId(id)
  return db.transaction(() => {
    const row = db.prepare(
      'SELECT agent_type, pending_handoff_from FROM conversations WHERE id = ?'
    ).get(rootId) as { agent_type: string | null; pending_handoff_from: string | null } | undefined
    const previous = row?.agent_type ?? null
    // The client's count can be empty when a reload returned nothing or
    // failed, so stored messages on any id of the thread count as history too.
    const familyIds = threadFamilyIds(rootId)
    const hasStoredHistory = db.prepare(
      `SELECT 1 FROM messages WHERE conversation_id IN (${familyIds.map(() => '?').join(', ')})
       AND role IN ('user', 'assistant') LIMIT 1`
    ).get(...familyIds) !== undefined
    const hasHistory = opts.hasHistory || hasStoredHistory
    const restored = setConversationProviderSelection(rootId, agentType, instanceId)
    let marker: { id: string; content: string; timestamp: number } | undefined
    if (hasHistory && previous && previous !== agentType) {
      marker = {
        id: opts.markerId,
        content: `${AGENT_SWITCH_MARKER_PREFIX} ${agentLabel(previous as AgentType)} → ${agentLabel(agentType as AgentType)}`,
        timestamp: Date.now(),
      }
      db.prepare(`
        INSERT OR IGNORE INTO messages (id, conversation_id, role, content, timestamp)
        VALUES (?, ?, 'system', ?, ?)
      `).run(marker.id, rootId, marker.content, marker.timestamp)
    }
    const pendingHandoffFrom = nextPendingHandoffFrom(row?.pending_handoff_from ?? null, previous, agentType, hasHistory)
    db.prepare('UPDATE conversations SET pending_handoff_from = ?, updated_at = ? WHERE id = ?').run(pendingHandoffFrom, Date.now(), rootId)
    return { ...restored, pendingHandoffFrom, ...(marker ? { marker } : {}) }
  })()
}

/**
 * Provider a pending cross-provider context handoff should attribute its
 * preamble to, or null when no handoff is scheduled. Set by an agent switch
 * over existing history and by degraded (non-resumable) forks; cleared when
 * the next turn is sent with the transcript preamble prefixed.
 *
 * Resolves through `resolveRootThreadId` first - see the comment on
 * `getConversationRuntimeMode` above. Without it a handoff scheduled against
 * a rotated id would never be consumed (or would re-inject after reload).
 */
export function getConversationPendingHandoff(id: string): string | null {
  const row = getDb().prepare(
    'SELECT pending_handoff_from FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { pending_handoff_from: string | null } | undefined
  return row?.pending_handoff_from ?? null
}

export function setConversationPendingHandoff(id: string, from: string | null): void {
  getDb().prepare(
    'UPDATE conversations SET pending_handoff_from = ?, updated_at = ? WHERE id = ?'
  ).run(from, Date.now(), resolveRootThreadId(id))
}

/** Clear the pending handoff only if it is still `expected` (a newer switch wins). */
export function clearConversationPendingHandoff(id: string, expected: string): void {
  getDb().prepare(
    'UPDATE conversations SET pending_handoff_from = NULL, updated_at = ? WHERE id = ? AND pending_handoff_from = ?'
  ).run(Date.now(), resolveRootThreadId(id), expected)
}

export function archiveConversation(id: string): void {
  setConversationArchived(id, 1)
}

export function unarchiveConversation(id: string): void {
  setConversationArchived(id, 0)
}

/**
 * Applies to every id of the thread. Archiving one row left the chat listed
 * under its other id, which reads as "archive did nothing".
 */
function setConversationArchived(id: string, archived: 0 | 1): void {
  const stmt = getDb().prepare('UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ?')
  const now = Date.now()
  for (const memberId of threadFamilyIds(id)) stmt.run(archived, now, memberId)
}

export function getArchivedConversations(): Array<{ id: string; project_path: string; title: string; updated_at: number }> {
  return getDb().prepare(
    `SELECT c.id, c.project_path, c.title, c.updated_at
     FROM conversations c
     WHERE c.archived = 1 AND c.sidebar_role = 'managed'
       AND NOT EXISTS (
         SELECT 1
         FROM thread_sessions ts
         JOIN conversations root ON root.id = ts.thread_id
         WHERE ts.claude_session_id = c.id
           AND ts.thread_id != c.id
           AND root.sidebar_role = 'managed'
       )
     ORDER BY c.updated_at DESC`
  ).all() as Array<{ id: string; project_path: string; title: string; updated_at: number }>
}

export function isConversationArchived(id: string): boolean {
  const row = getDb().prepare(
    'SELECT archived FROM conversations WHERE id = ?'
  ).get(resolveRootThreadId(id)) as { archived: number } | undefined
  return row?.archived === 1
}

/**
 * Returns the set of ALL archived conversation IDs, regardless of project_path.
 * Used when filtering scanned sessions so that a conversation archived under
 * one project_path doesn't reappear under a different project_path view
 * (can happen when sessions bleed across projects that share path prefixes).
 */
export function getArchivedConversationIds(): Set<string> {
  const rows = getDb().prepare(
    'SELECT id FROM conversations WHERE archived = 1'
  ).all() as Array<{ id: string }>
  return new Set(rows.map((r) => r.id))
}

/**
 * Bulk-save messages from an imported session (e.g., JSONL load).
 * Uses a transaction for performance. Triggers auto-populate FTS.
 */
export function bulkSaveMessages(
  conversationId: string,
  messages: Array<{ id: string; role: string; content: string; timestamp: number }>,
): void {
  const db = getDb()

  // Skip silently if the conversation row doesn't exist - same guard as saveMessage
  const convExists = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(conversationId)
  if (!convExists) {
    log.warn(`bulkSaveMessages: conversation ${conversationId} not found, skipping`)
    return
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO messages (id, conversation_id, role, content, timestamp)
     VALUES (?, ?, ?, ?, ?)`
  )

  const tx = db.transaction(() => {
    for (const msg of messages) {
      if (!msg.content) continue
      insert.run(msg.id, conversationId, msg.role, msg.content, msg.timestamp)
    }
  })
  tx()
}
