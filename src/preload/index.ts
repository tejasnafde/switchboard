import { contextBridge } from 'electron'
import { IpcTransport, type Transport } from './transport'
import { WsTransport } from '@shared/ws-transport'
import { HybridTransport } from './hybrid-transport'
import { TransportRouter } from './transport-router'
import { RoutingTable } from './routing-table'
import { TerminalChannels, AgentChannels, AppChannels, ProviderChannels, FilesChannels, GitChannels, IdeChannels, LspChannels, KanbanChannels, MachineChannels, ProviderInstanceChannels, BookmarkChannels } from '@shared/ipc-channels'
import type { KanbanCard, KanbanCardCreate, KanbanCardUpdate, WorktreeInfo } from '@shared/kanban'
import type { Machine, MachineInput, SshHost, MachineSnapshot } from '@shared/machines'
import type {
  TerminalCreateOptions,
  TerminalResizePayload,
  AgentStartOptions,
  AgentSendPayload,
  CreateConversationParams,
  SaveMessageParams,
} from '@shared/types'
import type { RuntimeEvent, RuntimeMode, ApprovalDecision } from '@shared/provider-events'
import { createRendererLogger } from '../renderer/logger'

const log = createRendererLogger('preload:provider')

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
  /** Provider instance id (named credential set). Falls back to default. */
  instanceId?: string
  /** Remote-only: oauth_dir basename, attached by startSession below (not the
   *  renderer) so a remote Claude session mirrors the per-instance config dir. */
  remoteConfigDir?: string
}

export interface ProviderInstanceUpsertInput {
  id?: string
  agentType: 'claude-code' | 'codex' | 'opencode'
  displayName: string
  accentColor?: string | null
  authMode?: 'env' | 'oauth_dir'
  /** Plaintext env map. Encrypted in main process before persisting. */
  env?: Record<string, string> | null
  oauthDir?: string | null
  enabled?: boolean
}

/**
 * Expose a typed API to the renderer via contextBridge.
 * The renderer calls window.api.* - never touches ipcRenderer directly; every
 * method goes through `transport`, the swappable renderer↔backend seam.
 */
// SWITCHBOARD_BACKEND_URL (e.g. ws://vm-host:8765) points the app at a remote
// backend; desktop-only channels still resolve to local IPC via HybridTransport.
// Unset → fully local, as before.
const backendUrl = process.env.SWITCHBOARD_BACKEND_URL
const baseTransport: Transport = backendUrl
  ? new HybridTransport(new IpcTransport(), new WsTransport(backendUrl))
  : new IpcTransport()
if (backendUrl) console.info(`[SB:preload] remote backend: ${backendUrl}`)
// Router holds 'local' (above) plus a WsTransport per connected remote; the
// routing table decides which one each call hits (keyed by threadId/terminal id
// the renderer binds at creation). Unbound calls stay local, so a fully-local
// app behaves exactly as before.
const routingTable = new RoutingTable()
const router = new TransportRouter(baseTransport, (channel, args) => routingTable.resolve(channel, args))
const remoteTransports = new Map<string, WsTransport>()
const transport: Transport = router

