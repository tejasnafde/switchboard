# Switchboard

Electron workspace that multiplexes terminals, agent chats (Claude Code + Codex + OpenCode), a kanban board, and an embedded VS Code IDE into one surface per project.

## Stack

- **Shell**: Electron 33 + React 19 + TypeScript 5.7
- **Build**: electron-vite + Vite 6
- **Terminal**: `@xterm/xterm` 6 + `node-pty` (native, rebuild after install)
- **IDE**: embedded VS Code workbench via code-server (Coder, MIT) in a single reused `<webview>`; binary downloaded on demand to userData, never bundled
- **Chat input**: Lexical (`@lexical/react`) rich textarea with inline pill chips + `@`-mention file autocomplete
- **Agents** (3, all behind the `ProviderAdapter` interface):
  - Claude Code via `@anthropic-ai/claude-agent-sdk` (streaming-input mode, AsyncIterable prompt queue, `canUseTool` callback)
  - Codex via `codex app-server` over stdio JSON-RPC 2.0
  - OpenCode via `opencode acp` over the Agent Client Protocol (`@agentclientprotocol/sdk`), long-lived stdio child
- **State**: Zustand - `agent-store`, `terminal-store`, `layout-store`, `theme-store`, `draft-store`, `kanban-store`, `provider-instance-store`, `skill-store`, `bookmark-store`
- **DB**: `better-sqlite3` at `~/Library/Application Support/switchboard/data/switchboard.db` (FTS5 enabled; path = `app.getPath('userData')/data/switchboard.db`)
- **Logger**: file-based in `~/Library/Application Support/switchboard/logs/` with 7-day retention

## Commands

- `npm run dev` - launches Electron (auto-unsets `ELECTRON_RUN_AS_NODE`)
- `npm test` - vitest (~1105 tests across 127 files)
- `npm run test:watch` - vitest in watch mode
- `npm run typecheck` - main + renderer tsc
- `npm run build` - **gated build**: `prebuild` runs typecheck + test before the actual build fires; `postbuild` runs `scripts/smoke-test.mjs`
- `npm run build:fast` - escape hatch, skips the gate
- `npm run rebuild` - rebuild `node-pty` + `better-sqlite3` for Electron

## Build gate (2026-04-20)

`npm run build` fails the entire build if typecheck or tests fail. The `prebuild` npm lifecycle hook chains `typecheck && test` before `electron-vite build`. This caught real regressions on the first run - see CHANGELOG.md.

## Known gotchas

- `ELECTRON_RUN_AS_NODE=1` is set by Claude Code's shell - `dev` script unsets it explicitly
- `electron` MUST be in `devDependencies`, not `dependencies`
- After `npm install`, run `npm run rebuild` for `node-pty` + `better-sqlite3`
- Claude Code encodes project paths by replacing BOTH `/` and `_` with `-` in `~/.claude/projects/`
- Scanner uses **exact dir match** (not substring) - parent paths don't pick up child-project sessions (pre-2026-04-20 bug)
- `canUseTool` overrides the SDK's `permissionMode: 'plan'` - we enforce plan mode explicitly via `decidePermission`
- **macOS TCC for project paths under `~/Desktop`/`~/Documents`/`~/Downloads`**: PTYs and the embedded SDK inherit Switchboard.app's TCC grants. If the user toggles "Files and Folders" on after launching, the running process is still denied - every FS call returns `EPERM` until ⌘Q + relaunch. We mitigate two ways:
  1. `electron-builder.yml` declares `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` / `NSDownloadsFolderUsageDescription` via `mac.extendInfo`, so first access triggers a proper consent dialog.
  2. `src/main/path-access.ts` (`assertCwdReadable`) runs as a pre-flight in `provider-registry`'s `START_SESSION` handler. If the cwd is TCC-protected and `fs.access(R_OK)` returns `EPERM`/`EACCES`, we throw `TccAccessError` with copy that names the cause and the fix. The error surfaces in chat as a system message instead of a deep-stack SDK failure, complete with an inline "Relaunch to Apply Permissions" button.

## Architecture

### Window → Row → Window → Pane model (terminals)

