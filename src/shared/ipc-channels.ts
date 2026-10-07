/**
 * Type-safe IPC channel definitions.
 * Both main and renderer import from here - single source of truth.
 */

export const TerminalChannels = {
  CREATE: 'terminal:create',
  DATA: 'terminal:data',
  RESIZE: 'terminal:resize',
  KILL: 'terminal:kill',
  OUTPUT: 'terminal:output',
  EXIT: 'terminal:exit',
} as const

export const AppChannels = {
  OPEN_FOLDER: 'app:open-folder',
  SCAN_SESSIONS: 'app:scan-sessions',
  IMPORT_SESSION: 'app:import-session',
  GET_PROJECTS: 'app:get-projects',
  CREATE_CONVERSATION: 'app:create-conversation',
  LOAD_SESSION: 'app:load-session',
  SAVE_MESSAGE: 'app:save-message',
  SET_FILE_DIFF_STATUS: 'app:set-file-diff-status',
  RENAME_CONVERSATION: 'app:rename-conversation',
  GET_CONVERSATIONS: 'app:get-conversations',
  SET_VIBRANCY: 'app:set-vibrancy',
  SAVE_SESSION_LAYOUT: 'app:save-session-layout',
  GET_SESSION_LAYOUT: 'app:get-session-layout',
  GET_LAUNCH_CONFIG: 'app:get-launch-config',
  SAVE_LAUNCH_CONFIG: 'app:save-launch-config',
  SEARCH_MESSAGES: 'app:search-messages',
  ARCHIVE_CONVERSATION: 'app:archive-conversation',
  UNARCHIVE_CONVERSATION: 'app:unarchive-conversation',
  GET_ARCHIVED_CONVERSATIONS: 'app:get-archived-conversations',
  EXPORT_MARKDOWN: 'app:export-markdown',
  LOAD_SESSION_BY_ID: 'app:load-session-by-id',
  LOAD_HISTORY_IMAGE: 'app:load-history-image',
  ATTACH_TO_THREAD: 'app:attach-to-thread',
  GET_CONVERSATION_RUNTIME_MODE: 'app:get-conversation-runtime-mode',
  SET_CONVERSATION_RUNTIME_MODE: 'app:set-conversation-runtime-mode',
  /** Per-conversation Follow-chip setting (`FollowSuggestionMode`). */
  SET_CONVERSATION_FOLLOW_SUGGESTIONS: 'app:set-conversation-follow-suggestions',
  /** Read by the branch picker, which offers "Turn back on" while the chip is off. */
  GET_CONVERSATION_FOLLOW_SUGGESTIONS: 'app:get-conversation-follow-suggestions',
  DISMISS_CONVERSATION_FOLLOW_NOTICE: 'app:dismiss-conversation-follow-notice',
  GET_CONVERSATION_PROVIDER_INSTANCE_ID: 'app:get-conversation-provider-instance-id',
  SET_CONVERSATION_PROVIDER_INSTANCE_ID: 'app:set-conversation-provider-instance-id',
  GET_CONVERSATION_MODEL: 'app:get-conversation-model',
  SET_CONVERSATION_MODEL: 'app:set-conversation-model',
  SET_CONVERSATION_REASONING_EFFORT: 'app:set-conversation-reasoning-effort',
  SET_CONVERSATION_PROVIDER_SELECTION: 'app:set-conversation-provider-selection',
  GET_CONVERSATION_PENDING_HANDOFF: 'app:get-conversation-pending-handoff',
  SET_CONVERSATION_PENDING_HANDOFF: 'app:set-conversation-pending-handoff',
  CHECK_FOR_UPDATES: 'app:check-for-updates',
  GET_UPDATE_STATUS: 'app:get-update-status',
  RELAUNCH: 'app:relaunch',
  /** Settings > About > Diagnostics: one JSON snapshot of the host (see shared/diagnostics-report.ts). */
  GET_DIAGNOSTICS: 'app:get-diagnostics',
  /** Reveal the main-process log directory in Finder / Explorer. */
  OPEN_LOGS_FOLDER: 'app:open-logs-folder',
  /** main → renderer push: status changes from electron-updater. */
  UPDATE_STATUS: 'app:update-status',
  // Workspaces (sidebar outer grouping above projects)
  WORKSPACE_LIST: 'app:workspace-list',
  WORKSPACE_CREATE: 'app:workspace-create',
  WORKSPACE_RENAME: 'app:workspace-rename',
  WORKSPACE_RECOLOR: 'app:workspace-recolor',
  WORKSPACE_DELETE: 'app:workspace-delete',
  WORKSPACE_REORDER: 'app:workspace-reorder',
  PROJECT_ORGANIZE: 'app:project-organize',
  FORK_CONVERSATION: 'app:fork-conversation',
  GET_CONVERSATION_FORK: 'app:get-conversation-fork',
  /** backend → renderer push: any client created or renamed a conversation. */
  CONVERSATIONS_CHANGED: 'app:conversations-changed',
  // Editor tabs persistence - open files survive app restart per session.
  /**
   * Update the worktree pointer on an existing conversation. Fired from
   * the branch picker's swap-cwd action when the user picks a branch
   * that already has a worktree on disk.
   */
  SET_CONVERSATION_WORKTREE: 'app:set-conversation-worktree',
  /** Add a project from an absolute directory path (remote add-project flow). */
  ADD_PROJECT_PATH: 'app:add-project-path',
  /** Remove a project from the sidebar (cascades its conversations + kanban cards). */
  REMOVE_PROJECT: 'app:remove-project',
  /** Rename a project's display name (path/PK unchanged). */
  RENAME_PROJECT: 'app:rename-project',
  /** (Re)start the mobile pairing endpoint from saved settings; returns status. */
  MOBILE_PAIRING_APPLY: 'mobile-pairing:apply',
  /** Current mobile pairing endpoint status without changing anything. */
  /** Mint a one-time pairing code for the QR. Replaces any unused one. */
  MOBILE_PAIRING_CODE: 'mobile-pairing:code',
  /** Paired devices, with the credential itself omitted. */
  MOBILE_DEVICES: 'mobile-pairing:devices',
  /** Revoke one device without disturbing the others. */
  MOBILE_DEVICE_REVOKE: 'mobile-pairing:revoke',
  /**
   * Run Google consent in a browser and return the credential blob for the
   * phone's QR. Desktop-only: the phone cannot complete this flow, which is the
   * whole reason the desktop mints on its behalf.
   */
  GOOGLE_MINT: 'mobile-pairing:google-mint',
  /** Whether an OAuth client is configured, and where it came from. */
  GOOGLE_CLIENT_STATUS: 'mobile-pairing:google-client-status',
  /** Save an OAuth client id/secret for minting. */
  GOOGLE_CLIENT_SET: 'mobile-pairing:google-client-set',
  /** Key/value settings table shared by the desktop and the phone. */
  SETTINGS_GET: 'settings:get',
  /**
   * Writes are gated per KEY as well as per channel: two of these rows decide
   * what a session may DO, so `isSettingWriteAllowed` refuses them to a
   * chat-scoped device even though the channel itself is open.
   */
  SETTINGS_SET: 'settings:set',
  /**
   * Per-project overrides of the settings in `SCOPABLE_SETTINGS`. The backend
   * owns the path normalisation, so every client lands on the same rows.
   * `settings:get` takes an optional project path as its second argument and
   * then answers with the effective value (override, else global).
   */
  SETTINGS_PROJECT_OVERRIDES: 'settings:project-overrides',
  SETTINGS_PROJECT_OVERRIDE_SET: 'settings:project-override-set',
  SETTINGS_PROJECT_OVERRIDE_REMOVE: 'settings:project-override-remove',
  /** External IPv4 addresses of this machine - mobile pairing QR host picker. */
  LAN_ADDRESSES: 'app:lan-addresses',
  /**
   * Record that a thread was read, and broadcast `thread.read` so every other
   * client drops its badge. Read state is the backend's, not each client's.
   */
  MARK_READ: 'app:mark-read',
} as const