const api = {
  // ─── Terminal ────────────────────────────────────────────────────
  terminal: {
    create: (opts: TerminalCreateOptions) =>
      transport.invoke(TerminalChannels.CREATE, opts),

    write: (id: string, data: string) =>
      transport.send(TerminalChannels.DATA, { id, data }),

    resize: (payload: TerminalResizePayload) =>
      transport.send(TerminalChannels.RESIZE, payload),

    kill: (id: string) =>
      transport.send(TerminalChannels.KILL, id),

    onOutput: (callback: (id: string, data: string) => void) =>
      transport.on<[string, string]>(TerminalChannels.OUTPUT, (id, data) => callback(id, data)),

    onExit: (callback: (id: string, exitCode: number) => void) =>
      transport.on<[string, number]>(TerminalChannels.EXIT, (id, exitCode) => callback(id, exitCode)),
  },

  // ─── Agent ─────────────────────────────────────────────────────
  agent: {
    start: (opts: AgentStartOptions) =>
      transport.invoke(AgentChannels.START, opts),

    send: (payload: AgentSendPayload) =>
      transport.invoke(AgentChannels.SEND, payload),

    kill: (id: string) =>
      transport.send(AgentChannels.KILL, id),

    onMessage: (callback: (agentId: string, message: unknown) => void) =>
      transport.on<[string, unknown]>(AgentChannels.MESSAGE, (agentId, message) => callback(agentId, message)),

    onMessageUpdate: (callback: (agentId: string, messageId: string, updates: unknown) => void) =>
      transport.on<[string, string, unknown]>(AgentChannels.MESSAGE_UPDATE, (agentId, messageId, updates) =>
        callback(agentId, messageId, updates)),

    onStatus: (callback: (agentId: string, status: string) => void) =>
      transport.on<[string, string]>(AgentChannels.STATUS, (agentId, status) => callback(agentId, status)),

    onError: (callback: (agentId: string, error: string) => void) =>
      transport.on<[string, string]>(AgentChannels.ERROR, (agentId, error) => callback(agentId, error)),
  },

  // ─── App ──────────────────────────────────────────────────────
  app: {
    openFolder: () => transport.invoke(AppChannels.OPEN_FOLDER),
    scanSessions: (projectPath: string) =>
      transport.invoke(AppChannels.SCAN_SESSIONS, projectPath),
    getProjects: () => transport.invoke(AppChannels.GET_PROJECTS),
    createConversation: (params: CreateConversationParams) =>
      transport.invoke(AppChannels.CREATE_CONVERSATION, params),
    setConversationWorktree: (
      conversationId: string,
      worktreePath: string | null,
      worktreeBranch: string | null,
    ): Promise<{ ok: true }> =>
      transport.invoke(
        AppChannels.SET_CONVERSATION_WORKTREE,
        conversationId,
        worktreePath,
        worktreeBranch,
      ),
    editorTabsLoad: (
      sessionId: string,
    ): Promise<{
      ok: boolean
      error?: string
      tabs: Array<{ path: string; cursorLine: number; cursorCol: number; scrollTop: number; isActive: boolean }>
    }> => transport.invoke(AppChannels.EDITOR_TABS_LOAD, sessionId),
    editorTabsSave: (
      sessionId: string,
      tabs: Array<{ path: string; cursorLine: number; cursorCol: number; scrollTop: number; isActive: boolean }>,
    ): Promise<{ ok: boolean; error?: string }> =>
      transport.invoke(AppChannels.EDITOR_TABS_SAVE, sessionId, tabs),
    loadSession: (filePath: string, conversationId?: string, source?: 'claude-code' | 'codex') =>
      transport.invoke(AppChannels.LOAD_SESSION, filePath, conversationId, source),
    loadSessionById: (conversationId: string) =>
      transport.invoke(AppChannels.LOAD_SESSION_BY_ID, conversationId),
    attachToThread: (fragmentId: string, rootThreadId: string) =>
      transport.invoke(AppChannels.ATTACH_TO_THREAD, fragmentId, rootThreadId),
    detachSession: (claudeSessionId: string) =>
      transport.invoke(AppChannels.DETACH_SESSION, claudeSessionId),
    listAncestry: () => transport.invoke(AppChannels.LIST_ANCESTRY),
    relaunch: () => transport.invoke(AppChannels.RELAUNCH),
    saveMessage: (params: SaveMessageParams) =>
      transport.invoke(AppChannels.SAVE_MESSAGE, params),
    renameConversation: (id: string, title: string) =>
      transport.invoke(AppChannels.RENAME_CONVERSATION, id, title),
    getConversationRuntimeMode: (id: string): Promise<{ mode: RuntimeMode | null }> =>
      transport.invoke(AppChannels.GET_CONVERSATION_RUNTIME_MODE, id),
    setConversationRuntimeMode: (id: string, mode: RuntimeMode): Promise<{ ok: boolean }> =>
      transport.invoke(AppChannels.SET_CONVERSATION_RUNTIME_MODE, id, mode),
    getConversationProviderInstanceId: (id: string): Promise<{ instanceId: string | null }> =>
      transport.invoke(AppChannels.GET_CONVERSATION_PROVIDER_INSTANCE_ID, id),
    setConversationProviderInstanceId: (id: string, instanceId: string): Promise<{ ok: boolean }> =>
      transport.invoke(AppChannels.SET_CONVERSATION_PROVIDER_INSTANCE_ID, id, instanceId),
    getConversations: (projectPath: string) =>
      transport.invoke(AppChannels.GET_CONVERSATIONS, projectPath),
    setVibrancy: (enabled: boolean) =>
      transport.invoke(AppChannels.SET_VIBRANCY, enabled),
    saveSessionLayout: (sessionId: string, layoutJson: string, templateName?: string | null) =>
      transport.invoke(AppChannels.SAVE_SESSION_LAYOUT, sessionId, layoutJson, templateName ?? null),
    getSessionLayout: (sessionId: string) =>
      transport.invoke(AppChannels.GET_SESSION_LAYOUT, sessionId) as Promise<{ layoutJson: string; templateName: string | null } | null>,
    searchMessages: (query: string) =>
      transport.invoke(AppChannels.SEARCH_MESSAGES, query),
    archiveConversation: (id: string, projectPath?: string, title?: string) =>
      transport.invoke(AppChannels.ARCHIVE_CONVERSATION, id, projectPath, title),
    unarchiveConversation: (id: string) =>
      transport.invoke(AppChannels.UNARCHIVE_CONVERSATION, id),
    getArchivedConversations: () =>
      transport.invoke(AppChannels.GET_ARCHIVED_CONVERSATIONS),
    exportMarkdown: (params: { suggestedFilename: string; content: string }) =>
      transport.invoke(AppChannels.EXPORT_MARKDOWN, params),
    getWorkspaceConfig: (projectPath: string) =>
      transport.invoke(AppChannels.GET_WORKSPACE_CONFIG, projectPath),
    saveWorkspaceConfig: (projectPath: string, yamlContent: string) =>
      transport.invoke(AppChannels.SAVE_WORKSPACE_CONFIG, projectPath, yamlContent),
    onWorkspaceChanged: (callback: (projectPath: string) => void) =>
      transport.on<[string]>('app:workspace-changed', (projectPath) => callback(projectPath)),
    /**
     * Manual "check for updates" trigger. Returns the most recent
     * status the main process saw (or `unsupported` in dev). Live
     * progress flows through `onUpdateStatus` below.
     */
    checkForUpdates: () =>
      transport.invoke(AppChannels.CHECK_FOR_UPDATES),
    /**
     * Subscribe to update lifecycle events from the main-process
     * autoUpdater (checking → available → downloading → downloaded |
     * up-to-date | error). The Settings UI uses this to render a
     * status line that reflects what the updater is doing.
     */
    onUpdateStatus: (callback: (status: import('@shared/update-status').UpdateStatus) => void) =>
      transport.on<[import('@shared/update-status').UpdateStatus]>(AppChannels.UPDATE_STATUS, (status) =>
        callback(status)),
    /**
     * Quit the app and relaunch into the downloaded update. Only valid
     * after `onUpdateStatus` reports `{ kind: 'downloaded' }`.
     */
    quitAndInstall: () => {
      transport.send('app:quit-and-install')
    },

    // ─── Workspaces (sidebar grouping above projects) ──────────
    workspaces: {
      list: (): Promise<import('@shared/types').Workspace[]> =>
        transport.invoke(AppChannels.WORKSPACE_LIST),
      create: (input: { name: string; color?: string | null }): Promise<import('@shared/types').Workspace> =>
        transport.invoke(AppChannels.WORKSPACE_CREATE, input),
      rename: (id: string, name: string) =>
        transport.invoke(AppChannels.WORKSPACE_RENAME, id, name),
      recolor: (id: string, color: string | null) =>
        transport.invoke(AppChannels.WORKSPACE_RECOLOR, id, color),
      delete: (id: string) =>
        transport.invoke(AppChannels.WORKSPACE_DELETE, id),
      reorder: (ids: string[]) =>
        transport.invoke(AppChannels.WORKSPACE_REORDER, ids),
    },
    assignProjectWorkspace: (projectPath: string, workspaceId: string | null) =>
      transport.invoke(AppChannels.ASSIGN_PROJECT_WORKSPACE, projectPath, workspaceId),

    /**
     * Spawn a new conversation cloned from the first N messages of an
     * existing one. Returns either `{ ok: true, conversation, resumeHint,
     * messages, resumable }` or `{ ok: false, error }`.
     */
    forkConversation: (args: {
      sourceConversationId: string
      upToIndex: number
      forkedAtMessageId?: string
      /** #5: when true, also `git worktree add` a fresh branch and root the
       *  forked conversation at the new checkout. */
      withWorktree?: boolean
    }): Promise<
      | {
          ok: true
          conversation: {
            id: string
            projectPath: string
            agentType: string
            title: string
            parentConversationId: string
            forkedAtMessageId: string
            createdAt: number
          }
          resumeHint: string | null
          messages: import('@shared/types').ChatMessage[]
          resumable: boolean
          /** Set iff `withWorktree: true` and creation succeeded. */
          worktree?: { path: string; branch: string }
        }
      | { ok: false; error: string }
    > => transport.invoke(AppChannels.FORK_CONVERSATION, args),
  },

  // ─── Files (file-tree pane + viewer + chip resolver) ──────────
  files: {
    listDir: (
      repoRoot: string,
      subPath?: string,
    ): Promise<{ ok: boolean; error?: string; entries: Array<{ name: string; isDir: boolean; isGitignored: boolean }> }> =>
      transport.invoke(FilesChannels.LIST_DIR, repoRoot, subPath ?? ''),
    readFile: (
      repoRoot: string,
      subPath: string,
    ): Promise<{ ok: boolean; error?: string; content: string; truncated: boolean; totalBytes: number; mtimeMs: number }> =>
      transport.invoke(FilesChannels.READ_FILE, repoRoot, subPath),
    resolve: (
      repoRoot: string,
      subPath: string,
    ): Promise<{ ok: boolean; exists: boolean; absPath?: string }> =>
      transport.invoke(FilesChannels.RESOLVE, repoRoot, subPath),
    listAll: (
      repoRoot: string,
    ): Promise<{ ok: boolean; error?: string; files: string[] }> =>
      transport.invoke(FilesChannels.LIST_ALL, repoRoot),
    grepSymbol: (
      repoRoot: string,
      symbol: string,
    ): Promise<{ ok: boolean; hits: Array<{ relPath: string; line: number; ch: number }> }> =>
      transport.invoke(FilesChannels.GREP_SYMBOL, repoRoot, symbol),
    writeFile: (
      repoRoot: string,
      subPath: string,
      content: string,
      expectedMtimeMs?: number,
    ): Promise<
      | { ok: true; mtimeMs: number }
      | { ok: false; error: string; conflict?: boolean }
    > =>
      transport.invoke(
        FilesChannels.WRITE_FILE,
        repoRoot,
        subPath,
        content,
        expectedMtimeMs,
      ),
    deleteFile: (
      repoRoot: string,
      subPath: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      transport.invoke(FilesChannels.DELETE_FILE, repoRoot, subPath),
    readBatch: (
      repoRoot: string,
      subPaths: string[],
    ): Promise<{
      ok: true
      files: Array<{ path: string; content: string; mtimeMs: number; truncated: boolean }>
    }> => transport.invoke(FilesChannels.READ_BATCH, repoRoot, subPaths),
  },

  // ─── Git (per-thread branch picker) ───────────────────────────
  git: {
    listRefs: (
      cwd: string,
    ): Promise<
      | {
          ok: true
          refs: Array<{
            name: string
            sha: string
            current: boolean
            isRemote: boolean
            worktreePath: string | null
          }>
        }
      | { ok: false; error: string }
    > => transport.invoke(GitChannels.LIST_REFS, cwd),
    switchRef: (
      cwd: string,
      refName: string,
    ): Promise<{ ok: true } | { ok: false; error: string }> =>
      transport.invoke(GitChannels.SWITCH_REF, cwd, refName),
    currentBranch: (
      cwd: string,
    ): Promise<{ ok: true; branch: string | null } | { ok: false; error: string }> =>
      transport.invoke(GitChannels.CURRENT_BRANCH, cwd),
    createSessionWorktree: (args: {
      projectPath: string
      branchSlug: string
      baseRef?: string
      /** Routes the call to this machine's backend (default local). */
      machineId?: string
    }): Promise<
      { ok: true; path: string; branch: string } | { ok: false; error: string }
    > => transport.invoke(GitChannels.CREATE_SESSION_WORKTREE, args),
    fileDiff: (
      repoRoot: string,
      subPath: string,
    ): Promise<
      | { ok: true; hunks: Array<{ kind: 'add' | 'mod' | 'del'; startLine: number; endLine: number }> }
      | { ok: false; error: string }
    > => transport.invoke(GitChannels.FILE_DIFF, repoRoot, subPath),
  },

  lsp: {
    open: (args: { workspaceRoot: string; absPath: string; text: string; version: number; languageId: string }) =>
      transport.invoke(LspChannels.OPEN, args),
    change: (args: { workspaceRoot: string; absPath: string; text: string; version: number }) =>
      transport.invoke(LspChannels.CHANGE, args),
    close: (args: { workspaceRoot: string; absPath: string }) =>
      transport.invoke(LspChannels.CLOSE, args),
    definition: (args: {
      workspaceRoot: string
      absPath: string
      position: { line: number; character: number }
    }): Promise<
      | { ok: true; supported: boolean; locations: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> }
      | { ok: false; error: string }
    > => transport.invoke(LspChannels.DEFINITION, args),
    references: (args: {
      workspaceRoot: string
      absPath: string
      position: { line: number; character: number }
    }) => transport.invoke(LspChannels.REFERENCES, args),
    hover: (args: {
      workspaceRoot: string
      absPath: string
      position: { line: number; character: number }
    }) => transport.invoke(LspChannels.HOVER, args),
    documentSymbols: (args: { workspaceRoot: string; absPath: string }) =>
      transport.invoke(LspChannels.DOCUMENT_SYMBOLS, args),
  },

  // ─── Machines (local + remote SSH hosts) ─────────────────────
  machines: {
    list: (): Promise<Machine[]> => transport.invoke(MachineChannels.LIST),
    create: (input: MachineInput): Promise<Machine> => transport.invoke(MachineChannels.CREATE, input),
    update: (id: string, patch: Partial<MachineInput>): Promise<Machine | null> =>
      transport.invoke(MachineChannels.UPDATE, id, patch),
    delete: (id: string): Promise<{ ok: true }> => transport.invoke(MachineChannels.DELETE, id),
    reorder: (ids: string[]): Promise<{ ok: true }> => transport.invoke(MachineChannels.REORDER, ids),
    listSshHosts: (): Promise<SshHost[]> => transport.invoke(MachineChannels.LIST_SSH_HOSTS),
    getSnapshots: (): Promise<Record<string, MachineSnapshot>> => transport.invoke(MachineChannels.GET_SNAPSHOTS),
    saveSnapshot: (id: string, snapshot: MachineSnapshot): Promise<{ ok: true }> =>
      transport.invoke(MachineChannels.SAVE_SNAPSHOT, id, snapshot),
    connect: (id: string): Promise<{ ok: boolean; error?: string }> => transport.invoke(MachineChannels.CONNECT, id),
    disconnect: (id: string): Promise<{ ok: true }> => transport.invoke(MachineChannels.DISCONNECT, id),
    onStatus: (callback: (machineId: string, status: string, url: string | null, reason?: string) => void): (() => void) =>
      transport.on<[string, string, string | null, string | undefined]>(MachineChannels.STATUS, (machineId, status, url, reason) =>
        callback(machineId, status, url ?? null, reason),
      ),
  },

  // ─── Transport routing (per-session local/remote backend dispatch) ──
  // Renderer-local: these mutate the preload router/table directly, no IPC.
  routing: {
    /** Bind a threadId/terminal id to a machine so its calls route there. */
    bind: (resourceId: string, machineId: string): void => routingTable.bind(resourceId, machineId),
    unbind: (resourceId: string): void => routingTable.unbind(resourceId),
    /** Invoke a channel on a specific machine's backend, bypassing the resolver. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    invokeOn: <T = any>(machineId: string, channel: string, ...args: unknown[]): Promise<T> =>
      router.invokeOn<T>(machineId, channel, ...args),
    /** Register a connected remote's WS backend. A reconnect gets a new tunnel
     *  port, so any stale transport is torn down first (not pinned forever). */
    connectMachine: (machineId: string, url: string): void => {
      const existing = remoteTransports.get(machineId)
      if (existing) {
        router.unregister(machineId)
        existing.close()
        remoteTransports.delete(machineId)
      }
      const ws = new WsTransport(url)
      remoteTransports.set(machineId, ws)
      router.register(machineId, ws)
    },
    disconnectMachine: (machineId: string): void => {
      router.unregister(machineId)
      routingTable.forgetMachine(machineId)
      remoteTransports.get(machineId)?.close()
      remoteTransports.delete(machineId)
    },
  },

  // ─── Kanban (per-project task cards + per-card worktrees) ─────
  kanban: {
    list: (projectPath: string): Promise<KanbanCard[]> =>
      transport.invoke(KanbanChannels.LIST, projectPath),
    create: (input: KanbanCardCreate): Promise<KanbanCard> =>
      transport.invoke(KanbanChannels.CREATE, input),
    update: (id: string, patch: KanbanCardUpdate): Promise<KanbanCard | null> =>
      transport.invoke(KanbanChannels.UPDATE, id, patch),
    delete: (id: string, opts?: { removeWorktree?: boolean; force?: boolean }): Promise<void> =>
      transport.invoke(KanbanChannels.DELETE, id, opts),
    createWorktree: (id: string): Promise<KanbanCard | null> =>
      transport.invoke(KanbanChannels.CREATE_WORKTREE, id),
    removeWorktree: (id: string, opts?: { force?: boolean }): Promise<KanbanCard | null> =>
      transport.invoke(KanbanChannels.REMOVE_WORKTREE, id, opts),
    listWorktrees: (projectPath: string): Promise<WorktreeInfo[]> =>
      transport.invoke(KanbanChannels.LIST_WORKTREES, projectPath),
    listStaleWorktrees: (projectPath: string): Promise<WorktreeInfo[]> =>
      transport.invoke(KanbanChannels.LIST_STALE_WORKTREES, projectPath),
    removeStaleWorktree: (
      projectPath: string,
      worktreePath: string,
      opts?: { force?: boolean },
    ): Promise<void> =>
      transport.invoke(KanbanChannels.REMOVE_STALE_WORKTREE, projectPath, worktreePath, opts),
  },

  settings: {
    get: (key: string) => transport.invoke('settings:get', key),
    set: (key: string, value: string) => transport.invoke('settings:set', key, value),
    remove: (key: string) => transport.invoke('settings:remove', key),
  },

  // ─── Provider instances (named credential sets per agent kind) ───
  providerInstances: {
    list: (): Promise<import('@shared/types').ProviderInstance[]> =>
      transport.invoke(ProviderInstanceChannels.LIST),
    upsert: (input: ProviderInstanceUpsertInput): Promise<import('@shared/types').ProviderInstance> =>
      transport.invoke(ProviderInstanceChannels.UPSERT, input),
    delete: (id: string): Promise<boolean> =>
      transport.invoke(ProviderInstanceChannels.DELETE, id),
    test: (id: string): Promise<{ ok: boolean; message: string }> =>
      transport.invoke(ProviderInstanceChannels.TEST, id),
    createOauthDir: (dir: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
      transport.invoke(ProviderInstanceChannels.CREATE_OAUTH_DIR, dir),
  },

  // ─── Provider (new agent bridge) ──────────────────────────────
  // Typed against the shared RuntimeEvent union so the renderer can switch
  // on event.type without casts. Methods mirror the main-process
  // ProviderAdapter interface.
  provider: {
    startSession: async (opts: StartSessionOpts) => {
      // When a Claude session routes to a remote VM, forward the local
      // instance's oauth_dir basename (a path segment like `.claude-akshaya`,
      // not a credential) so the remote mirrors the per-instance config dir
      // under its own $HOME. The VM's DB has no instances, so it can't derive
      // this itself. Local sessions dispatch unchanged.
      const target = routingTable.resolve(ProviderChannels.START_SESSION, [opts])
      if (target !== 'local' && opts.provider === 'claude') {
        try {
          const seg = await router.invokeOn<string | null>(
            'local',
            ProviderInstanceChannels.RESOLVE_OAUTH_DIR,
            'claude-code',
            opts.instanceId,
          )
          if (seg) opts = { ...opts, remoteConfigDir: seg }
        } catch (err) {
          log.warn('resolveOauthDir failed; remote falls back to ~/.claude', err)
        }
      }
      return transport.invoke(ProviderChannels.START_SESSION, opts)
    },

    sendTurn: (threadId: string, message: string, runtimeMode?: RuntimeMode, images?: Array<{ url: string; mimeType?: string }>) =>
      transport.invoke(ProviderChannels.SEND_TURN, threadId, message, runtimeMode, images),

    interrupt: (threadId: string) =>
      transport.invoke(ProviderChannels.INTERRUPT, threadId),

    setRuntimeMode: (threadId: string, mode: RuntimeMode) =>
      transport.invoke(ProviderChannels.SET_RUNTIME_MODE, threadId, mode),

    setModel: (threadId: string, model: string) =>
      transport.invoke(ProviderChannels.SET_MODEL, threadId, model),

    /** Dynamically fetch `opencode models` output. Returns provider/model IDs. */
    listOpencodeModels: (): Promise<string[]> =>
      transport.invoke(ProviderChannels.OPENCODE_LIST_MODELS),

    /**
     * Fetch the agent-defined slash commands/skills for a session
     * (Claude SDK's `init.commands`, Codex's `skills/list`). Returns `[]`
     * for providers without a skill registry (OpenCode) or before the
     * session has fully initialized.
     */
    listSkills: (threadId: string): Promise<import('@shared/types').ProviderSkill[]> =>
      transport.invoke(ProviderChannels.LIST_SKILLS, threadId),

    answerQuestion: (threadId: string, requestId: string, answers: string[][]) =>
      transport.invoke(ProviderChannels.ANSWER_QUESTION, threadId, requestId, answers),

    respondToRequest: (threadId: string, requestId: string, decision: ApprovalDecision) =>
      transport.invoke(ProviderChannels.RESPOND_TO_REQUEST, threadId, requestId, decision),

    stopSession: (threadId: string) =>
      transport.invoke(ProviderChannels.STOP_SESSION, threadId),

    isAvailable: (provider: 'claude' | 'codex') =>
      transport.invoke(ProviderChannels.IS_AVAILABLE, provider),

    // Stamp the emitting transport's machineId so two machines emitting the
    // same threadId don't merge into one chat downstream.
    onEvent: (callback: (event: RuntimeEvent) => void): (() => void) =>
      router.onWithSource<[RuntimeEvent]>(ProviderChannels.EVENT, (machineId, event) => {
        event.machineId = machineId
        callback(event)
      }),
  },

  // ─── Embedded IDE (code-server webview) ────────────────────────
  ide: {
    /** Boot the per-app server (first call may download the binary) and serve `folder`. */
    ensure: (folder: string): Promise<{ ok: true; port: number } | { ok: false; error: string }> =>
      transport.invoke(IdeChannels.ENSURE, folder),
    /** Route an open-at-line to the workbench serving `folder`. */
    open: (args: { folder: string; path: string; line?: number; endLine?: number }): Promise<{ ok: boolean }> =>
      transport.invoke(IdeChannels.OPEN, args),
    /** Idle shutdown - kill the server, renderer blanks the webview. */
    stop: (): Promise<{ ok: boolean }> => transport.invoke(IdeChannels.STOP),
    onStatus: (
      callback: (payload: { status: 'stopped' | 'starting' | 'downloading' | 'ready' | 'error'; port?: number }) => void,
    ): (() => void) =>
      transport.on<[{ status: 'stopped' | 'starting' | 'downloading' | 'ready' | 'error'; port?: number }]>(
        IdeChannels.STATUS,
        (payload) => callback(payload),
      ),
    onSelection: (
      callback: (msg: { path: string; startLine: number; endLine: number; text: string }) => void,
    ): (() => void) =>
      transport.on<[{ path: string; startLine: number; endLine: number; text: string }]>(
        IdeChannels.SELECTION,
        (msg) => callback(msg),
      ),
  },

  // ─── Bookmarks ─────────────────────────────────────────────────
  bookmarks: {
    save: (params: {
      id: string; sessionId: string; projectPath: string; sessionTitle: string
      agentType: string; messageRole: string; contentExcerpt: string; messageTimestamp: number
    }) => transport.invoke(BookmarkChannels.SAVE, params),
    remove: (id: string) => transport.invoke(BookmarkChannels.REMOVE, id),
    list: (): Promise<import('@shared/types').Bookmark[]> => transport.invoke(BookmarkChannels.LIST),
  },

  // Menu events from main process
  onOpenSettings: (callback: () => void) =>
    transport.on('app:open-settings', () => callback()),

  getLogPaths: () => transport.invoke('app:get-log-paths'),

  onClosePaneOrWindow: (callback: (opts: { shift?: boolean }) => void) =>
    transport.on<[{ shift?: boolean }]>('app:close-pane-or-window', (opts) => callback(opts ?? {})),

  /** Fired when the window enters/leaves macOS fullscreen while in translucent mode. */
  onFullscreenChanged: (callback: (isFullscreen: boolean) => void) =>
    transport.on<[boolean]>('app:fullscreen-changed', (isFullscreen) => callback(isFullscreen)),

  closeWindow: () => {
    transport.send('app:close-window')
  },
}

contextBridge.exposeInMainWorld('api', api)

export type SwitchboardAPI = typeof api
