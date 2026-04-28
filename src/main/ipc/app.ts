import { ipcMain, dialog, app, type BrowserWindow } from 'electron'
import { basename } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { AppChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import { scanAllSessions, encodeClaudeProjectPath } from '../projects/session-scanner'
import { homedir } from 'os'
import { join as joinPath } from 'path'
import {
  addProject,
  getProjects,
  getSetting,
  setSetting,
  removeSetting,
  createConversation,
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
  getChildSessionIds,
  getSyntheticParentMap,
  listSessionIdsForThread,
  recordThreadSession,
  detachSession,
  listAllThreadSessions,
} from '../db/database'
import { JsonlParser } from '../agent/jsonl-parser'
import { readWorkspaceConfig, writeWorkspaceConfig, watchWorkspaceConfig } from '../workspace/workspace-store'
import type { Project, CreateConversationParams, SaveMessageParams, ChatMessage } from '@shared/types'

const log = createLogger('ipc:app')

export function registerAppHandlers(window: BrowserWindow): void {
  // Remove previous handlers to allow re-registration (macOS activate)
  for (const ch of Object.values(AppChannels)) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.removeHandler('settings:get')
  ipcMain.removeHandler('settings:set')
  ipcMain.removeHandler('settings:remove')

  ipcMain.handle(AppChannels.OPEN_FOLDER, async () => {
    log.info('open-folder dialog')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Add Project Folder',
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const folderPath = result.filePaths[0]
    const name = basename(folderPath)
    log.info(`folder selected: ${folderPath}`)

    // Persist to SQLite
    addProject(folderPath, name)

    // Scan for existing sessions (filter archived globally)
    const rawSessions = await scanAllSessions(folderPath)
    const archivedSet = getArchivedConversationIds()
    const sessions = rawSessions.filter((s) => !archivedSet.has(s.id))
    log.info(`found ${sessions.length} sessions for ${folderPath} (${rawSessions.length - sessions.length} archived)`)

    const project: Project = { path: folderPath, name, sessions }
    return project
  })

  ipcMain.handle(AppChannels.SCAN_SESSIONS, async (_event, projectPath: string) => {
    log.info(`scan-sessions: ${projectPath}`)
    const sessions = await scanAllSessions(projectPath)
    const archivedSet = getArchivedConversationIds()
    const childSet = getChildSessionIds()
    const syntheticParents = getSyntheticParentMap()
    const dbConversations = getConversationsForProject(projectPath)
    const titleMap = new Map(dbConversations.map((c) => [c.id, c.title]))
    const filtered = sessions
      // Hide archived chats (global set — across project paths) and child
      // session_ids produced by Claude SDK rotation (tracked in thread_sessions).
      .filter((s) => !archivedSet.has(s.id) && !childSet.has(s.id))
      .map((s) => {
        // Direct title match (UUID is the canonical conversation id)
        const direct = titleMap.get(s.id)
        if (direct) return { ...s, title: direct }
        // Title inheritance: UUID has a synthetic `agent_<ts>` parent in
        // thread_sessions. Look up the parent's title from conversations.
        const parentId = syntheticParents.get(s.id)
        if (parentId) {
          const parentTitle = titleMap.get(parentId)
          if (parentTitle) return { ...s, title: parentTitle }
        }
        return s
      })
    log.info(`scan complete: ${filtered.length} visible (${sessions.length - filtered.length} archived/child)`)
    return filtered
  })

  // Settings
  ipcMain.handle('settings:get', (_event, key: string) => getSetting(key))
  ipcMain.handle('settings:set', (_event, key: string, value: string) => setSetting(key, value))
  ipcMain.handle('settings:remove', (_event, key: string) => removeSetting(key))

  // Load persisted projects on renderer request
  ipcMain.handle(AppChannels.GET_PROJECTS, async () => {
    const rows = getProjects()
    // Global exclusion sets — archived + session_ids that are children of
    // another thread (fragmented by Claude SDK session-id rotation).
    const archivedSet = getArchivedConversationIds()
    const childSet = getChildSessionIds()
    const syntheticParents = getSyntheticParentMap()
    const projects: Project[] = []
    for (const row of rows) {
      const sessions = await scanAllSessions(row.path)
      const dbConversations = getConversationsForProject(row.path)
      const titleMap = new Map(dbConversations.map((c) => [c.id, c.title]))
      const filtered = sessions
        .filter((s) => !archivedSet.has(s.id) && !childSet.has(s.id))
        .map((s) => {
          const direct = titleMap.get(s.id)
          if (direct) return { ...s, title: direct }
          const parentId = syntheticParents.get(s.id)
          if (parentId) {
            const parentTitle = titleMap.get(parentId)
            if (parentTitle) return { ...s, title: parentTitle }
          }
          return s
        })
      projects.push({ path: row.path, name: row.name, sessions: filtered })
    }
    return projects
  })

  // Create a new conversation in the database
  ipcMain.handle(AppChannels.CREATE_CONVERSATION, (_event, params: CreateConversationParams) => {
    createConversation(params.id, params.projectPath, params.agentType, params.title)
    log.info(`conversation created: ${params.id} project=${params.projectPath}`)
    return { id: params.id }
  })

  // Load a session from a JSONL file on disk.
  // `source` selects the parser variant: 'claude-code' (default) or 'codex'.
  // Without this param, Codex sessions loaded as empty because their event
  // schema doesn't match Claude's.
  ipcMain.handle(AppChannels.LOAD_SESSION, async (
    _event,
    filePath: string,
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
        } catch { /* indexing failed — search won't find these, but load still works */ }
      }

      return messages
    } catch (err) {
      log.warn(`failed to load session: ${filePath} ${err}`)
      return []
    }
  })

  // Load a session by conversation id — looks up project_path in the DB,
  // computes the JSONL file path, and returns the parsed messages.
  //
  // If this thread has child session_ids (Claude SDK rotated session_id
  // during compaction/restart), concatenate messages from ALL fragments
  // in chronological order. One click in the sidebar → one coherent
  // conversation, regardless of how many .jsonl files it actually spans.
  ipcMain.handle(AppChannels.LOAD_SESSION_BY_ID, async (
    _event,
    conversationId: string,
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
      const all: ChatMessage[] = []
      for (const sid of sessionIds) {
        const filePath = joinPath(homedir(), '.claude', 'projects', encoded, `${sid}.jsonl`)
        try {
          const raw = await readFile(filePath, 'utf-8')
          const parser = new JsonlParser((msg) => all.push(msg), 'claude-code')
          parser.feed(raw)
          parser.flush()
        } catch {
          // Session_id might not have a jsonl (e.g. failed before first turn)
        }
      }
      // Merge in timestamp order so fragments interleave correctly.
      all.sort((a, b) => a.timestamp - b.timestamp)
      // Deduplicate by message id — later JSONL fragments re-include context
      // from earlier ones (same tool_use blocks), causing duplicate React keys.
      const seen = new Set<string>()
      const deduped = all.filter((m) => {
        if (seen.has(m.id)) return false
        seen.add(m.id)
        return true
      })
      log.info(`load-by-id: ${conversationId} → ${deduped.length} messages (${all.length - deduped.length} dupes removed) across ${sessionIds.length} fragment(s)`)
      return { messages: deduped, meta }
    }

    // Codex fallback — scan all sessions for this project, find matching id(s)
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
      return { messages: dedupedCodex, meta }
    } catch (err) {
      log.warn(`load-by-id (codex) failed for ${conversationId}: ${err}`)
      return { messages: [], meta }
    }
  })

  // Save a message to the database
  ipcMain.handle(AppChannels.SAVE_MESSAGE, (_event, params: SaveMessageParams) => {
    saveMessage(params.id, params.conversationId, params.role, params.content, params.toolCalls, params.images)
    return { ok: true }
  })

  // Rename a conversation
  ipcMain.handle(AppChannels.RENAME_CONVERSATION, (_event, id: string, title: string) => {
    updateConversationTitle(id, title)
    log.info(`conversation renamed: ${id} → ${title}`)
    return { ok: true }
  })

  // Get conversations for a project
  ipcMain.handle(AppChannels.GET_CONVERSATIONS, (_event, projectPath: string) => {
    watchWorkspaceConfig(projectPath) // Start watching as soon as project is loaded
    return getConversationsForProject(projectPath)
  })

  // Session layout persistence
  ipcMain.handle(AppChannels.SAVE_SESSION_LAYOUT, (_event, sessionId: string, layoutJson: string) => {
    saveSessionLayout(sessionId, layoutJson)
    return { ok: true }
  })

  ipcMain.handle(AppChannels.GET_SESSION_LAYOUT, (_event, sessionId: string) => {
    return getSessionLayout(sessionId)
  })

  // Workspace config (per-project, stored in app support)
  ipcMain.handle(AppChannels.GET_WORKSPACE_CONFIG, (_event, projectPath: string) => {
    return readWorkspaceConfig(projectPath)
  })

  ipcMain.handle(AppChannels.SAVE_WORKSPACE_CONFIG, (_event, projectPath: string, yamlContent: string) => {
    writeWorkspaceConfig(projectPath, yamlContent)
    return { ok: true }
  })

  // Search across conversations (FTS5)
  ipcMain.handle(AppChannels.SEARCH_MESSAGES, (_event, query: string) => {
    return searchMessages(query)
  })

  // Archive / unarchive conversations
  ipcMain.handle(AppChannels.ARCHIVE_CONVERSATION, (_event, id: string, projectPath?: string, title?: string) => {
    // Ensure row exists (for scanned-but-not-yet-persisted sessions)
    if (projectPath) {
      ensureConversation(id, projectPath, 'claude-code', title ?? 'Session')
    }
    archiveConversation(id)
    return { ok: true, archived: isConversationArchived(id) }
  })

  ipcMain.handle(AppChannels.UNARCHIVE_CONVERSATION, (_event, id: string) => {
    unarchiveConversation(id)
    return { ok: true }
  })

  ipcMain.handle(AppChannels.GET_ARCHIVED_CONVERSATIONS, () => {
    return getArchivedConversations()
  })

  ipcMain.handle(AppChannels.RELAUNCH, () => {
    log.info('relaunching app...')
    app.relaunch()
    app.exit(0)
  })

  // Export conversation as markdown — renderer serializes, main writes.
  // Remove a row from thread_sessions — un-hides a session from the
  // sidebar. Used when an automatic ancestry record was wrong, or when
  // the user wants to unmerge.
  ipcMain.handle(AppChannels.DETACH_SESSION, (_event, claudeSessionId: string) => {
    const ok = detachSession(claudeSessionId)
    log.info(`detach: ${claudeSessionId} ${ok ? 'removed' : 'no-op (no row found)'}`)
    return { ok }
  })

  // Debug: dump all ancestry rows so a user can inspect via devtools.
  ipcMain.handle(AppChannels.LIST_ANCESTRY, () => listAllThreadSessions())

  // Manually attach a conversation row as a child of another thread —
  // lets users stitch pre-ancestry fragments together. After this runs,
  // `fragmentId` disappears from the sidebar and its messages load under
  // `rootThreadId`.
  ipcMain.handle(AppChannels.ATTACH_TO_THREAD, (
    _event,
    fragmentId: string,
    rootThreadId: string,
  ) => {
    if (fragmentId === rootThreadId) return { ok: false, error: 'cannot attach to self' }
    try {
      recordThreadSession(fragmentId, rootThreadId)
      log.info(`attached ${fragmentId} → thread ${rootThreadId}`)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'unknown' }
    }
  })

  ipcMain.handle(AppChannels.EXPORT_MARKDOWN, async (
    _event,
    params: { suggestedFilename: string; content: string },
  ) => {
    const result = await dialog.showSaveDialog(window, {
      title: 'Export Conversation',
      defaultPath: params.suggestedFilename,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    try {
      await writeFile(result.filePath, params.content, 'utf-8')
      log.info(`exported markdown: ${result.filePath}`)
      return { ok: true, path: result.filePath }
    } catch (err: any) {
      log.error(`export failed: ${err?.message}`)
      return { ok: false, error: err?.message ?? 'Unknown error' }
    }
  })

  // Vibrancy toggle for translucent theme
  ipcMain.handle(AppChannels.SET_VIBRANCY, (_event, enabled: boolean) => {
    if (window.isDestroyed()) return
    if (process.platform === 'darwin') {
      if (enabled) {
        window.setVibrancy('sidebar')
        window.setBackgroundColor('#00000000')
      } else {
        window.setVibrancy(null as any)
        window.setBackgroundColor('#0d1117')
      }
    }
  })
}