/**
 * `settings.json` beside the settings DB (`shared/settings-file.ts`). Desktop
 * only: served on ipcMain, never to a phone or over a remote backend, since
 * the file is on the machine the window runs on.
 */
export const SettingsFileChannels = {
  /** Write the file and its schema from the DB, start watching, and answer the path. */
  OPEN: 'settings-file:open',
  /** Open the file in the system editor, when the embedded IDE cannot. */
  OPEN_EXTERNAL: 'settings-file:open-external',
  STATUS: 'settings-file:status',
  /** Push: the status changed (a save applied, refused, or a write skipped). */
  STATUS_CHANGED: 'settings-file:status-changed',
  /** Push: a save changed these settings keys, for the window to re-read. */
  APPLIED: 'settings-file:applied',
} as const

export const MachineChannels = {
  LIST: 'machines:list',
  CREATE: 'machines:create',
  UPDATE: 'machines:update',
  DELETE: 'machines:delete',
  REORDER: 'machines:reorder',
  /** Parse ~/.ssh/config into host candidates for the "Add machine" picker. */
  LIST_SSH_HOSTS: 'machines:list-ssh-hosts',
  /**
   * IAP tunnel targets discovered from ~/.ssh/config ProxyCommand lines, so a
   * paired phone can offer VMs instead of asking for project/zone/instance by
   * hand. Served by whichever backend holds the ssh config.
   */
  LIST_IAP_TARGETS: 'machines:list-iap-targets',
  /** Cached per-remote tree snapshots for offline read-only browse. */
  GET_SNAPSHOTS: 'machines:get-snapshots',
  /** Persist a freshly-scanned remote tree snapshot. */
  SAVE_SNAPSHOT: 'machines:save-snapshot',
  /** Open an ssh tunnel to a remote and boot its backend. */
  CONNECT: 'machines:connect',
  /** Tear down a remote's tunnel. */
  DISCONNECT: 'machines:disconnect',
  /** Main -> renderer: per-machine connection status changed, optionally with a human-readable reason. */
  STATUS: 'machines:status',
  /** Current status + tunnel URL for every machine, so a reloaded renderer can re-dial live connections. */
  GET_STATUSES: 'machines:get-statuses',
} as const