- `Row` = horizontal container (full-width stack of columns)
- `Window` = column within a row; holds stacked panes as tabs
- `Pane` = a single xterm instance (tab inside a window)
- `⌘T` new window in row · `⌘⇧T` new window in new row · `⌘\` new tab in window · `⌘⇧]`/`⌘⇧[` cycle tabs · `⌘1-9` focus window · `⌘⌥+arrows` navigate
- Panes default `cwd` to the active session's `projectPath` (fixed 2026-04-20)
- `terminal-registry.ts` - module-level `Map<id, TerminalInstance>` outside React; panes survive re-renders / panel toggles / StrictMode double-mount
- `PaneResizeHandle.tsx` / `ResizeHandle.tsx` - pointer-capture + rAF drag handles, callbacks in refs to avoid tearing down mid-drag

### Provider bridge (`src/main/provider/`)

- `types.ts` re-exports from `src/shared/provider-events.ts` so renderer can type the IPC boundary
- `ProviderKind = 'claude' | 'codex' | 'opencode'`
- `ProviderAdapter` interface - required: `startSession(opts, onEvent)`, `sendTurn(threadId, message, runtimeMode?, images?)`, `interruptTurn`, `respondToRequest`, `stopSession`, `setRuntimeMode`, `isAvailable`. Optional: `setModel?`, `answerQuestion?`, `listSkills?`
- **`policy.ts` is the shared policy module** (2026-04/05 - was previously inlined in claude-adapter). All three adapters import from it:
  - `decidePermission(mode, toolName) → 'allow' | 'deny' | 'prompt'` - pure, unit-tested
  - `denialMessage(mode, toolName)` - human-readable denial reason
  - `PLAN_READ_ONLY_TOOLS` - Read/Glob/Grep/NotebookRead/WebFetch/WebSearch/TodoWrite (+ Codex equivalents `read_file`/`list_files`/`search_files`/`fetch`) allowed in plan mode, everything else denied
  - `CUSTOM_UI_TOOLS` - AskUserQuestion + ExitPlanMode (+ Codex `ask_user_question`/`exit_plan_mode`) skip `tool.started` emission so the custom cards render instead of raw JSON
- `event-bus.ts` - `RuntimeEventBus` (EventEmitter) decouples adapter event emission from the renderer, so N subscribers (renderer, future telemetry) can listen instead of 1:1 `webContents` coupling
- `env-overlay.ts` - merges a provider-instance env overlay into the spawn env (skips empty strings so partial configs don't blank defaults)
- `claude-session-migrate.ts` - copies Claude SDK session JSONL across `oauth_dir` when rotating provider instances mid-flight, so resume survives a credential switch

### Runtime events (wire format)

Defined in `src/shared/provider-events.ts`. Discriminated union:

- `content` · streaming text, `streamKind: 'assistant' | 'reasoning' | 'plan'`
- `tool.started` · tool call begun (skipped for custom-UI tools)
- `tool.completed` · tool finished
- `tool.denied` · **2026-04-20**: `canUseTool` hard-denied (e.g. Plan mode blocked Write) - UI renders denial pill
- `request.opened` / `request.closed` · approval prompt flow (`requestType: 'command' | 'file' | 'tool'`)
- `turn.completed` · turn ended, with `costUsd? / usedTokens? / maxTokens? / numTurns? / durationMs?`
- `status` · session status change · `session` · sessionId recorded
- `context_window` · live token count (polled after each turn)
- `model.variants` · available model variants + current selection
- `plan.proposed` · ExitPlanMode intercept → PlanCard
- `question.asked` / `question.answered` · AskUserQuestion intercept → QuestionCard
- `file.edited` · **2026-06-02**: one event per changed file per turn, sourced from a git checkpoint diff (provider-agnostic) - drives the Cursor-style in-chat diff card with per-hunk accept/reject
- `error` · adapter-level error surfaced to chat

### Image pipeline (2026-04-20)

1. User pastes/drags image in `ChatInput` → `ImageAttachment[]`
2. `ChatPanel.handleSend` converts each `File` to data URL via `FileReader.readAsDataURL`
3. `providerApi.sendTurn(..., messageImages)` passes through preload → `provider-registry` IPC → adapter
4. Claude adapter strips the `data:image/png;base64,` prefix and builds `{type:'image', source:{type:'base64', media_type, data}}` content blocks alongside text
5. Codex adapter encodes images into JSON-RPC content blocks (Phase B done - see `codex-adapter.ts` `sendTurn`)
6. On JSONL reload, `JsonlParser.extractImages` reconstructs data URLs from image blocks - historical images survive restart

### Question / Plan flow

1. Agent calls `AskUserQuestion` or `ExitPlanMode` (both in `CUSTOM_UI_TOOLS`) - raw `tool.started` is suppressed
2. SDK fires `canUseTool` → our handler intercepts, emits `question.asked` / `plan.proposed`
3. ChatPanel appends a message with `question` or `plan` attachment
4. `MessageBubble` routes to `QuestionCard` (T3-style, numbered shortcuts 1-9, auto-advance) or `PlanCard` (markdown + Implement/Iterate buttons)
5. User answers → `provider.answerQuestion(threadId, requestId, answers)` resolves the blocked Promise
6. `canUseTool` returns allow + `updatedInput` with the answer payload

### Archive system

- `archived INTEGER` column on `conversations` table
- `getArchivedConversationIds()` returns a **global** ID set (not per-project) - fixes pre-2026-04-20 bug where a session listed under two project views would reappear after archiving from only one
- Filter applies in `GET_PROJECTS`, `SCAN_SESSIONS`, and `OPEN_FOLDER` handlers

### Slash commands (2026-04-20)

- `SlashCommandMenu` popover wired into `ChatInput` textarea
- Trigger: `/` at start of line, matched by `^\/([^\s/]*)$` (mid-line slashes like paths don't fire)
- Registry in `src/renderer/components/chat/slashCommands.ts`
- v1 commands: `/plan`, `/sandbox`, `/edits`, `/full`, `/clear`, `/archive`, `/image`, `/stop`, `/help`
- `/help` opens an overlay listing everything

### Theme system

- CSS variables: `.theme-dark`, `.theme-light`, `.theme-translucent` in `global.css`
- Translucent uses macOS vibrancy (`setVibrancy('sidebar')`) + transparent BG
- Theme picker in Settings modal (`⌘,`)

### Provider instances (multi-account credentials)

- `provider_instances` table: `(id, agent_type, display_name, accent_color, auth_mode, env_encrypted BLOB, oauth_dir, config_json, enabled, created_at, updated_at)`. Multiple named instances per agent type (e.g. `codex-work` / `codex-personal`).
- `auth_mode`: `'env'` (safeStorage-encrypted env vars in `env_encrypted`) or `'oauth_dir'` (per-instance config dir set as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`).
- IPC (`ProviderInstanceChannels`): `LIST` (secrets stripped), `UPSERT` (plaintext env in, encrypted at rest), `DELETE` (refuses last-of-kind), `TEST` (probes creds via `claude auth status` / `codex login status` / `opencode models`), `CREATE_OAUTH_DIR`.
- Registry resolves the instance at `startSession` (`resolveProviderInstance(agentType, instanceId)`), falling back requested → default → any enabled; applies the env overlay + oauth_dir at spawn.
- UI: `UnifiedProviderPicker` (drop-up: agent tabs → instance rail → model search) in the chat composer; `ProvidersTab` in Settings. Renderer cache in `provider-instance-store`.

