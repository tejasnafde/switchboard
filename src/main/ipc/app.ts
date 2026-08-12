import type { BackendHost } from '../backend/host'
import { stat } from 'fs/promises'
import { notifyWorktreeSwap, publishRuntimeEvent } from '../provider/provider-registry'
import { AppChannels, BookmarkChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { scanAllSessions, encodeClaudeProjectPath } from '../projects/session-scanner'
import { synthesizeDbOnlySessions, stampAgentTypes, sessionSummaryToConversationRow } from './terminal-sessions'
import { homedir, networkInterfaces } from 'os'
import { basename, join as joinPath } from 'path'
import {
  addProject,
  removeProject,
  renameProject,
  getProjects,
  getSetting,
  setSetting,
  removeSetting,
  createConversation,
  setConversationWorktree,
  saveBookmark,
  removeBookmark,
  listBookmarks,
  updateConversationTitle,
  saveMessage,
  getConversationsForProject,
  getConversationsForProjects,
  saveSessionLayout,
  getSessionLayout,
  searchMessages,
  bulkSaveMessages,
  archiveConversation,
  unarchiveConversation,
  getArchivedConversations,
  getArchivedConversationIds,
  ensureConversation,
  isConversationArchived,
  getConversationById,
  getConversationRuntimeMode,
  setConversationRuntimeMode,
  getConversationProviderInstanceId,
  setConversationProviderInstanceId,
  getConversationModel,
  setConversationModel,
  setConversationProviderSelection,
  getConversationPendingHandoff,
  setConversationPendingHandoff,
  getChildSessionIds,
  getSyntheticParentMap,
  listSessionIdsForThread,
  resolveRootThreadId,
  recordThreadSession,
  detachSession,
  listAllThreadSessions,
  listWorkspaces,
  createWorkspace,
  renameWorkspace,
  recolorWorkspace,
  deleteWorkspace,
  reorderWorkspaces,
  setProjectWorkspace,
  organizeProjects,
  getDisplayBodyEnrichments,
  getSystemMarkerMessages,
  getMessagesForConversation,
  messageRowsToChatMessages,
  setConversationLastRead,
} from '../db/database'
import { claudeCandidateDirs, listClaudeSessionCopies } from '../provider/claude-session-migrate'
import { enrichMessagesWithDisplayBody } from './enrichDisplayBody'
import { loadJsonlCached } from '../agent/jsonl-cache'
import { dedupeMessagesById } from '../agent/dedupe-messages'
import { forkConversation } from '../conversations/fork'
import { readLaunchConfig, writeLaunchConfig, watchLaunchConfig, setLaunchConfigEmitter } from '../launch-config/launch-config-store'
import type { Project, CreateConversationParams, SaveMessageParams, ChatMessage, SessionSummary } from '@shared/types'

const log = createLogger('ipc:app')

// Data handlers - transport-agnostic, run on either ElectronIpcHost or WsHost.
// Native-dialog / window / app-lifecycle handlers live in app-desktop.ts.
/**
 * Tail-slice an assembled history for clients that cannot afford the whole
 * thing. Fragments still have to be parsed in full to dedupe and order them, so
 * this saves WIRE bytes, not parse time - which is the cost that matters for the
 * mobile client pulling a 2800-message thread over a WebSocket.
 *
 * `total` and `truncated` travel with the result so the caller can SAY it is
 * showing a window instead of silently pretending the thread is short. Omitting
 * `limit` returns everything, so existing desktop callers are unaffected.
 */
function capTail<T extends { messages: ChatMessage[] }>(
  result: T,
  opts?: { limit?: number },
): T & { total: number; truncated: boolean } {
  const total = result.messages.length
  const limit = opts?.limit
  if (!limit || limit <= 0 || total <= limit) return { ...result, total, truncated: false }
  return { ...result, messages: result.messages.slice(total - limit), total, truncated: true }
}

/**
 * The visible session list for a project: disk scan merged with DB rows, minus
 * archived chats and rotated child sessions, newest first.
 *
 * One definition of "visible", because there used to be two. The phone listed
 * `getConversationsForProject` raw, so it showed 169 chats where this returned
 * 32 - and where a chat exists as both an `agent_<ms>` row and a Claude UUID
 * row, this picks the UUID, so the phone opened the twin and every runtime
 * event, keyed on threadId, was dropped by the desktop.
 */
export async function visibleSessionsForProject(projectPath: string): Promise<SessionSummary[]> {
  const sessions = await scanAllSessions(projectPath, claudeCandidateDirs())
  const archivedSet = getArchivedConversationIds()
  const childSet = getChildSessionIds()
  const syntheticParents = getSyntheticParentMap()
  const dbConversations = getConversationsForProject(projectPath)
  const titleMap = new Map(dbConversations.map((c) => [c.id, c.title]))
  const agentTypeMap = new Map(dbConversations.map((c) => [c.id, c.agent_type]))
  // Worktree pointers per conversation id - stamped onto the
  // SessionSummary so the renderer can route the agent's cwd via
  // `worktreePath ?? projectPath`.
  const worktreeMap = new Map(
    dbConversations
      .filter((c) => c.worktree_path)
      .map((c) => [c.id, { path: c.worktree_path ?? null, branch: c.worktree_branch ?? null }]),
  )
  const scannedIds = new Set(sessions.map((s) => s.id))
  const filtered = sessions
    // Hide archived chats (global set - across project paths) and child
    // session_ids produced by Claude SDK rotation (tracked in thread_sessions).
    .filter((s) => !archivedSet.has(s.id) && !childSet.has(s.id))
    .map((s) => {
      // Direct title match (UUID is the canonical conversation id)
      const direct = titleMap.get(s.id)
      const wt = worktreeMap.get(s.id) ?? worktreeMap.get(syntheticParents.get(s.id) ?? '')
      const withWorktree = wt ? { ...s, worktreePath: wt.path, worktreeBranch: wt.branch } : s
      const withAgentType = stampAgentTypes([withWorktree], agentTypeMap)[0]
      if (direct) return { ...withAgentType, title: direct }
      // Title inheritance: UUID has a synthetic `agent_<ts>` parent in
      // thread_sessions. Look up the parent's title from conversations.
      const parentId = syntheticParents.get(s.id)
      if (parentId) {
        const parentTitle = titleMap.get(parentId)
        if (parentTitle) return { ...withAgentType, title: parentTitle }
      }
      return withAgentType
    })

  const dbOnlySessions = synthesizeDbOnlySessions(dbConversations, archivedSet, scannedIds, childSet)
  // Sorted for the same reason GET_PROJECTS is: concatenating puts every
  // db-only row last regardless of recency, and a worktree-run chat is
  // ALWAYS a db-only row, so they all sank to the bottom of this list.
  return [...filtered, ...dbOnlySessions].sort((a, b) => b.startedAt - a.startedAt)
}

export function registerAppHandlers(host: BackendHost): void {
  setLaunchConfigEmitter((channel, ...args) => host.emit(channel, ...args))

  host.handle(AppChannels.SCAN_SESSIONS, async (projectPath: string) => {
    log.info(`scan-sessions: ${projectPath}`)
    const result = await visibleSessionsForProject(projectPath)
    log.info(`scan complete: ${result.length} visible`)
    return result
  })

  // External IPv4 addresses - host candidates for the mobile pairing QR.
  // Skips loopback/internal interfaces and 169.254.* link-local self-assigns.
  host.handle(AppChannels.LAN_ADDRESSES, (): Array<{ iface: string; address: string }> => {
    const results: Array<{ iface: string; address: string }> = []
    for (const [iface, addrs] of Object.entries(networkInterfaces())) {
      for (const addr of addrs ?? []) {
        if (addr.family !== 'IPv4' || addr.internal) continue
        if (addr.address.startsWith('169.254.')) continue
        results.push({ iface, address: addr.address })
      }
    }
    return results
  })

  // Settings
  host.handle(AppChannels.SETTINGS_GET, (key: string) => getSetting(key))
  host.handle(AppChannels.SETTINGS_SET, (key: string, value: string) => setSetting(key, value))
  host.handle('settings:remove', (key: string) => removeSetting(key))

  // Load persisted projects on renderer request
  host.handle(AppChannels.GET_PROJECTS, async () => {
    const rows = getProjects()
    // Global exclusion sets - archived + session_ids that are children of
    // another thread (fragmented by Claude SDK session-id rotation).
    const archivedSet = getArchivedConversationIds()
    const childSet = getChildSessionIds()
    const syntheticParents = getSyntheticParentMap()
    const candidateDirs = claudeCandidateDirs()
    // One IN query for all projects' conversations instead of one query per
    // project inside the loop.
    const convsByProject = getConversationsForProjects(rows.map((r) => r.path))
    // Scan projects concurrently - each scanAllSessions is independent I/O and
    // was previously awaited one project at a time, serializing every sidebar/
    // settings/kanban refresh over the full session filesystem.
    const projects: Project[] = await Promise.all(rows.map(async (row) => {
      const sessions = await scanAllSessions(row.path, candidateDirs)
      const dbConversations = convsByProject.get(row.path) ?? []
      const titleMap = new Map(dbConversations.map((c) => [c.id, c.title]))
      const agentTypeMap = new Map(dbConversations.map((c) => [c.id, c.agent_type]))
      const worktreeMap = new Map(
        dbConversations
          .filter((c) => c.worktree_path)
          .map((c) => [c.id, { path: c.worktree_path ?? null, branch: c.worktree_branch ?? null }]),
      )
      const scannedIds = new Set(sessions.map((s) => s.id))
      const filtered = sessions
        .filter((s) => !archivedSet.has(s.id) && !childSet.has(s.id))
        .map((s) => {
          const wt = worktreeMap.get(s.id) ?? worktreeMap.get(syntheticParents.get(s.id) ?? '')
          const withWorktree = wt ? { ...s, worktreePath: wt.path, worktreeBranch: wt.branch } : s
          const withAgentType = stampAgentTypes([withWorktree], agentTypeMap)[0]
          const direct = titleMap.get(s.id)
          if (direct) return { ...withAgentType, title: direct }
          const parentId = syntheticParents.get(s.id)
          if (parentId) {
            const parentTitle = titleMap.get(parentId)
            if (parentTitle) return { ...withAgentType, title: parentTitle }
          }
          return withAgentType
        })
      const dbOnlySessions = synthesizeDbOnlySessions(dbConversations, archivedSet, scannedIds, childSet)
      // Sorted, not concatenated: dbOnlySessions used to land after every
      // scanned session, so a brand-new chat appeared at the bottom.
      const merged = [...filtered, ...dbOnlySessions].sort((a, b) => b.startedAt - a.startedAt)
      return { path: row.path, name: row.name, sessions: merged, workspaceId: row.workspace_id ?? null }
    }))
    return projects
  })

  // Add a project from an absolute directory path - the transport-agnostic
  // twin of app-desktop.ts's OPEN_FOLDER dialog handler, used by the remote
  // add-project flow where there's no native dialog to show.
  host.handle(AppChannels.ADD_PROJECT_PATH, async (dirPath: string): Promise<Project | { ok: false; error: string }> => {
    log.info(`add-project-path: ${dirPath}`)
    let stats
    try {
      stats = await stat(dirPath)
    } catch (err) {
      log.warn('add-project-path stat failed', { dirPath, err: err instanceof Error ? err.message : String(err) })
      return { ok: false, error: err instanceof Error ? err.message : 'Path not found' }
    }
    if (!stats.isDirectory()) {
      return { ok: false, error: 'Not a directory' }
    }

    const name = basename(dirPath)
    addProject(dirPath, name)

    const rawSessions = await scanAllSessions(dirPath, claudeCandidateDirs())
    const archivedSet = getArchivedConversationIds()
    const sessions = rawSessions.filter((s) => !archivedSet.has(s.id))
    log.info(`add-project-path: found ${sessions.length} sessions for ${dirPath} (${rawSessions.length - sessions.length} archived)`)

    return { path: dirPath, name, sessions, workspaceId: null }
  })

  host.handle(AppChannels.REMOVE_PROJECT, (projectPath: string) => {
    log.info(`remove-project: ${projectPath}`)
    removeProject(projectPath) // FK cascade drops conversations + kanban cards
    return { ok: true }
  })

  host.handle(AppChannels.RENAME_PROJECT, (projectPath: string, name: string) => {
    renameProject(projectPath, name)
    return { ok: true }
  })

  // ─── Workspaces (sidebar grouping) ─────────────────────────────
  host.handle(AppChannels.WORKSPACE_LIST, () => {
    return listWorkspaces().map((w) => ({
      id: w.id, name: w.name, color: w.color, sortOrder: w.sort_order, createdAt: w.created_at,
    }))
  })
  host.handle(AppChannels.WORKSPACE_CREATE, (input: { name: string; color?: string | null }) => {
    const w = createWorkspace(input)
    return { id: w.id, name: w.name, color: w.color, sortOrder: w.sort_order, createdAt: w.created_at }
  })
  host.handle(AppChannels.WORKSPACE_RENAME, (id: string, name: string) => {
    renameWorkspace(id, name); return { ok: true }
  })
  host.handle(AppChannels.WORKSPACE_RECOLOR, (id: string, color: string | null) => {
    recolorWorkspace(id, color); return { ok: true }
  })
  host.handle(AppChannels.WORKSPACE_DELETE, (id: string) => {
    deleteWorkspace(id); return { ok: true }
  })
  host.handle(AppChannels.WORKSPACE_REORDER, (ids: string[]) => {
    reorderWorkspaces(ids); return { ok: true }
  })
  host.handle(AppChannels.ASSIGN_PROJECT_WORKSPACE, (projectPath: string, workspaceId: string | null) => {
    setProjectWorkspace(projectPath, workspaceId); return { ok: true }
  })
  host.handle(AppChannels.PROJECT_ORGANIZE, (items: import('@shared/types').ProjectOrganizationItem[]) => {
    organizeProjects(items); return { ok: true }
  })

  host.handle(
    AppChannels.SET_CONVERSATION_WORKTREE,
    (conversationId: string,
      worktreePath: string | null,
      worktreeBranch: string | null,
    ) => {
      setConversationWorktree(conversationId, worktreePath, worktreeBranch)
      // Live sessions share the conversation id as threadId: re-baseline the
      // drift detector so reverse drift stays detectable after a Follow. A
      // null pointer (orphaned-worktree heal) re-baselines to the project
      // root the session falls back to.
      notifyWorktreeSwap(conversationId, worktreePath ?? getConversationById(conversationId)?.project_path ?? null)
      return { ok: true }
    },
  )

  host.handle(AppChannels.CREATE_CONVERSATION, (params: CreateConversationParams) => {
    const inserted = createConversation(
      params.id,
      params.projectPath,
      params.agentType,
      params.title,
      params.worktreePath ?? null,
      params.worktreeBranch ?? null,
    )
    log.info(
      `conversation created: ${params.id} project=${params.projectPath}` +
        (params.worktreePath ? ` worktree=${params.worktreePath} (${params.worktreeBranch})` : ''),
    )
    // INSERT OR IGNORE: opening an existing chat re-runs this and changes nothing.
    if (inserted) host.emit(AppChannels.CONVERSATIONS_CHANGED)
    return { id: params.id }
  })

  // Load a session from a JSONL file on disk.
  // `source` selects the parser variant: 'claude-code' (default) or 'codex'.
  // Without this param, Codex sessions loaded as empty because their event
  // schema doesn't match Claude's.
  host.handle(AppChannels.LOAD_SESSION, async (filePath: string,
    conversationId?: string,
    source?: 'claude-code' | 'codex',
  ) => {
    log.info(`loading session: ${filePath} source=${source ?? 'claude-code'}`)
    try {
      const messages = await loadJsonlCached(filePath, source ?? 'claude-code')
      if (!messages) {
        log.warn(`failed to load session (missing file): ${filePath}`)
        return []
      }
      log.info(`parsed ${messages.length} messages from ${filePath}`)

      // Index messages for search (best-effort)
      if (conversationId && messages.length > 0) {
        try {
          bulkSaveMessages(
            conversationId,
            messages.map((m) => ({
              id: m.id,
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
            })),
          )
          log.info(`indexed ${messages.length} messages for search`)
        } catch { /* indexing failed - search won't find these, but load still works */ }
      }

      return messages
    } catch (err) {
      log.warn(`failed to load session: ${filePath} ${err}`)
      return []
    }
  })

  // Load a session by conversation id - looks up project_path in the DB,
  // computes the JSONL file path, and returns the parsed messages.
  //
  // If this thread has child session_ids (Claude SDK rotated session_id
  // during compaction/restart), concatenate messages from ALL fragments
  // in chronological order. One click in the sidebar → one coherent
  // conversation, regardless of how many .jsonl files it actually spans.
  host.handle(AppChannels.LOAD_SESSION_BY_ID, async (conversationId: string,
    opts?: { limit?: number },
  ): Promise<{
    messages: ChatMessage[]
    meta: { id: string; title: string; projectPath: string; agentType: string } | null
    total: number
    truncated: boolean
  }> => {
    const row = getConversationById(conversationId)
    if (!row) return capTail({ messages: [], meta: null }, opts)
    const source: 'claude-code' | 'codex' = row.agent_type === 'codex' ? 'codex' : 'claude-code'
    // rootThreadId lets the renderer avoid building a twin session: the sidebar
    // lists a chat under its SDK session UUID, but a live adapter keys events to
    // the synthetic agent_<ts> thread. See resolveSessionSelectTarget.
    const meta = {
      id: row.id,
      title: row.title,
      projectPath: row.project_path,
      agentType: row.agent_type,
      rootThreadId: resolveRootThreadId(row.id),
    }

    // All session_ids that belong to this thread (root + children).
    const sessionIds = listSessionIdsForThread(conversationId)

    if (source === 'claude-code') {
      // Every profile dir, and within each, every project dir - NOT just
      // `encode(project_path)`. The CLI files a transcript under the encoded
      // cwd, so a chat that ran in a worktree writes somewhere this handler
      // used to never look: it kept returning the last snapshot left under the
      // project dir, and re-entering the chat replaced live history with it.
      const candidateDirs = claudeCandidateDirs()
      const all: ChatMessage[] = []
      for (const sid of sessionIds) {
        for (const dir of candidateDirs) {
          for (const copy of listClaudeSessionCopies(dir, sid)) {
            const msgs = await loadJsonlCached(copy.path, 'claude-code')
            if (msgs) all.push(...msgs)
          }
        }
      }
      // Merge in timestamp order so fragments interleave correctly.
      all.sort((a, b) => a.timestamp - b.timestamp)
      // Fold the same message arriving from several profile dirs back to one.
      const { messages: deduped, removed, conflicts } = dedupeMessagesById(all)
      if (conflicts > 0) {
        // Profile copies are byte-prefixes of one another, so this should be
        // unreachable. If it fires, "first wins" dropped a differing version.
        log.warn(`load-by-id: ${conversationId} had ${conflicts} id(s) with conflicting content`)
      }
      // JSONL gone (Claude Code prunes/rotates ~/.claude/projects), but the
      // messages are mirrored in SQLite - recover from the DB so the
      // conversation still renders instead of showing an empty chat.
      if (deduped.length === 0) {
        const dbMsgs = messageRowsToChatMessages(getMessagesForConversation(conversationId))
        if (dbMsgs.length > 0) {
          log.info(`load-by-id: ${conversationId} → no JSONL, recovered ${dbMsgs.length} messages from DB`)
          return capTail({ messages: dbMsgs, meta }, opts)
        }
      }
      const enriched = enrichMessagesWithDisplayBody(deduped, getDisplayBodyEnrichments(conversationId))
      // Merge in any persisted system markers (currently provider-instance
      // rotation markers) - these live in SQLite, not JSONL, and need to
      // appear in chronological order alongside agent turns.
      const markers = getSystemMarkerMessages(conversationId).map((m) => ({
        id: m.id,
        role: 'system' as const,
        content: m.content,
        timestamp: m.timestamp,
      }))
      const merged = [...enriched, ...markers].sort((a, b) => a.timestamp - b.timestamp)
      log.info(`load-by-id: ${conversationId} → ${deduped.length} messages (${removed} dupes removed) across ${sessionIds.length} fragment(s), +${markers.length} marker(s)`)
      return capTail({ messages: merged, meta }, opts)
    }

    // Codex fallback - scan all sessions for this project, find matching id(s)
    try {
      const sessions = await scanAllSessions(row.project_path)
      const all: ChatMessage[] = []
      for (const sid of sessionIds) {
        const match = sessions.find((s) => s.id === sid)
        if (!match?.filePath) continue
        const msgs = await loadJsonlCached(match.filePath, 'codex')
        if (msgs) all.push(...msgs)
      }
      all.sort((a, b) => a.timestamp - b.timestamp)
      const seenCodex = new Set<string>()
      const dedupedCodex = all.filter((m) => {
        if (seenCodex.has(m.id)) return false
        seenCodex.add(m.id)
        return true
      })
      if (dedupedCodex.length === 0) {
        const dbMsgs = messageRowsToChatMessages(getMessagesForConversation(conversationId))
        if (dbMsgs.length > 0) {
          log.info(`load-by-id (codex): ${conversationId} → no JSONL, recovered ${dbMsgs.length} messages from DB`)
          return capTail({ messages: dbMsgs, meta }, opts)
        }
      }
      const enrichedCodex = enrichMessagesWithDisplayBody(dedupedCodex, getDisplayBodyEnrichments(conversationId))
      const markersCodex = getSystemMarkerMessages(conversationId).map((m) => ({
        id: m.id,
        role: 'system' as const,
        content: m.content,
        timestamp: m.timestamp,
      }))
      const mergedCodex = [...enrichedCodex, ...markersCodex].sort((a, b) => a.timestamp - b.timestamp)
      return capTail({ messages: mergedCodex, meta }, opts)
    } catch (err) {
      log.warn(`load-by-id (codex) failed for ${conversationId}: ${err}`)
      return capTail({ messages: [], meta }, opts)
    }
  })

  // Save a message to the database
  host.handle(AppChannels.SAVE_MESSAGE, (params: SaveMessageParams) => {
    const result = saveMessage(
      params.id, params.conversationId, params.role, params.content,
      params.toolCalls, params.images,
      params.displayBody, params.pillsMeta,
    )
    // Trace in-band system markers (rotation pill etc.) - they're rare
    // and worth a one-liner so persistence issues are diagnosable in-log.
    if (params.role === 'system' && params.content.startsWith('[[sb:')) {
      log.info(`saveMessage marker → ${result.ok ? 'ok' : `skipped(${result.reason})`} conv=${params.conversationId} content=${JSON.stringify(params.content)}`)
    }
    return result
  })

  // A client opened a thread. Persist the read point, then broadcast so the
  // other clients drop their badge - the whole point is that they agree.
  host.handle(AppChannels.MARK_READ, (threadId: string, at?: number) => {
    const readAt = at ?? Date.now()
    if (!setConversationLastRead(threadId, readAt)) {
      // Scanned off disk but never persisted - no row to stamp. The broadcast
      // below still clears the badge, so this is worth a note, not a failure.
      log.debug(`mark-read: no conversation row for ${threadId}`)
    }
    publishRuntimeEvent({ type: 'thread.read', threadId, at: readAt })
    return { ok: true, at: readAt }
  })

  // Read/write the per-conversation runtime mode. The UI calls these so a
  // kanban card click - or any sidebar reopen - restores the user's last
  // selection instead of falling back to 'sandbox'.
  host.handle(AppChannels.GET_CONVERSATION_RUNTIME_MODE, (id: string) => {
    return { mode: getConversationRuntimeMode(id) }
  })
  host.handle(AppChannels.SET_CONVERSATION_RUNTIME_MODE, (id: string, mode: string) => {
    setConversationRuntimeMode(id, mode)
    return { ok: true }
  })

  // Per-conversation provider-instance id. Symmetric with runtime mode:
  // sidebar reopen / kanban click should restore the user's chosen
  // credential set instead of falling through to `<kind>-default`.
  host.handle(AppChannels.GET_CONVERSATION_PROVIDER_INSTANCE_ID, (id: string) => {
    return { instanceId: getConversationProviderInstanceId(id) }
  })
  host.handle(AppChannels.SET_CONVERSATION_PROVIDER_INSTANCE_ID, (id: string, instanceId: string) => {
    setConversationProviderInstanceId(id, instanceId)
    return { ok: true }
  })

  // Per-conversation pinned model. Same symmetry as runtime mode / provider
  // instance above: sidebar reopen / kanban click should restore the user's
  // last pin instead of falling back to the adapter's default.
  host.handle(AppChannels.GET_CONVERSATION_MODEL, (id: string) => {
    return { model: getConversationModel(id) }
  })
  host.handle(AppChannels.SET_CONVERSATION_MODEL, (id: string, model: string) => {
    setConversationModel(id, model)
    return { ok: true }
  })
  host.handle(AppChannels.SET_CONVERSATION_PROVIDER_SELECTION, (
    id: string,
    agentType: string,
    instanceId: string,
  ) => {
    setConversationProviderSelection(id, agentType, instanceId)
    return { ok: true }
  })

  // Pending cross-provider context handoff. Scheduled by an agent switch
  // (ChatPanel) or a degraded fork (conversations/fork.ts); the chat panel
  // consumes it on the next send by prefixing the transcript preamble, then
  // clears it so a reload cannot re-inject.
  host.handle(AppChannels.GET_CONVERSATION_PENDING_HANDOFF, (id: string) => {
    return { from: getConversationPendingHandoff(id) }
  })
  host.handle(AppChannels.SET_CONVERSATION_PENDING_HANDOFF, (id: string, from: string | null) => {
    setConversationPendingHandoff(id, from)
    return { ok: true }
  })

  // Rename a conversation
  host.handle(AppChannels.RENAME_CONVERSATION, (id: string, title: string) => {
    const changed = updateConversationTitle(id, title)
    log.info(`conversation renamed: ${id} → ${title}`)
    if (changed) host.emit(AppChannels.CONVERSATIONS_CHANGED)
    return { ok: true }
  })

  // Derived from the same list the desktop sidebar renders, so the phone cannot
  // list a chat the Mac archived, and both clients address a chat by one id.
  host.handle(AppChannels.GET_CONVERSATIONS, async (projectPath: string) => {
    watchLaunchConfig(projectPath) // Start watching as soon as project is loaded
    const sessions = await visibleSessionsForProject(projectPath)
    return sessions.map((s) => sessionSummaryToConversationRow(s, projectPath))
  })

  // Session layout persistence
  host.handle(AppChannels.SAVE_SESSION_LAYOUT, (sessionId: string, layoutJson: string, launchConfigName?: string | null) => {
    saveSessionLayout(sessionId, layoutJson, launchConfigName ?? null)
    return { ok: true }
  })

  host.handle(AppChannels.GET_SESSION_LAYOUT, (sessionId: string) => {
    return getSessionLayout(sessionId)
  })

  // Workspace config (per-project, stored in app support)
  host.handle(AppChannels.GET_LAUNCH_CONFIG, (projectPath: string) => {
    return readLaunchConfig(projectPath)
  })

  host.handle(AppChannels.SAVE_LAUNCH_CONFIG, (projectPath: string, yamlContent: string) => {
    writeLaunchConfig(projectPath, yamlContent)
    return { ok: true }
  })

  // Search across conversations (FTS5)
  host.handle(AppChannels.SEARCH_MESSAGES, (query: string) => {
    return searchMessages(query)
  })

  // Archive / unarchive conversations
  host.handle(AppChannels.ARCHIVE_CONVERSATION, (id: string, projectPath?: string, title?: string) => {
    // Ensure row exists (for scanned-but-not-yet-persisted sessions)
    if (projectPath) {
      ensureConversation(id, projectPath, 'claude-code', title ?? 'Session')
    }
    archiveConversation(id)
    return { ok: true, archived: isConversationArchived(id) }
  })

  host.handle(AppChannels.UNARCHIVE_CONVERSATION, (id: string) => {
    unarchiveConversation(id)
    return { ok: true }
  })

  host.handle(AppChannels.GET_ARCHIVED_CONVERSATIONS, () => {
    return getArchivedConversations()
  })

  // Remove a row from thread_sessions - un-hides a session from the
  // sidebar. Used when an automatic ancestry record was wrong, or when
  // the user wants to unmerge.
  host.handle(AppChannels.DETACH_SESSION, (claudeSessionId: string) => {
    const ok = detachSession(claudeSessionId)
    log.info(`detach: ${claudeSessionId} ${ok ? 'removed' : 'no-op (no row found)'}`)
    return { ok }
  })

  // Debug: dump all ancestry rows so a user can inspect via devtools.
  host.handle(AppChannels.LIST_ANCESTRY, () => listAllThreadSessions())

  // Manually attach a conversation row as a child of another thread -
  // lets users stitch pre-ancestry fragments together. After this runs,
  // `fragmentId` disappears from the sidebar and its messages load under
  // `rootThreadId`.
  host.handle(AppChannels.ATTACH_TO_THREAD, (fragmentId: string,
    rootThreadId: string,
  ) => {
    if (fragmentId === rootThreadId) return { ok: false, error: 'cannot attach to self' }
    try {
      recordThreadSession(fragmentId, rootThreadId)
      log.info(`attached ${fragmentId} → thread ${rootThreadId}`)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
    }
  })

  // Fork-from-message - clone a conversation up through the chosen
  // message and wire the new conversation so the agent can resume with
  // real context. See src/main/conversations/fork.ts.
  host.handle(AppChannels.FORK_CONVERSATION, async (args: {
      sourceConversationId: string
      upToIndex: number
      forkedAtMessageId?: string
      // #5: opt the fork into a fresh git worktree branched off HEAD.
      withWorktree?: boolean
    },
  ) => {
    try {
      const result = await forkConversation(args)
      log.info(`fork: ${args.sourceConversationId} → ${result.conversation.id} resumable=${result.resumable}`)
      return { ok: true, ...result }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      log.error(`fork failed: ${message}`)
      return { ok: false, error: message }
    }
  })

  // ─── Bookmarks ───────────────────────────────────────────────────
  host.handle(BookmarkChannels.SAVE, (params: Parameters<typeof saveBookmark>[0]) => saveBookmark(params))
  host.handle(BookmarkChannels.REMOVE, (id: string) => removeBookmark(id))
  host.handle(BookmarkChannels.LIST, () =>
    listBookmarks().map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      projectPath: r.project_path,
      sessionTitle: r.session_title,
      agentType: r.agent_type,
      messageRole: r.message_role as 'user' | 'assistant',
      contentExcerpt: r.content_excerpt,
      messageTimestamp: r.message_timestamp,
      savedAt: r.saved_at,
    })),
  )
}