export const KanbanChannels = {
  LIST: 'kanban:list',
  CREATE: 'kanban:create',
  UPDATE: 'kanban:update',
  DELETE: 'kanban:delete',
  CREATE_WORKTREE: 'kanban:create-worktree',
  REMOVE_WORKTREE: 'kanban:remove-worktree',
} as const

/**
 * Settings > Archive & data > Worktrees, and the kanban board's worktree
 * dialog. Rules in `shared/worktree-manager.ts`; the backend re-checks every
 * removal against fresh git state.
 */
export const WorktreeManagerChannels = {
  /** (projectPaths?: string[]) -> WorktreeInventory. Every project when omitted. */
  INVENTORY: 'worktree-manager:inventory',
  /** (path, { refresh? }) -> { bytes: number | null }. Cached; computed in a child process. */
  SIZE: 'worktree-manager:size',
  /** ({ projectPath, worktreePath, acknowledged }) -> { ok: true } | { ok: false, error }. */
  REMOVE: 'worktree-manager:remove',
  GET_PROTECTION: 'worktree-manager:get-protection',
  /** (WorktreeProtectionPatch) -> WorktreeProtection. */
  SET_PROTECTION: 'worktree-manager:set-protection',
} as const

export const FilesChannels = {
  /** Lean directory listing (name/isDir) - remote add-project path autocomplete. */
  LIST_DIR: 'files:list-dir',
  WRITE_FILE: 'files:write-file',
  DELETE_FILE: 'files:delete-file',
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
  /**
   * Push-based branch-chip updates: WATCH_HEAD starts a refcounted
   * fs-watcher on the repo's git dir; HEAD_CHANGED is emitted with the
   * watched cwd whenever HEAD moves (checkout - including ones made in a
   * terminal pane). UNWATCH_HEAD releases the reference.
   */
  WATCH_HEAD: 'git:watch-head',
  UNWATCH_HEAD: 'git:unwatch-head',
  HEAD_CHANGED: 'git:head-changed',
  /**
   * Create a deterministic-path worktree under userData/worktrees for a
   * new chat session and return its absolute path + the branch we
   * created. Caller stamps the result onto the session's `worktreePath`
   * so START_SESSION uses it as cwd.
   */
} as const

