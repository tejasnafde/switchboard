import { contextBridge, ipcRenderer } from 'electron'
import { TerminalChannels, AgentChannels, AppChannels, ProviderChannels } from '@shared/ipc-channels'
import type {
  TerminalCreateOptions,
  TerminalResizePayload,
  AgentStartOptions,
  AgentSendPayload,
  CreateConversationParams,
  SaveMessageParams,
} from '@shared/types'
import type { RuntimeEvent, RuntimeMode, ApprovalDecision } from '@shared/provider-events'

/**
 * Options passed to `provider.startSession`. Duplicated from main's
 * `SessionStartOpts` to avoid pulling main-only types into shared.
 */
export interface StartSessionOpts {
  threadId: string
  provider: 'claude' | 'codex' | 'opencode'
  cwd: string
  model?: string
  runtimeMode?: RuntimeMode
  resumeSessionId?: string
  reasoningEffort?: 'low' | 'medium' | 'high'
}

/**
 * Expose a typed API to the renderer via contextBridge.
 * The renderer calls window.api.* — never touches ipcRenderer directly.
 */
const api = {
  // ─── Terminal ────────────────────────────────────────────────────
  terminal: {
    create: (opts: TerminalCreateOptions) =>
      ipcRenderer.invoke(TerminalChannels.CREATE, opts),

    write: (id: string, data: string) =>
      ipcRenderer.send(TerminalChannels.DATA, { id, data }),

    resize: (payload: TerminalResizePayload) =>
      ipcRenderer.send(TerminalChannels.RESIZE, payload),

    kill: (id: string) =>
      ipcRenderer.send(TerminalChannels.KILL, id),

    onOutput: (callback: (id: string, data: string) => void) => {
      const handler = (_: Electron.IpcRendererEvent, id: string, data: string) =>
        callback(id, data)
      ipcRenderer.on(TerminalChannels.OUTPUT, handler)
      return () => ipcRenderer.removeListener(TerminalChannels.OUTPUT, handler)
    },

    onExit: (callback: (id: string, exitCode: number) => void) => {
      const handler = (_: Electron.IpcRendererEvent, id: string, exitCode: number) =>
        callback(id, exitCode)
      ipcRenderer.on(TerminalChannels.EXIT, handler)
      return () => ipcRenderer.removeListener(TerminalChannels.EXIT, handler)
    },
  },

  // ─── Agent ─────────────────────────────────────────────────────
  agent: {
    start: (opts: AgentStartOptions) =>
      ipcRenderer.invoke(AgentChannels.START, opts),

    send: (payload: AgentSendPayload) =>
      ipcRenderer.invoke(AgentChannels.SEND, payload),

    kill: (id: string) =>
      ipcRenderer.send(AgentChannels.KILL, id),

    onMessage: (callback: (agentId: string, message: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, agentId: string, message: unknown) =>
        callback(agentId, message)
      ipcRenderer.on(AgentChannels.MESSAGE, handler)
      return () => ipcRenderer.removeListener(AgentChannels.MESSAGE, handler)
    },

    onMessageUpdate: (callback: (agentId: string, messageId: string, updates: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, agentId: string, messageId: string, updates: unknown) =>
        callback(agentId, messageId, updates)
      ipcRenderer.on(AgentChannels.MESSAGE_UPDATE, handler)
      return () => ipcRenderer.removeListener(AgentChannels.MESSAGE_UPDATE, handler)
    },

    onStatus: (callback: (agentId: string, status: string) => void) => {
      const handler = (_: Electron.IpcRendererEvent, agentId: string, status: string) =>
        callback(agentId, status)
      ipcRenderer.on(AgentChannels.STATUS, handler)
      return () => ipcRenderer.removeListener(AgentChannels.STATUS, handler)
    },

    onError: (callback: (agentId: string, error: string) => void) => {
      const handler = (_: Electron.IpcRendererEvent, agentId: string, error: string) =>
        callback(agentId, error)
      ipcRenderer.on(AgentChannels.ERROR, handler)
      return () => ipcRenderer.removeListener(AgentChannels.ERROR, handler)
    },
  },

  // ─── App ──────────────────────────────────────────────────────
  app: {
    openFolder: () => ipcRenderer.invoke(AppChannels.OPEN_FOLDER),
    scanSessions: (projectPath: string) =>
      ipcRenderer.invoke(AppChannels.SCAN_SESSIONS, projectPath),
    getProjects: () => ipcRenderer.invoke(AppChannels.GET_PROJECTS),
    createConversation: (params: CreateConversationParams) =>
      ipcRenderer.invoke(AppChannels.CREATE_CONVERSATION, params),
    loadSession: (filePath: string, conversationId?: string, source?: 'claude-code' | 'codex') =>
      ipcRenderer.invoke(AppChannels.LOAD_SESSION, filePath, conversationId, source),
    loadSessionById: (conversationId: string) =>
      ipcRenderer.invoke(AppChannels.LOAD_SESSION_BY_ID, conversationId),
    attachToThread: (fragmentId: string, rootThreadId: string) =>
      ipcRenderer.invoke(AppChannels.ATTACH_TO_THREAD, fragmentId, rootThreadId),
    detachSession: (claudeSessionId: string) =>
      ipcRenderer.invoke(AppChannels.DETACH_SESSION, claudeSessionId),
    listAncestry: () => ipcRenderer.invoke(AppChannels.LIST_ANCESTRY),
    saveMessage: (params: SaveMessageParams) =>
      ipcRenderer.invoke(AppChannels.SAVE_MESSAGE, params),
    renameConversation: (id: string, title: string) =>
      ipcRenderer.invoke(AppChannels.RENAME_CONVERSATION, id, title),
    getConversations: (projectPath: string) =>
      ipcRenderer.invoke(AppChannels.GET_CONVERSATIONS, projectPath),
    setVibrancy: (enabled: boolean) =>
      ipcRenderer.invoke(AppChannels.SET_VIBRANCY, enabled),
    saveSessionLayout: (sessionId: string, layoutJson: string) =>
      ipcRenderer.invoke(AppChannels.SAVE_SESSION_LAYOUT, sessionId, layoutJson),
    getSessionLayout: (sessionId: string) =>
      ipcRenderer.invoke(AppChannels.GET_SESSION_LAYOUT, sessionId),
    searchMessages: (query: string) =>
      ipcRenderer.invoke(AppChannels.SEARCH_MESSAGES, query),
    archiveConversation: (id: string, projectPath?: string, title?: string) =>
      ipcRenderer.invoke(AppChannels.ARCHIVE_CONVERSATION, id, projectPath, title),
    unarchiveConversation: (id: string) =>
      ipcRenderer.invoke(AppChannels.UNARCHIVE_CONVERSATION, id),
    getArchivedConversations: () =>
      ipcRenderer.invoke(AppChannels.GET_ARCHIVED_CONVERSATIONS),
    exportMarkdown: (params: { suggestedFilename: string; content: string }) =>
      ipcRenderer.invoke(AppChannels.EXPORT_MARKDOWN, params),
    getWorkspaceConfig: (projectPath: string) =>
      ipcRenderer.invoke(AppChannels.GET_WORKSPACE_CONFIG, projectPath),
    saveWorkspaceConfig: (projectPath: string, yamlContent: string) =>
      ipcRenderer.invoke(AppChannels.SAVE_WORKSPACE_CONFIG, projectPath, yamlContent),
    /**
     * Manual "check for updates" trigger. Returns the most recent
     * status the main process saw (or `unsupported` in dev). Live
     * progress flows through `onUpdateStatus` below.
     */
    checkForUpdates: () =>
      ipcRenderer.invoke(AppChannels.CHECK_FOR_UPDATES),
    /**
     * Subscribe to update lifecycle events from the main-process
     * autoUpdater (checking → available → downloading → downloaded |
     * up-to-date | error). The Settings UI uses this to render a
     * status line that reflects what the updater is doing.
     */
    onUpdateStatus: (callback: (status: import('@shared/update-status').UpdateStatus) => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: import('@shared/update-status').UpdateStatus) =>
        callback(status)
      ipcRenderer.on(AppChannels.UPDATE_STATUS, handler)
      return () => ipcRenderer.removeListener(AppChannels.UPDATE_STATUS, handler)
    },
    /**
     * Quit the app and relaunch into the downloaded update. Only valid
     * after `onUpdateStatus` reports `{ kind: 'downloaded' }`.
     */
    quitAndInstall: () => {
      ipcRenderer.send('app:quit-and-install')
    },
  },

  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('settings:remove', key),
  },

  // ─── Provider (new agent bridge) ──────────────────────────────
  // Typed against the shared RuntimeEvent union so the renderer can switch
  // on event.type without casts. Methods mirror the main-process
  // ProviderAdapter interface.
  provider: {
    startSession: (opts: StartSessionOpts) =>
      ipcRenderer.invoke(ProviderChannels.START_SESSION, opts),

    sendTurn: (threadId: string, message: string, runtimeMode?: RuntimeMode, images?: Array<{ url: string; mimeType?: string }>) =>
      ipcRenderer.invoke(ProviderChannels.SEND_TURN, threadId, message, runtimeMode, images),

    interrupt: (threadId: string) =>
      ipcRenderer.invoke(ProviderChannels.INTERRUPT, threadId),

    setRuntimeMode: (threadId: string, mode: RuntimeMode) =>
      ipcRenderer.invoke(ProviderChannels.SET_RUNTIME_MODE, threadId, mode),

    setModel: (threadId: string, model: string) =>
      ipcRenderer.invoke(ProviderChannels.SET_MODEL, threadId, model),

    /** Dynamically fetch `opencode models` output. Returns provider/model IDs. */
    listOpencodeModels: (): Promise<string[]> =>
      ipcRenderer.invoke(ProviderChannels.OPENCODE_LIST_MODELS),

    /**
     * Fetch the agent-defined slash commands/skills for a session
     * (Claude SDK's `init.commands`, Codex's `skills/list`). Returns `[]`
     * for providers without a skill registry (OpenCode) or before the
     * session has fully initialized.
     */
    listSkills: (threadId: string): Promise<import('@shared/types').ProviderSkill[]> =>
      ipcRenderer.invoke(ProviderChannels.LIST_SKILLS, threadId),

    answerQuestion: (threadId: string, requestId: string, answers: string[][]) =>
      ipcRenderer.invoke(ProviderChannels.ANSWER_QUESTION, threadId, requestId, answers),

    respondToRequest: (threadId: string, requestId: string, decision: ApprovalDecision) =>
      ipcRenderer.invoke(ProviderChannels.RESPOND_TO_REQUEST, threadId, requestId, decision),

    stopSession: (threadId: string) =>
      ipcRenderer.invoke(ProviderChannels.STOP_SESSION, threadId),

    isAvailable: (provider: 'claude' | 'codex') =>
      ipcRenderer.invoke(ProviderChannels.IS_AVAILABLE, provider),

    onEvent: (callback: (event: RuntimeEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: RuntimeEvent) => callback(event)
      ipcRenderer.on(ProviderChannels.EVENT, handler)
      return () => { ipcRenderer.removeListener(ProviderChannels.EVENT, handler) }
    },
  },

  // Menu events from main process
  onOpenSettings: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on('app:open-settings', handler)
    return () => ipcRenderer.removeListener('app:open-settings', handler)
  },

  getLogPaths: () => ipcRenderer.invoke('app:get-log-paths'),

  onClosePaneOrWindow: (callback: (opts: { shift?: boolean }) => void) => {
    const handler = (_: Electron.IpcRendererEvent, opts: { shift?: boolean }) => callback(opts ?? {})
    ipcRenderer.on('app:close-pane-or-window', handler)
    return () => ipcRenderer.removeListener('app:close-pane-or-window', handler)
  },

  closeWindow: () => {
    ipcRenderer.send('app:close-window')
  },
}

contextBridge.exposeInMainWorld('api', api)

export type SwitchboardAPI = typeof api