### Embedded IDE (code-server) + file IPC

- **Right pane has two modes** (⌘⇧E toggles): the terminal strip, or the IDE pane. Both stay mounted (positioned overlay) so xterm/pty and workbench state survive toggling.
- `IdePane.tsx` renders the real VS Code workbench served by a per-app `code-server` process in ONE persistent `<webview partition="persist:ide">` - switching projects navigates the same webview to the new `?folder=` (RAM policy: never N workbench renderer processes). Prewarmed in the background once a session is active (server + hidden workbench; never downloads the binary uninvited), so the first ⌘⇧E is instant. Hidden 15 min → server killed + webview blanked; cold respawn ~0.35s.
- `src/main/ide/`: `code-server-manager.ts` (spawn args, release-asset table, extension seeding, lifecycle: EADDRINUSE retry-once, capped health poll, respawn after crash), `binary.ts` (download to `userData/code-server/<version>/`, PATH fallback for devs), `bridge-server.ts` (ws + token; routes open/selection by workspace folder).
- `resources/sb-bridge/`: zero-dependency extension seeded into code-server's extensions dir. `protocol.js` is pure (message build/parse/validate + reconnect backoff, unit-tested); `extension.js` is thin vscode glue (open-at-line, cmd+l selection capture, cmd+k quick edit, live config apply, the Switchboard Charcoal color theme (app palette), terminal-intent keybindings (ctrl+backtick / cmd+j / cmd+shift+e route to Switchboard's terminal pane; task/debug terminals untouched)). Ships via electron-builder `extraResources`.
- IPC (`IdeChannels`): `ENSURE` (boot + serve folder, TCC pre-flight per call) / `STATUS` (push: stopped | starting | downloading | ready | error) / `OPEN` (pill click → open-at-line in workbench) / `SELECTION` (cmd+l in workbench → chat draft pill) / `STOP` (idle shutdown).
- Security ADR: `--auth none` on `127.0.0.1` - same-user trust boundary as PTYs and the embedded SDK. Design doc: `docs/plans/2026-07-10-embedded-ide-design.md`.
- Surviving file IPC (`FilesChannels`): `list-dir` (lean name/isDir - remote add-project autocomplete), `list-all` (@-mentions, 10k cap), `write-file`/`delete-file` (FileDiffCard accept/reject - atomic temp-then-rename, mtime conflict detection, 8 MB cap), `resolve` (FileChip pill existence). `resolveWithinRepo` rejects `..`-escapes.

### Git tooling + worktrees

