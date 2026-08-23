import type { BackendHost } from '../backend/host'
import { stat } from 'fs/promises'
import { notifyWorktreeSwap, publishRuntimeEvent } from '../provider/provider-registry'
import { AppChannels, BookmarkChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { scanAllSessions } from '../projects/session-scanner'
import { projectManagedRootSessions, sessionSummaryToConversationRow } from './terminal-sessions'
import { homedir, networkInterfaces } from 'os'
import { randomUUID } from 'crypto'
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
  getManagedRootConversationsForProject,
  getManagedRootConversationsForProjects,
  saveSessionLayout,
  getSessionLayout,
  searchMessages,
  bulkSaveMessages,
  archiveConversation,
  unarchiveConversation,
  getArchivedConversations,
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
  getMessagesForConversation,
  messageRowsToChatMessages,
  setConversationLastRead,
  promoteConversationToManaged,
  reviveConversationForRecovery,
  getRecoveryConversationTitles,
  recordConversationSegment,
  findManagedConversationForNativeSession,
  getDb,
} from '../db/database'
import { claudeCandidateDirs } from '../provider/claude-session-migrate'
import { codexCandidateDirs } from '../provider/codex-session-dirs'
import { loadConversationHistory } from '../conversations/history'
import { loadJsonlCached } from '../agent/jsonl-cache'
import { forkConversation } from '../conversations/fork'
import { readLaunchConfig, writeLaunchConfig, watchLaunchConfig, setLaunchConfigEmitter } from '../launch-config/launch-config-store'
import type { Project, CreateConversationParams, SaveMessageParams, ChatMessage, SessionSummary } from '@shared/types'
import { logicalImportConversationId, recoveryCandidateTitle } from '../db/conversationSidebarRole'
import { loadCursorConversation } from '../cursor/store'
import { importCursorSnapshot } from '../db/cursor-import'

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

/** One authoritative sidebar projection for desktop and remote clients.
 * Provider files are deliberately absent; SCAN_SESSIONS exposes those only in
 * the explicit Import/Recovery surface. */
export async function visibleSessionsForProject(projectPath: string): Promise<SessionSummary[]> {
  return projectManagedRootSessions(getManagedRootConversationsForProject(projectPath))
}

function enrichRecoveryCandidates(candidates: SessionSummary[]): SessionSummary[] {
  return candidates.map((candidate) => {
    const titles = getRecoveryConversationTitles(candidate.id)
    return {
      ...candidate,
      title: recoveryCandidateTitle(candidate.title, titles.nativeTitle, titles.rootTitle),
    }
  })
}

