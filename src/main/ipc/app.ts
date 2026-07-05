import type { BackendHost } from '../backend/host'
import { readFile, stat } from 'fs/promises'
import { AppChannels, BookmarkChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { scanAllSessions, encodeClaudeProjectPath } from '../projects/session-scanner'
import { synthesizeTerminalSessions, stampAgentTypes } from './terminal-sessions'
import { homedir } from 'os'
import { basename, join as joinPath } from 'path'
import {
  addProject,
  getProjects,
  getSetting,
  setSetting,
  removeSetting,
  createConversation,
  setConversationWorktree,
  loadEditorTabs,
  saveEditorTabs,
  saveBookmark,
  removeBookmark,
  listBookmarks,
  updateConversationTitle,
  saveMessage,
  getConversationsForProject,
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
  getChildSessionIds,
  getSyntheticParentMap,
  listSessionIdsForThread,
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
  getDisplayBodyEnrichments,
  getSystemMarkerMessages,
} from '../db/database'
import { listOauthDirsForAgent } from '../db/providerInstances'
import { defaultClaudeDir } from '../provider/claude-session-migrate'
import { enrichMessagesWithDisplayBody } from './enrichDisplayBody'
import { JsonlParser } from '../agent/jsonl-parser'
import { forkConversation } from '../conversations/fork'
import { readWorkspaceConfig, writeWorkspaceConfig, watchWorkspaceConfig, setWorkspaceEmitter } from '../workspace/workspace-store'
import type { Project, CreateConversationParams, SaveMessageParams, ChatMessage } from '@shared/types'

const log = createLogger('ipc:app')

/** All Claude config roots: every enabled oauth_dir + the default ~/.claude. */
export function claudeCandidateDirs(): string[] {
  return Array.from(new Set([
    ...listOauthDirsForAgent('claude-code'),
    defaultClaudeDir(),
  ]))
}

// Data handlers - transport-agnostic, run on either ElectronIpcHost or WsHost.
// Native-dialog / window / app-lifecycle handlers live in app-desktop.ts.
export function registerAppHandlers(host: BackendHost): void {
  setWorkspaceEmitter((channel, ...args) => host.emit(channel, ...args))

  host.handle(AppChannels.SCAN_SESSIONS, async (projectPath: string) => {
    log.info(`scan-sessions: ${projectPath}`)
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

    const terminalSessions = synthesizeTerminalSessions(dbConversations, archivedSet, scannedIds)
    const result = [...filtered, ...terminalSessions]
    log.info(`scan complete: ${result.length} visible (${sessions.length - filtered.length} archived/child, ${terminalSessions.length} terminal)`)
    return result
  })

  // Settings
  host.handle('settings:get', (key: string) => getSetting(key))
  host.handle('settings:set', (key: string, value: string) => setSetting(key, value))
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
    // Scan projects concurrently - each scanAllSessions is independent I/O and
    // was previously awaited one project at a time, serializing every sidebar/
    // settings/kanban refresh over the full session filesystem.
    const projects: Project[] = await Promise.all(rows.map(async (row) => {
      const sessions = await scanAllSessions(row.path, candidateDirs)
      const dbConversations = getConversationsForProject(row.path)
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
      const terminalSessions = synthesizeTerminalSessions(dbConversations, archivedSet, scannedIds)
      return { path: row.path, name: row.name, sessions: [...filtered, ...terminalSessions], workspaceId: row.workspace_id ?? null }
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

  // Create a new conversation in the database
  host.handle(AppChannels.EDITOR_TABS_LOAD, (sessionId: string) => {
    try {
      const rows = loadEditorTabs(sessionId)
      return {
        ok: true,
        tabs: rows.map((r) => ({
          path: r.path,
          cursorLine: r.cursor_line,
          cursorCol: r.cursor_col,
          scrollTop: r.scroll_top,
          isActive: !!r.is_active,
        })),
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message, tabs: [] }
    }
  })

  host.handle(
    AppChannels.EDITOR_TABS_SAVE,
    (sessionId: string,
      tabs: Array<{ path: string; cursorLine: number; cursorCol: number; scrollTop: number; isActive: boolean }>,
    ) => {
      try {
        saveEditorTabs(sessionId, tabs)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    },
  )

  host.handle(
    AppChannels.SET_CONVERSATION_WORKTREE,
    (conversationId: string,
      worktreePath: string | null,
      worktreeBranch: string | null,
    ) => {
      setConversationWorktree(conversationId, worktreePath, worktreeBranch)
      return { ok: true }
    },
  )

  host.handle(AppChannels.CREATE_CONVERSATION, (params: CreateConversationParams) => {
    createConversation(
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
      const raw = await readFile(filePath, 'utf-8')
      const messages: ChatMessage[] = []
      const parser = new JsonlParser((msg) => messages.push(msg), source ?? 'claude-code')
      parser.feed(raw)
      parser.flush()
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
  ): Promise<{
    messages: ChatMessage[]
    meta: { id: string; title: string; projectPath: string; agentType: string } | null
  }> => {
    const row = getConversationById(conversationId)
    if (!row) return { messages: [], meta: null }
    const source: 'claude-code' | 'codex' = row.agent_type === 'codex' ? 'codex' : 'claude-code'
    const meta = { id: row.id, title: row.title, projectPath: row.project_path, agentType: row.agent_type }

    // All session_ids that belong to this thread (root + children).
    const sessionIds = listSessionIdsForThread(conversationId)

    if (source === 'claude-code') {
      const encoded = encodeClaudeProjectPath(row.project_path)
      // Scan every known Claude profile dir (every enabled oauth_dir + ~/.claude).
      // Without this, switching instances mid-conversation hides turns that
      // landed in the alternate profile after restart, because the SDK
      // writes JSONLs under the active CLAUDE_CONFIG_DIR - not ~/.claude.
      const candidateDirs = Array.from(new Set([
        ...listOauthDirsForAgent('claude-code'),
        defaultClaudeDir(),
      ]))
      const all: ChatMessage[] = []
      for (const sid of sessionIds) {
        for (const dir of candidateDirs) {
          const filePath = joinPath(dir, 'projects', encoded, `${sid}.jsonl`)
          try {
            const raw = await readFile(filePath, 'utf-8')
            const parser = new JsonlParser((msg) => all.push(msg), 'claude-code')
            parser.feed(raw)
            parser.flush()
          } catch {
            // Session_id might not have a jsonl in this profile (rotation
            // didn't migrate it, or session never ran here).
          }
        }
      }
      // Merge in timestamp order so fragments interleave correctly.
      all.sort((a, b) => a.timestamp - b.timestamp)
      // Deduplicate by message id - later JSONL fragments re-include context
      // from earlier ones (same tool_use blocks), causing duplicate React keys.
      const seen = new Set<string>()
      const deduped = all.filter((m) => {
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })
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
      log.info(`load-by-id: ${conversationId} → ${deduped.length} messages (${all.length - deduped.length} dupes removed) across ${sessionIds.length} fragment(s), +${markers.length} marker(s)`)
      return { messages: merged, meta }
    }

    // Codex fallback - scan all sessions for this project, find matching id(s)
    try {
      const sessions = await scanAllSessions(row.project_path)
      const all: ChatMessage[] = []
      for (const sid of sessionIds) {
        const match = sessions.find((s) => s.id === sid)
        if (!match?.filePath) continue
        const raw = await readFile(match.filePath, 'utf-8')
        const parser = new JsonlParser((msg) => all.push(msg), 'codex')
        parser.feed(raw)
        parser.flush()
      }
      all.sort((a, b) => a.timestamp - b.timestamp)
      const seenCodex = new Set<string>()
      const dedupedCodex = all.filter((m) => {
        if (seenCodex.has(m.id)) return false
        seenCodex.add(m.id)
        return true
      })
      const enrichedCodex = enrichMessagesWithDisplayBody(dedupedCodex, getDisplayBodyEnrichments(conversationId))
      const markersCodex = getSystemMarkerMessages(conversationId).map((m) => ({
        id: m.id,
        role: 'system' as const,
        content: m.content,
        timestamp: m.timestamp,
      }))
      const mergedCodex = [...enrichedCodex, ...markersCodex].sort((a, b) => a.timestamp - b.timestamp)
      return { messages: mergedCodex, meta }
    } catch (err) {
      log.warn(`load-by-id (codex) failed for ${conversationId}: ${err}`)
      return { messages: [], meta }
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

  // Rename a conversation
  host.handle(AppChannels.RENAME_CONVERSATION, (id: string, title: string) => {
    updateConversationTitle(id, title)
    log.info(`conversation renamed: ${id} → ${title}`)
    return { ok: true }
  })

  // Get conversations for a project
  host.handle(AppChannels.GET_CONVERSATIONS, (projectPath: string) => {
    watchWorkspaceConfig(projectPath) // Start watching as soon as project is loaded
    return getConversationsForProject(projectPath)
  })

  // Session layout persistence
  host.handle(AppChannels.SAVE_SESSION_LAYOUT, (sessionId: string, layoutJson: string, templateName?: string | null) => {
    saveSessionLayout(sessionId, layoutJson, templateName ?? null)
    return { ok: true }
  })

  host.handle(AppChannels.GET_SESSION_LAYOUT, (sessionId: string) => {
    return getSessionLayout(sessionId)
  })

  // Workspace config (per-project, stored in app support)
  host.handle(AppChannels.GET_WORKSPACE_CONFIG, (projectPath: string) => {
    return readWorkspaceConfig(projectPath)
  })

  host.handle(AppChannels.SAVE_WORKSPACE_CONFIG, (projectPath: string, yamlContent: string) => {
    writeWorkspaceConfig(projectPath, yamlContent)
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