- `ipc/git.ts` (`GitChannels`): `list-refs` (locals + remotes, annotated with current/sha/worktreePath), `switch-ref` (validated, rejects `-`/`..`/control chars), `current-branch`, `file-diff` (parses `git diff HEAD` into add/del/mod gutter hunks - `git/diffHunks.ts`), `create-session-worktree`.
- `worktree.ts` manages three creation flows: **kanban card** (`<repo>/.switchboard/worktrees/<slug>-<id>`, branch `kanban/<slug>-<id>`), **fork-from-message** (`<repo>/.switchboard/worktrees/<base>`, branch `fork/<name>`, collision-retry `-2`…`-20`), **session** (`$userData/worktrees/<repoSlug>-<hash>/<branchSlug>`, branch `sb/<slug>`). Plus `removeWorktree`, `listWorktrees`, `findStaleWorktrees`.
- Worktrees live under `.switchboard/worktrees/` deliberately - avoids re-tripping the macOS TCC trap on `~/Desktop`-rooted repos and centralizes cleanup.

### Conversation forking (`conversations/fork.ts`)

- IPC `app:fork-conversation`, input `{ sourceConversationId, upToIndex, forkedAtMessageId?, withWorktree? }`. Position-based (`upToIndex`), not id-based, because `JsonlParser` regenerates ids on every reload.
- **Claude** is truly resumable: `assembleClaudeFork` (in `agent/jsonl-truncate.ts`) walks all chronological JSONL fragments, truncates, rewrites `sessionId` to a new UUID, writes `<newId>.jsonl` into the encoded project dir; the new id is passed as `resumeSessionId`. **Codex / OpenCode are degraded** (Codex writes a truncated rollout as an audit record; OpenCode is summary-only) - both start cold with a synthetic system notice prepended.
- DB lineage: `conversations.parent_conversation_id` + `forked_at_message_id`; worktree forks also set `worktree_path` / `worktree_branch` and the title becomes `<parent> · fork/<slug>`. `thread_sessions` table flattens Claude's compaction-rotated session chains so ancestry walks are O(1).

### Kanban board (⌘⇧K top-level view)

- Top-level view (not a right-pane mode) swapping the chat area for a workspace-scoped board; sidebar stays mounted. `layout-store.appView: 'chats' | 'kanban'`.
- `kanban_cards` table: `(id, project_path, title, description, tags JSON, status, cost_cap_usd, cost_used_usd, runtime_mode, conversation_id, worktree_path, worktree_branch, created_at, updated_at, completed_at)`. Statuses: `backlog | in_progress | in_review | done`.
- IPC (`KanbanChannels`): `list / create / update / delete / create-worktree / remove-worktree / list-worktrees / list-stale-worktrees / remove-stale-worktree`. Moving a card to `done` auto-archives its linked conversation (`applyKanbanArchiveSideEffect`); moving back unarchives.
- `cardLaunch.ts` `launchCardChat`: reuses the linked conversation if live, else spins up a new session rooted at `worktree_path ?? project_path`, links card→conversation, seeds + auto-sends the first turn (title + description). `WorktreeManagerModal` is the manual cleanup UI (lists worktrees, flags `inUse`, batch-removes stale).

### Lexical chat input (pill chips + @-mentions)

- `RichChatTextarea.tsx` - Lexical `PlainTextPlugin` editor that serializes to a plain string with `[[pill:id]]` tokens (draft store stays string-shaped). Replaced the plain `<textarea>`.
- **Pill chips** (`PillNode` decorator + shared `PillChipVisual`): three kinds - `file` (blue), `terminal` (amber), `chat-message` (purple). Inserted by ⌘L context bridge; `×` removes (fires `sb-pill-remove` to prune metadata). Round-trip through `[[pill:id]]` on paste/reload. `renderPillBody` rebuilds chips in sent bubbles.
- **@-mentions**: `@` at a word boundary opens `AtMentionMenu`; `detectAtTrigger` + `filterAtMatches` rank with `services/fuzzyScore`; Enter inserts a file ref.
- `rotationMarker.ts` - when the user swaps provider instance mid-chat, a `[[sb:instance-rotated]] <from> → <to>` system marker renders as a compact pill.
- `BranchPicker` (`main ▾` chip) switches the session's git ref via `git:switch-ref` (policy in `branchPickerPolicy.ts`: current first, then locals, then remotes; substring filter).

### Project favicons (`sb-favicon://` protocol)

- `faviconResolver.ts` probes static icon paths (root → public/ → app/ → src/ → assets/ → .idea/, each `.svg`/`.ico`/`.png`), cached by `(projectPath, parent mtime)`. Fallback `faviconHtmlScan.ts` scans `index.html` / framework root files for `<link rel="icon">` (skips data:/http: hrefs, containment-checked).
- Served via the `sb-favicon://favicon?path=<encoded>` custom protocol (`protocol/sb-favicon.ts`) - path must match a known DB project. `ProjectFavicon.tsx` renders it in the sidebar, falling back to a folder glyph on error.

