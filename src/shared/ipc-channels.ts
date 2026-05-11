/**
 * Type-safe IPC channel definitions.
 * Both main and renderer import from here — single source of truth.
 */

export const TerminalChannels = {
  CREATE: 'terminal:create',
  DATA: 'terminal:data',
  RESIZE: 'terminal:resize',
  KILL: 'terminal:kill',
  CREATED: 'terminal:created',
  OUTPUT: 'terminal:output',
  EXIT: 'terminal:exit',
} as const

export const AppChannels = {
  OPEN_FOLDER: 'app:open-folder',
  SCAN_SESSIONS: 'app:scan-sessions',
  GET_PROJECTS: 'app:get-projects',
  CREATE_CONVERSATION: 'app:create-conversation',
  LOAD_SESSION: 'app:load-session',
  SAVE_MESSAGE: 'app:save-message',
  RENAME_CONVERSATION: 'app:rename-conversation',
  GET_CONVERSATIONS: 'app:get-conversations',
  SET_VIBRANCY: 'app:set-vibrancy',
  SAVE_SESSION_LAYOUT: 'app:save-session-layout',
  GET_SESSION_LAYOUT: 'app:get-session-layout',
  GET_WORKSPACE_CONFIG: 'app:get-workspace-config',
  SAVE_WORKSPACE_CONFIG: 'app:save-workspace-config',
  SEARCH_MESSAGES: 'app:search-messages',
  ARCHIVE_CONVERSATION: 'app:archive-conversation',
  UNARCHIVE_CONVERSATION: 'app:unarchive-conversation',
  GET_ARCHIVED_CONVERSATIONS: 'app:get-archived-conversations',
  EXPORT_MARKDOWN: 'app:export-markdown',
  LOAD_SESSION_BY_ID: 'app:load-session-by-id',
  ATTACH_TO_THREAD: 'app:attach-to-thread',
  DETACH_SESSION: 'app:detach-session',
  LIST_ANCESTRY: 'app:list-ancestry',
  GET_CONVERSATION_RUNTIME_MODE: 'app:get-conversation-runtime-mode',
  SET_CONVERSATION_RUNTIME_MODE: 'app:set-conversation-runtime-mode',
  GET_CONVERSATION_PROVIDER_INSTANCE_ID: 'app:get-conversation-provider-instance-id',
  SET_CONVERSATION_PROVIDER_INSTANCE_ID: 'app:set-conversation-provider-instance-id',
  CHECK_FOR_UPDATES: 'app:check-for-updates',
  RELAUNCH: 'app:relaunch',
  /** main → renderer push: status changes from electron-updater. */
  UPDATE_STATUS: 'app:update-status',
  // Workspaces (sidebar outer grouping above projects)
  WORKSPACE_LIST: 'app:workspace-list',
  WORKSPACE_CREATE: 'app:workspace-create',
  WORKSPACE_RENAME: 'app:workspace-rename',
  WORKSPACE_RECOLOR: 'app:workspace-recolor',
  WORKSPACE_DELETE: 'app:workspace-delete',
  WORKSPACE_REORDER: 'app:workspace-reorder',
  ASSIGN_PROJECT_WORKSPACE: 'app:assign-project-workspace',
  FORK_CONVERSATION: 'app:fork-conversation',
  /**
   * Update the worktree pointer on an existing conversation. Fired from
   * the branch picker's swap-cwd action when the user picks a branch
   * that already has a worktree on disk.
   */
  SET_CONVERSATION_WORKTREE: 'app:set-conversation-worktree',
} as const

export const KanbanChannels = {
  LIST: 'kanban:list',
  CREATE: 'kanban:create',
  UPDATE: 'kanban:update',
  DELETE: 'kanban:delete',
  CREATE_WORKTREE: 'kanban:create-worktree',
  REMOVE_WORKTREE: 'kanban:remove-worktree',
  LIST_WORKTREES: 'kanban:list-worktrees',
  LIST_STALE_WORKTREES: 'kanban:list-stale-worktrees',
  /**
   * Remove a worktree by absolute path (not card id). Used by the stale
   * cleanup flow where the worktree may not be linked to any card. Caller
   * passes the project root so we know which repo to operate on.
   */
  REMOVE_STALE_WORKTREE: 'kanban:remove-stale-worktree',
} as const

export const FilesChannels = {
  LIST_DIR: 'files:list-dir',
  READ_FILE: 'files:read-file',
  WRITE_FILE: 'files:write-file',
  READ_BATCH: 'files:read-batch',
  RESOLVE: 'files:resolve',
  LIST_ALL: 'files:list-all',
} as const

/**
 * Per-thread branch picker. `LIST_REFS` returns local + remote branches
 * annotated with which one is `current` and the absolute path of the
 * worktree (if any) each branch is checked out in. `SWITCH_REF` runs
 * `git checkout` after server-side ref-name validation.
 */
export const GitChannels = {
  LIST_REFS: 'git:list-refs',
  SWITCH_REF: 'git:switch-ref',
  CURRENT_BRANCH: 'git:current-branch',
  /** Editor gutter — hunks for a single file, computed against HEAD. */
  FILE_DIFF: 'git:file-diff',
  /**
   * Create a deterministic-path worktree under userData/worktrees for a
   * new chat session and return its absolute path + the branch we
   * created. Caller stamps the result onto the session's `worktreePath`
   * so START_SESSION uses it as cwd.
   */
  CREATE_SESSION_WORKTREE: 'git:create-session-worktree',
} as const

/**
 * LSP bridge — main-process spawns typescript-language-server / pyright
 * per workspace; renderer sends document lifecycle + queries via these
 * channels and gets typed results / diagnostics back.
 */
export const LspChannels = {
  OPEN: 'lsp:open',
  CHANGE: 'lsp:change',
  CLOSE: 'lsp:close',
  DEFINITION: 'lsp:definition',
  REFERENCES: 'lsp:references',
  HOVER: 'lsp:hover',
  DOCUMENT_SYMBOLS: 'lsp:document-symbols',
} as const

export const AgentChannels = {
  START: 'agent:start',
  SEND: 'agent:send',
  KILL: 'agent:kill',
  MESSAGE: 'agent:message',
  MESSAGE_UPDATE: 'agent:message-update',
  STATUS: 'agent:status',
  ERROR: 'agent:error',
} as const

export const ProviderInstanceChannels = {
  LIST: 'provider-instances:list',
  UPSERT: 'provider-instances:upsert',
  DELETE: 'provider-instances:delete',
  /** Probe the credentials with a no-op call (claude --version, codex
   *  login check, opencode models). Returns `{ ok, message }`. */
  TEST: 'provider-instances:test',
  CREATE_OAUTH_DIR: 'provider-instances:create-oauth-dir',
} as const

export const ProviderChannels = {
  START_SESSION: 'provider:start-session',
  SEND_TURN: 'provider:send-turn',
  INTERRUPT: 'provider:interrupt',
  RESPOND_TO_REQUEST: 'provider:respond-to-request',
  STOP_SESSION: 'provider:stop-session',
  SET_RUNTIME_MODE: 'provider:set-runtime-mode',
  SET_MODEL: 'provider:set-model',
  OPENCODE_LIST_MODELS: 'provider:opencode-list-models',
  LIST_SKILLS: 'provider:list-skills',
  ANSWER_QUESTION: 'provider:answer-question',
  EVENT: 'provider:event',
  IS_AVAILABLE: 'provider:is-available',
} as const