export const WorktreeCreationChannels = {
  CREATE: 'worktree-creation:create',
  GET: 'worktree-creation:get',
  ACT: 'worktree-creation:act',
  PROGRESS: 'worktree-creation:progress',
} as const

/**
 * Embedded IDE (code-server in a webview). ENSURE boots the per-app server
 * (first call pays the one-time binary download) and serves `folder`; STATUS
 * pushes lifecycle updates; OPEN routes open-at-line to the extension host
 * serving the folder; SELECTION carries cmd+l captures from the workbench;
 * STOP is the idle shutdown (hidden pane reclaims the server's RAM).
 */
/**
 * Mobile push. The backend sends, because the phone is asleep when it matters.
 * VIEWING tells the backend which thread a device has open, so it is not
 * notified about the screen already in the user's hand.
 */
/**
 * Reviews: pull request data read from GitHub (gh CLI) and Bitbucket Cloud
 * where the backend runs. Read-only. A paired phone may call these.
 */
export const PullRequestChannels = {
  LIST: 'pull-requests:list',
  DETAIL: 'pull-requests:detail',
  FILES: 'pull-requests:files',
  CONVERSATIONS: 'pull-requests:conversations',
  CHECKS: 'pull-requests:checks',
  /** Chat ↔ PR links (`shared/pull-request-links.ts`). Open to a paired phone like the reads: a link only points Reviews at a chat. */
  LINKS: 'pull-requests:links',
  LINKED_CHATS: 'pull-requests:linked-chats',
  LINKABLE_CHATS: 'pull-requests:linkable-chats',
  LINK: 'pull-requests:link',
  UNLINK: 'pull-requests:unlink',
  HISTORY_SCAN: 'pull-requests:history-scan',
  /** Event: `{ conversationId }`, the root id whose links changed. */
  LINKS_CHANGED: 'pull-requests:links-changed',
  /** `(ref)` -> `PrResult<PrReviewerCandidate[]>`: who the Reviewers card offers to add. */
  REVIEWER_CANDIDATES: 'pull-requests:reviewer-candidates',
  /** `(ref)` -> `{ ok }`. Local only (the backend's database), nothing reaches the host, so a phone may call them. */
  HIDE: 'pull-requests:hide',
  UNHIDE: 'pull-requests:unhide',
  /** `(repos: RepoRef[])` -> `{ ok }`. Local like HIDE; a hidden repository is not read at all (`shared/pull-request-hidden-repos.ts`). */
  HIDE_REPOS: 'pull-requests:hide-repos',
  UNHIDE_REPOS: 'pull-requests:unhide-repos',
} as const

/**
 * The human write actions on a pull request, one channel per action, each
 * `(ref, input)` -> `PrResult<PrWriteDone>` (`shared/pull-request-writes.ts`).
 * Admin-scoped in `shared/device-auth.ts`: a paired phone calls none of them.
 */