## What's currently working

- Claude Code SDK integration end-to-end: streaming text, tool calls, context window metrics, interrupt
- Codex app-server integration: basic chat + plan-mode + AskUserQuestion + image support (Phase B done)
- **OpenCode ACP adapter** (2026-04-28, only OpenCode adapter - legacy `opencode run --format json` shell-out retired 2026-05-02): speaks the Agent Client Protocol over a long-lived `opencode acp` child. Dynamic model list, shell-env probing for API keys, settings-DB key injection, placeholder + heartbeat + 3-min timeout (free-tier-aware error message) for cold-boot UX. Skill discovery via `available_commands_update` ACP push events. Helper: `adapters/opencode/env.ts` for shared env-probing.
- Plan mode with hard-deny + read-only allow-list
- AskUserQuestion → QuestionCard (numbered shortcuts, auto-advance)
- ExitPlanMode → PlanCard (markdown + Implement/Iterate)
- Image paste/drag/drop → SDK image blocks → persist across reload
- Archive conversations (global ID filter)
- Drag-to-reorder projects (`@dnd-kit`)
- Auto-title generation from first user message
- Runtime mode selector (Plan/Sandbox/Accept-Edits/Full-Access) per-session, live-updates mid-turn
- Tmux-style terminal windows + tabs + splits with proper cwd
- Pre-commit hook + CI (GitHub Actions: typecheck + test + build)
- **Slash command menu in chat input** with agent-skill exposure (2026-04-26): Claude SDK `init.commands` + Codex `skills/list` + OpenCode `available_commands_update` surfaced alongside Switchboard's 9 built-ins. Source-grouped sections in the menu; agent-source selections insert `/<name> ` for the user to fill in args.
- **`⌘L` multi-source context bridge** (2026-04-29): single keybinding routes by the focused element's `data-context-source` attribute (`terminal | file-viewer | chat-message`). Terminal selection → fenced code block w/ pane label header (50k char cap). File-viewer selection → `@<path>:<start>-<end>` pill + fenced block. Chat-message selection → `> from <agent>: "..."` quoted block. All three append to the active session's draft via `useDraftStore.appendDraft`. Pure formatters (`formatTerminalContext`, `formatFileViewerContext`, `formatChatMessageContext`) are unit-tested.
- **Per-turn duration badge** (2026-04-29): adapters stamp `turnStartedAt` on `sendTurn` and emit `durationMs` on `turn.completed`. MessageBubble renders "Worked for X.Xs" under the assistant message via `fmtDuration` from `src/shared/format.ts`. Wired across all 3 active adapters (claude, codex, opencode-acp).
- **Right-pane "IDE" mode** (⌘⇧E to toggle, 2026-07-10): the right column flips between the terminal strip and the embedded VS Code workbench. `layout-store.rightPaneMode` (persisted under `layout.rightPaneMode`). Both panes stay mounted so toggling preserves xterm/pty and workbench state.
- **Embedded IDE (code-server)** (2026-07-10): full workbench, one server + one webview per app, idle shutdown, cmd+l selection → chat pill, pill click → open-at-line - see Embedded IDE section
- **Inline file pills in agent messages** (2026-04-29): `MessageBubble` post-process walks rendered markdown DOM; inline `<code>` tokens that match `looksLikeRepoPath()` become clickable chips. Path heuristic in `src/shared/filePathRef.ts` (must contain `/`, must end in `.<ext>` or have `:line[-line]` suffix; rejects URLs and absolute paths to avoid false positives). Click → `layout-store.openInViewer(path, lineRange)` flips the right pane to the IDE and routes an open-at-line through the sb-bridge. Existence verified via `files:resolve` IPC; non-existent paths revert to plain code.
- **`⌘L` context bridge** (legacy alias retained for the terminal flow inside the multi-source dispatch above)
- **`⌘K` quick prompt**: floating prompt bar that sends a one-shot turn to the active session. Pre-fills with the workbench selection (cmd+k inside the IDE, Cursor-style: instruction -> agent edits -> FileDiffCard review) or the current terminal selection
- **Side-by-side dual chat panels** (`⌘|` toggle, `dualChat`/`rightSessionId`/`chatSplitRatio` in layout-store)
- **"Send to other panel"** forward action on messages
- **Status bar** at bottom showing project, agent, status, terminal count
- **System notifications** on `turn.completed` for non-active sessions (`src/renderer/services/notifications.ts`)
- **Export conversation as markdown** (`exportMarkdown.ts` + Sidebar right-click)
- **`⌘F` in-pane search** for terminals (xterm SearchAddon with decoration overlays - requires `allowProposedApi: true`) and individual chat panes (DOM TreeWalker wraps first match in `<mark.sb-search-mark>`); shared `InPaneSearchBar` component, document-level keydown listeners scoped to focused pane via `[data-terminal-pane]` / `[data-chat-panel]` attrs
- **Feature Tour modal** (`FeatureTourModal.tsx` + `featureRegistry.ts` in `src/renderer/components/onboarding/`) - auto-opens on first launch and after `TOUR_VERSION` bumps; replayable from Settings → Tour. MP4 clips streamed via `sb-tour://<id>.mp4` custom protocol (resolves to `videos/dist/`, served via `net.fetch('file://...')` for byte-range support). 11 clips currently rendered in `videos/dist/`.
- **Agent-aware UI labels**: `agentLabel()` / `agentShortLabel()` helpers in `shared/types.ts` so StatusBar / MessageBubble / etc. all reflect Claude Code / Codex / OpenCode correctly
- **Multi-instance provider picker** (shipped): named credentials per agent type (env or oauth_dir), `UnifiedProviderPicker` + Settings → Providers, env overlay + session migration at spawn - see Provider instances section above
- **Kanban board** (⌘⇧K) with worktree-backed cards - see Kanban section
- **Conversation forking** ("Fork from here" / "Fork to worktree") - see Conversation forking section
- **Lexical chat input** with pill chips + `@`-mention file autocomplete - see Lexical chat input section
- **Project favicons** in the sidebar via `sb-favicon://`
- **Bookmarks** (`bookmark-store` + `bookmarks` DB table) - bookmark messages/sessions
- **In-chat diff review** (2026-06-02): after each turn, changed files surface as Cursor-style diff cards in chat with per-hunk accept/reject. Git checkpoint at turn start (`src/main/git/checkpoint.ts` + `checkpoint-tracker.ts`); `fileDiffResolve.ts` applies/reverts hunks; `file.edited` events are provider-agnostic (git is the source of truth). `FileDiffCard.tsx` renders the cards.
- **Rate-limit event handling** (2026-06-10): Claude SDK `rate_limit_event` surfaced as a chat status message with window type + reset time; subprocess leak on `stopSession` fixed (6 new tests in `claude-adapter-stop-session.test.ts`)
- Single-instance lock
- Native app menu (`⌘,` for settings, standard Edit/View/Window)
- File-based logger at `~/Library/Application Support/switchboard/logs/`
- Launch-config YAML parser (runtime hydration on launch)