export function registerAppHandlers(host: BackendHost): void {
  setLaunchConfigEmitter((channel, ...args) => host.emit(channel, ...args))

  host.handle(AppChannels.SCAN_SESSIONS, async (projectPath: string) => {
    log.info(`scan-sessions: ${projectPath}`)
    const scanned = await scanAllSessions(projectPath, claudeCandidateDirs(), codexCandidateDirs())
    const result = enrichRecoveryCandidates(scanned)
    log.info(`recovery scan complete: ${result.length} native transcripts`)
    return result
  })

  host.handle(AppChannels.IMPORT_SESSION, async (
    projectPath: string,
    sessionId: string,
    source: 'claude-code' | 'codex' | 'cursor',
  ) => {
    const scanned = await scanAllSessions(projectPath, claudeCandidateDirs(), codexCandidateDirs())
    const candidates = enrichRecoveryCandidates(scanned)
    const candidate = candidates.find((session) => session.id === sessionId && session.source === source)
    if (!candidate) return { ok: false, error: 'Native session is no longer available' }
    if (!candidate.filePath) return { ok: false, error: 'This provider has no importable transcript' }

    if (source === 'cursor') {
      const loaded = await loadCursorConversation(projectPath, sessionId)
      if (!loaded) return { ok: false, error: 'The Cursor transcript could not be read' }
      if (!loaded.complete) {
        return { ok: false, error: 'The Cursor transcript is incomplete; no snapshot was changed' }
      }
      let imported: ReturnType<typeof importCursorSnapshot>
      try {
        imported = importCursorSnapshot(getDb(), {
          composerId: loaded.summary.id,
          projectPath,
          title: loaded.summary.title,
          startedAt: loaded.summary.startedAt,
          messages: loaded.messages,
        })
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Cursor import failed' }
      }
      host.emit(AppChannels.CONVERSATIONS_CHANGED)
      return { ok: true, session: projectManagedRootSessions(
        getManagedRootConversationsForProject(projectPath),
      ).find((session) => session.id === imported.conversationId) ?? null }
    }

    const delegated = candidate.nativeRole === 'subagent' || candidate.nativeRole === 'utility'
    const existingId = findManagedConversationForNativeSession(source, candidate.id, delegated)
    if (existingId) {
      const reviveResult = reviveConversationForRecovery(existingId, projectPath, candidate.title)
      if (reviveResult !== 'revived') {
        return reviveResult === 'project-mismatch'
          ? { ok: false, error: 'This conversation belongs to another project in Switchboard' }
          : { ok: false, error: 'The stored conversation no longer exists' }
      }
    }

    const messages = await loadJsonlCached(candidate.filePath, source === 'codex' ? 'codex' : 'claude-code')
    if (!messages) return { ok: false, error: 'The native transcript could not be read' }
    // Promotion creates a new logical root. Reusing the physical child id
    // would either stay hidden by its existing lineage row or mutate the
    // parent's ancestry, both of which violate the explicit-promotion model.
    const conversationId = existingId ?? logicalImportConversationId(
      candidate.id, resolveRootThreadId(candidate.id), delegated, `import_${randomUUID()}`,
    )
    const title = delegated ? `${candidate.title} · promoted` : candidate.title
    if (!existingId) {
      if (getConversationById(conversationId)) {
        const reviveResult = reviveConversationForRecovery(conversationId, projectPath, title)
        if (reviveResult !== 'revived') {
          return reviveResult === 'project-mismatch'
            ? { ok: false, error: 'This conversation belongs to another project in Switchboard' }
            : { ok: false, error: 'The stored conversation no longer exists' }
        }
      } else {
        promoteConversationToManaged(conversationId, projectPath, source, title)
      }
    }
    recordConversationSegment({
      conversationId,
      provider: source,
      providerSessionId: candidate.id,
    })
    bulkSaveMessages(conversationId, messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    })))
    host.emit(AppChannels.CONVERSATIONS_CHANGED)
    return { ok: true, session: projectManagedRootSessions(
      getManagedRootConversationsForProject(projectPath),
    ).find((session) => session.id === conversationId) ?? null }
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
    const convsByProject = getManagedRootConversationsForProjects(rows.map((row) => row.path))
    const projects: Project[] = rows.map((row) => ({
      path: row.path,
      name: row.name,
      sessions: projectManagedRootSessions(convsByProject.get(row.path) ?? []),
      workspaceId: row.workspace_id ?? null,
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

    const sessions = projectManagedRootSessions(getManagedRootConversationsForProject(dirPath))

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
    const rootThreadId = resolveRootThreadId(row.id)
    const rootRow = getConversationById(rootThreadId)
    // rootThreadId lets the renderer avoid building a twin session: the sidebar
    // lists a chat under its SDK session UUID, but a live adapter keys events to
    // the synthetic agent_<ts> thread. See resolveSessionSelectTarget.
    const meta = {
      id: row.id,
      title: row.title,
      projectPath: row.project_path,
      agentType: rootRow?.agent_type ?? row.agent_type,
      rootThreadId,
    }

    try {
      const history = await loadConversationHistory(conversationId, row.project_path)
      log.info(
        `load-by-id: ${conversationId} -> ${history.messages.length} messages ` +
        `(${history.diskMessageCount} disk, ${history.databaseMessageCount} DB) ` +
        `across ${history.familyIds.length} family id(s)`,
      )
      return capTail({ messages: history.messages, meta }, opts)
    } catch (err) {
      log.warn(`load-by-id failed for ${conversationId}: ${err}`)
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
  host.handle(AppChannels.ARCHIVE_CONVERSATION, (id: string) => {
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