export const PullRequestWriteChannels = {
  REPLY: 'pull-requests:reply',
  RESOLVE: 'pull-requests:resolve',
  UNRESOLVE: 'pull-requests:unresolve',
  COMMENT: 'pull-requests:comment',
  INLINE_COMMENT: 'pull-requests:inline-comment',
  SUBMIT_REVIEW: 'pull-requests:submit-review',
  MERGE: 'pull-requests:merge',
  RERUN_CHECK: 'pull-requests:rerun-check',
  ADD_REVIEWER: 'pull-requests:add-reviewer',
  REMOVE_REVIEWER: 'pull-requests:remove-reviewer',
  /** `(ref)`: Bitbucket decline, GitHub close. */
  DECLINE: 'pull-requests:decline',
} as const

/**
 * Source control accounts for Reviews. Admin-scoped as a prefix in
 * `shared/device-auth.ts`: a phone can neither read nor set them.
 */
export const SourceControlChannels = {
  STATUS: 'source-control:status',
  SET_BITBUCKET: 'source-control:set-bitbucket',
  REMOVE_BITBUCKET: 'source-control:remove-bitbucket',
  TEST: 'source-control:test',
} as const

export const PushChannels = {
  REGISTER: 'push:register',
  UNREGISTER: 'push:unregister',
  VIEWING: 'push:viewing',
} as const

export const IdeChannels = {
  ENSURE: 'ide:ensure',
  /** Write workbench.colorTheme into code-server's settings.json - applied live by its file watcher. */
  SET_THEME: 'ide:set-theme',
  STATUS: 'ide:status',
  OPEN: 'ide:open',
  SELECTION: 'ide:selection',
  /** Workbench terminal intercepted (ctrl+` / cmd+j) - renderer opens Switchboard's terminal pane. */
  TERMINAL_REQUEST: 'ide:terminal-request',
  DS_MODE_REQUEST: 'ide:ds-mode-request',
  STOP: 'ide:stop',
} as const

/**
 * Backend speech-to-text (whisper.cpp server). TRANSCRIBE accepts a base64
 * audio payload and returns the corrected transcript; STATUS pushes whisper
 * lifecycle updates (stopped | downloading | starting | ready | error).
 * Served by both hosts so a paired phone reaches it over WS/TCP too.
 */
export const SttChannels = {
  TRANSCRIBE: 'stt:transcribe',
  STATUS: 'stt:status',
} as const

export const BookmarkChannels = {
  SAVE: 'bookmark:save',
  REMOVE: 'bookmark:remove',
  LIST: 'bookmark:list',
} as const

export const ProviderInstanceChannels = {
  LIST: 'provider-instances:list',
  UPSERT: 'provider-instances:upsert',
  DELETE: 'provider-instances:delete',
  /** Probe the credentials with a no-op call (claude auth status, codex
   *  login status, opencode models). Returns `{ ok, message }`. */
  TEST: 'provider-instances:test',
  /** Read this instance's subscription usage limits. Returns ProviderUsage;
   *  never throws, reports failures via its `status` field. */
  USAGE: 'provider-instances:usage',
  CREATE_OAUTH_DIR: 'provider-instances:create-oauth-dir',
  /** Local-only: resolve an instance's oauth_dir absolute path (not a secret,
   *  just a path). Used to forward the dir NAME to a remote at session start. */
  RESOLVE_OAUTH_DIR: 'provider-instances:resolve-oauth-dir',
} as const