## What's NOT working yet

- **Code-signing** - unsigned macOS arm64/x64 `.dmg`/`.zip` and Windows `.exe`/`.zip` builds ship via `npm run dist:*`; `electron-updater` is wired (`main/updater.ts`, auto + manual). Awaiting Apple Developer cert.
- **launch-config.yaml hot-reload** + `on_start` wait/then orchestration - partial; runtime hydration works
- **Cursor import** (read `state.vscdb`) - not started
- **Codex / OpenCode fork resume** - fork creates the new conversation but only Claude resumes real context; Codex/OpenCode start cold (audit record / summary only)
- **Provider hot-swap context preservation** - swapping agent mid-chat keeps the visible stream but the new adapter starts with zero context (see `docs/notes/roadmap-deferred.md` #4)

## Skill exposure (shipped 2026-04-26)

`ProviderAdapter.listSkills?(threadId)` is the seam:
- **Claude adapter** captures `system/init.{slash_commands|commands}` and prefers live `query.supportedCommands()`. Cached on the active session.
- **Codex adapter** sends JSON-RPC `skills/list`, caches result. Older builds get a graceful empty cache (logged, not retried).
- **OpenCode** receives skills via `available_commands_update` ACP push events; the adapter caches the list and `listSkills()` returns it directly. (The earlier `opencode debug skill` shell-out was replaced when the ACP adapter was finalised.)
- IPC: `ProviderChannels.LIST_SKILLS` → `provider:list-skills` (preload `window.api.provider.listSkills(threadId)`).
- UI: `ChatInput` fetches on session start with retry-while-empty (handles late `system/init`); `mergeWithAgentSkills` keeps built-ins first, name-collisions resolve in favor of built-ins so `/clear` always means "clear chat" not whatever a skill named `clear` does. `SlashCommandMenu` renders source-grouped sections + argument-hint suffix. Agent-source selections insert `/<name> ` into the textarea (no special wire path) - the SDK / CLI parses leading slash from the prompt itself.

Pure parsers exported and unit-tested: `parseClaudeSlashCommands` (claude-adapter), `parseCodexSkills` (codex-adapter), `mergeWithAgentSkills` + `skillsToSlashCommands` (slashCommands.ts).

## Test suite (~1105 tests across 127 files)

Run the whole suite: `npm test`. Targeted runs: `npx vitest run tests/unit/<file>.test.ts`. Notable files:

- `message-list.test.ts` - `groupIntoTurns` keeper-list (regression for empty-content attachment drops)
- `slash-commands.test.ts` - slash trigger + registry
- `session-scanner.test.ts` - exact-match matching (parent/child bleed)
- `claude-adapter-plan-mode.test.ts` / `provider-policy.test.ts` - plan mode permission policy
- `provider-adapter-tool-filter.test.ts` - `CUSTOM_UI_TOOLS` set membership
- `jsonl-parser.test.ts` / `jsonl-truncate.test.ts` - Claude + Codex schemas, historical images, fork truncation
- `provider-instances-db.test.ts` / `*-instance-env.test.ts` - multi-instance credentials + env overlay
- `worktree.test.ts` / `create-session-worktree.test.ts` / `worktree-paths.test.ts` - worktree flows + collision retry
- `code-server-manager-*.test.ts` / `ide-bridge-server.test.ts` / `sb-bridge-protocol.test.ts` - embedded IDE: manager lifecycle, bridge routing, extension protocol
- `at-mention.test.ts` / `render-pill-body.test.ts` / `draft-pills.test.ts` - Lexical pills + @-mentions
- `kanban-store.test.ts` / `card-launch.test.ts` / `kanban-archive-side-effect.test.ts` - kanban
- `favicon-resolver.test.ts` / `favicon-html-scan.test.ts` / `favicon-protocol.test.ts` - favicons

### E2E temp-dir cleanup (MANDATORY)

The e2e scripts (`e2e/ide.e2e.mjs`, `e2e/ide-workflow.e2e.mjs`, etc.) create ~600MB temp dirs per run via `mkdtempSync` (`sb-ide-e2e-*`, `sb-ide-wf-*`, `sb-ide-proj-*`, `sb-update*`, `sb-ide-probe*`) and do NOT clean up after themselves — this has filled the entire disk before (600+ leaked dirs, ~18GB). You are welcome to run e2e tests, but after every e2e run (pass, fail, or crash) you MUST delete the leftovers:

```sh
rm -rf "$TMPDIR"sb-* /tmp/sb-*
```

If you touch the e2e scripts themselves, prefer fixing the leak at the source: register a `process.on('exit')` handler that `rmSync`s every `mkdtempSync` dir the script created.

## File structure (condensed)

```
src/
├── main/
│   ├── index.ts                       # Electron main
│   ├── agent/
│   │   ├── agent-manager.ts           # Legacy --print agent (deprecated)
│   │   ├── jsonl-parser.ts            # Source-aware (claude-code | codex) + image extraction
│   │   └── jsonl-truncate.ts          # Pure fork truncation (assembleClaudeFork, truncate*Jsonl)
│   ├── conversations/fork.ts          # Fork-from-message orchestration (per-provider resume)
│   ├── db/
│   │   ├── database.ts                # SQLite schema, archive, FTS, settings, kanban, fork lineage
│   │   └── providerInstances.ts       # provider_instances CRUD (safeStorage-encrypted env)
│   ├── files/                         # listing (gitignore-annotated) · writing (atomic+conflict) · gitignore matcher
│   ├── git/                           # diffHunks (gutter) · refs · worktreePaths · checkpoint (diff review)
│   ├── ide/                           # code-server-manager · binary (download) · bridge-server (ws)
│   ├── worktree.ts                    # kanban / fork / session worktree creation + cleanup
│   ├── ipc/
│   │   ├── terminal.ts · agent.ts(dep) · app.ts   # PTY · legacy · projects/sessions/archive/fork
│   │   ├── files.ts · git.ts · ide.ts · kanban.ts # files + git + IDE + kanban IPC
│   │   ├── providerInstances.ts       # instance LIST/UPSERT/DELETE/TEST/CREATE_OAUTH_DIR
│   │   └── enrichDisplayBody.ts       # pill/display-body enrichment for stored messages
│   ├── projects/
│   │   ├── session-scanner.ts         # exact-match Claude + Codex scanners (encodeClaudeProjectPath)
│   │   ├── faviconResolver.ts         # static icon probe (cached by path+mtime)
│   │   └── faviconHtmlScan.ts         # <link rel=icon> fallback scan
│   ├── protocol/sb-favicon.ts         # sb-favicon:// custom protocol handler
│   ├── provider/
│   │   ├── provider-registry.ts       # IPC handlers, instance resolution, event forwarding
│   │   ├── policy.ts                  # decidePermission/denialMessage/PLAN_READ_ONLY_TOOLS/CUSTOM_UI_TOOLS
│   │   ├── event-bus.ts               # RuntimeEventBus (decoupled fan-out)
│   │   ├── env-overlay.ts             # instance env merge · claude-session-migrate.ts # oauth_dir rotation
│   │   ├── types.ts                   # ProviderAdapter + re-exports from shared/provider-events
│   │   └── adapters/
│   │       ├── claude-adapter.ts      # SDK integration, canUseTool, image blocks
│   │       ├── codex-adapter.ts       # JSON-RPC over stdio (images + plan + AskUserQuestion done)
│   │       ├── opencode-acp-adapter.ts # OpenCode (ACP / JSON-RPC over stdio) - only OpenCode adapter
│   │       ├── opencode/env.ts        # Shared env-probe helper
│   │       └── question-answers.ts    # Shape AskUserQuestion answers for SDK wire format
│   ├── terminal/pty-manager.ts · path-access.ts · updater.ts · logger.ts
│   └── launch-config/launch-config-store.ts   # launch-config.yaml hydration (+ legacy workspace.yaml read)
├── preload/index.ts                   # Typed window.api (SwitchboardAPI), strongly-typed provider.onEvent
├── renderer/
│   ├── App.tsx                        # Flat flex-row layout, all keybindings, view switching
│   ├── components/
│   │   ├── CommandPalette.tsx (⌘⇧P) · QuickPromptModal.tsx (⌘K) · SearchModal.tsx (⌘⇧F)
│   │   ├── SettingsModal.tsx · settings/ProvidersTab.tsx · SessionPickerModal.tsx
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx · ChatInput.tsx · MessageList.tsx · MessageBubble.tsx
│   │   │   ├── ApprovalCard · PlanCard · QuestionCard · FileDiffCard · SlashCommandMenu · slashCommands.ts
│   │   │   ├── UnifiedProviderPicker.tsx # agent tabs → instance rail → model search
│   │   │   ├── BranchPicker.tsx + branchPickerPolicy.ts · SkillChip · FileChip
│   │   │   ├── AtMentionMenu.tsx + atMention.ts · renderPillBody.tsx · rotationMarker.ts
│   │   │   └── lexical/               # RichChatTextarea · PillNode · PillChipVisual
│   │   ├── ide/                       # IdePane (code-server <webview>)
│   │   ├── kanban/                    # KanbanView (⌘⇧K) · CardModal · WorktreeManagerModal · cardLaunch.ts
│   │   ├── sidebar/                   # Sidebar · ProjectFavicon · WorkspaceManager · dragLogic
│   │   ├── onboarding/               # FeatureTourModal + featureRegistry
│   │   └── terminal/                  # TerminalStrip · TerminalWindow · TerminalPane · TerminalHeader · TemplatePicker
│   ├── hooks/                         # useTerminalLifecycle · useAgent · useTerminal
│   ├── services/                      # terminal-registry · session-events · contextBridge · fuzzyScore · notifications
│   └── stores/                        # agent · terminal · layout · theme · draft · kanban · provider-instance · skill · bookmark
├── shared/
│   ├── ipc-channels.ts · provider-events.ts · types.ts · auto-title.ts · models.ts · format.ts · filePathRef.ts
└── tests/unit/                        # ~1105 tests across 127 files
```

## Logging conventions

Every module that can produce observable side-effects **must** use the scoped logger, not bare `console.*`. This keeps logs filterable, readable in both DevTools and the on-disk log file, and noise-free.

### Main process - `src/main/logger.ts`

```ts
import { createMainLogger } from '../logger'
const log = createMainLogger('domain:subsystem')   // e.g. 'ipc:files', 'ide:bridge'
log.debug('spawnArgs', args)
log.info('session started', { id })
log.warn('retry', err)
log.error('unrecoverable', err)
```

Writes to both the terminal (dev) and `~/Library/Application Support/switchboard/logs/switchboard-<date>-<pid>.log` (always). Log files rotate at 7 days.

### Renderer process - `src/renderer/logger.ts`

```ts
import { createRendererLogger } from '../../logger'   // adjust relative path
const log = createRendererLogger('domain:subsystem')  // e.g. 'store:agent', 'editor:host'
log.info('buffer opened', { path })
log.warn('save conflict detected', err)
```

Outputs to DevTools console with `[SB:scope]` prefix matching the main-process convention.

### Rules

- **Module-level constant**: `const log = createXxxLogger('scope')` - never inside functions.
- **Scope format**: `'domain:subsystem'` - e.g. `'ipc:files'`, `'store:agent'`, `'ide:pane'`.
- **No silent swallowing**: every `catch` block that doesn't re-throw must `log.warn` or `log.error`. `catch { /* ignore */ }` is a bug.
- **No AI slop patterns**: don't log "successfully did X" on the happy path unless it's a slow/async operation worth tracking. Log state changes, errors, retries, and lifecycle events.

## Writing style

- **No em dashes (U+2014) anywhere** - not in code, comments, UI copy, log messages, commit messages, PR descriptions, or docs. Use a hyphen with surrounding spaces (` - `), a comma, or two sentences instead. This is enforced repo-wide; a stray em dash is a review-blocker. (Arrows and middots are fine.)
