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
} as const

export const FilesChannels = {
  LIST_DIR: 'files:list-dir',
  READ_FILE: 'files:read-file',
  RESOLVE: 'files:resolve',
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