export const ProviderChannels = {
  START_SESSION: 'provider:start-session',
  SEND_TURN: 'provider:send-turn',
  SUBMIT_USER_TURN: 'provider:submit-user-turn',
  RESOLVE_USER_TURN: 'provider:resolve-user-turn',
  INTERRUPT: 'provider:interrupt',
  RESPOND_TO_REQUEST: 'provider:respond-to-request',
  STOP_SESSION: 'provider:stop-session',
  SWITCH_INSTANCE: 'provider:switch-instance',
  /** Move the conversation's execution root. Backend-owned transaction. */
  RELOCATE_EXECUTION_ROOT: 'provider:relocate-execution-root',
  SET_RUNTIME_MODE: 'provider:set-runtime-mode',
  SET_MODEL: 'provider:set-model',
  SET_REASONING_EFFORT: 'provider:set-reasoning-effort',
  LIST_MODELS: 'provider:list-models',
  /** Live catalog of an instance without a chat; `threadId` only routes it to a machine. */
  LIST_CATALOG: 'provider:list-catalog',
  /**
   * Sessions running on this backend right now, whichever client started them.
   * A client that was not connected when a session started has no other way to
   * learn it exists: runtime events are broadcast but not replayed from before
   * the session began.
   */
  LIST_SESSIONS: 'provider:list-sessions',
  /**
   * A thread's still-open approval/question/plan cards, from the registry's
   * own bookkeeping rather than a live event. A resume gap or a reload drops
   * the event that opened one of these for good, so a client asks this after
   * such a gap, a reconnect, or opening a thread, and appends whatever it is
   * missing. Gated behind the `pending_requests_v1` backend capability.
   */
  GET_PENDING_REQUESTS: 'provider:get-pending-requests',
  /**
   * Messages the backend holds until the running turn ends (`QueuedTurnSummary[]`),
   * for a client that opens a thread or re-seeds after a resume gap. Promote
   * sends one into the running turn now; cancel takes it back. All three are
   * gated behind the `turn_queue_controls_v1` backend capability.
   */
  LIST_QUEUED_TURNS: 'provider:list-queued-turns',
  PROMOTE_QUEUED_TURN: 'provider:promote-queued-turn',
  CANCEL_QUEUED_TURN: 'provider:cancel-queued-turn',
  /** Start a queue held after a failed or usage-limited turn (`turn.queue-held`). */
  RESUME_QUEUED_TURNS: 'provider:resume-queued-turns',
  LIST_SKILLS: 'provider:list-skills',
  ANSWER_QUESTION: 'provider:answer-question',
  /**
   * Hand a message from one live session to another on the same backend.
   * User-directed only (the `/send-to` composer command); no agent-callable
   * tool reaches this. Payload is a `PeerMessageInput`.
   */
  DELIVER_PEER_MESSAGE: 'provider:deliver-peer-message',
  /**
   * Session links (`shared/peer-links.ts`). User-directed only, like
   * DELIVER_PEER_MESSAGE: no agent tool reaches these. LINK takes
   * `{ threadId, peerThreadId, messages? }`, UNLINK `{ threadId, peerThreadId? }`
   * (no peer = unlink all), LIST `{ threadId }`; each answers `PeerLinkView[]`.
   * LINK and EXTEND are admin-scoped (`device-auth.ts`): a phone may unlink only.
   */
  LINK_PEER: 'provider:link-peer',
  /** `{ threadId, peerThreadId }`: Extend, more messages and a fresh window. */
  EXTEND_PEER_LINK: 'provider:extend-peer-link',
  UNLINK_PEER: 'provider:unlink-peer',
  LIST_PEER_LINKS: 'provider:list-peer-links',
  /** Broadcast `{ threadIds }` (root ids) whose links or link budgets changed. */
  PEER_LINKS_CHANGED: 'provider:peer-links-changed',
  EVENT: 'provider:event',
  IS_AVAILABLE: 'provider:is-available',
  /** Proactive remote-auth preflight - args[0] is a threadId purely so the
   *  preload RoutingTable routes the call to the session's machine. */
  CHECK_REMOTE_AUTH: 'provider:check-remote-auth',
} as const

/**
 * Anonymous usage counts (main/analytics.ts). The renderer may only report
 * the event names in `RENDERER_ANALYTICS_EVENTS`; everything else is
 * tracked by the main process itself.
 */
export const AnalyticsChannels = {
  TRACK: 'analytics:track',
} as const
