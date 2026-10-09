# Switchboard

The one agent-instructions file for this repo. `CLAUDE.md` imports it; do not
edit `CLAUDE.md` for anything that is not Claude-Code-specific.

Electron workspace that multiplexes terminals, agent chats (Claude Code + Codex + OpenCode), a kanban board, and an embedded VS Code IDE into one surface per project.

## Stack

- **Shell**: Electron 33 + React 19 + TypeScript 5.7
- **Build**: electron-vite + Vite 6
- **Terminal**: `@xterm/xterm` 6 + `node-pty` (native, rebuild after install)
- **IDE**: embedded VS Code workbench via code-server (Coder, MIT) in a single reused `<webview>`; binary downloaded on demand to userData, never bundled
- **UI primitives**: shadcn/ui (Radix) in `src/renderer/components/ui/` on Tailwind 4 utilities only (`styles/tailwind.css`: no preflight, no default theme, scanned from `components/ui` plus the files listed in `tailwind.css`, tokens mapped onto the theme variables). New menus, popovers and dialogs use `ui/popover` and `ui/dialog` (Radix) rather than hand-rolled outside-click, Escape and focus code (a few older ones, such as the sidebar context menu and the native session import modal, are still hand-rolled); `DialogContent` returns focus to whatever had it on open (or the composer), since these dialogs open from shortcuts with no `Dialog.Trigger`. Focus an input from `onOpenAutoFocus`, not `autoFocus`: autoFocus runs first, so Radix records the input itself as the element to return focus to. Never `window.confirm`: it is a native alert that blocks the renderer and Playwright cannot click it. Use `if (!(await confirm({ title, body, confirmLabel, destructive }))) return` from `components/ui/confirm` (`ConfirmHost` is mounted in `App`)
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
- `npm test` - vitest
- `npm run test:watch` - vitest in watch mode
- `npm run typecheck` - main + renderer tsc
- `npm run build` - **gated build**: `prebuild` runs typecheck + test before the actual build fires; `postbuild` runs `scripts/smoke-test.mjs`
- `npm run build:fast` - escape hatch, skips the gate
- `npm run rebuild` - rebuild `node-pty` + `better-sqlite3` for Electron

## Shipping checklist (MANDATORY, 2026-07-21)

Nothing merges to main or ships in a release without, in order:

1. `/deslop` - strip AI slop from the branch diff
2. `/review` (code review) - finder + verify pass over the diff; every CONFIRMED finding gets fixed or an explicit written deferral
3. `/deslop` again over the review fixes
4. Full gate green: `npm run typecheck` + `npm test`

Applies to every batch including "small" fixes. Releases additionally
require green CI on main first (see docs/releasing.md).

If the batch goes through a pull request, CodeRabbit reviews it automatically
(config in `.coderabbit.yaml`, no workflow). It is a second opinion, not a
replacement for step 2: it sees only the PR diff and it does not block the
merge button. Read its findings, then fix or dismiss each one. Work merged
from a local branch without a PR never gets reviewed by it.

## Cross-surface feature policy (merge-blocking)

Every feature or behavior change must be planned as one Switchboard product change, not as a Desktop-only implementation. Before editing, explicitly scope all of these impact areas:

1. Desktop Electron (`src/main`, `src/preload`, `src/renderer`)
2. React Native/iOS (`apps/mobile`)
3. Native Android (`apps/android`)
4. Shared backend/API contract
5. Stored data, migrations, and upgrade compatibility
6. Update channels, release packaging, and rollout

For each affected slice, carry the work through storage → API → state → UI → lifecycle → tests, keeping every app installable and releasable. Preserve package identity, signing, deep links, stored data, API semantics, and update compatibility. Do not claim cross-platform parity from compilation or unit tests alone; record automated, hardware, and unexercised verification separately.

Any pull request that changes behavior-bearing product paths must add or update `docs/feature-parity/<feature>.json`. The manifest must cover every impact area. Use `not_applicable` only with a concrete reason. Incomplete cross-surface work is allowed only as `staged`, with both a named feature flag and a named follow-up release; unflagged staged behavior must not merge. Run `npm run validate:feature-parity -- --base <base-ref>` locally. The schema and workflow are documented in `docs/plans/archive/2026-08-20-cross-surface-feature-policy-design.md`.

## Build gate (2026-04-20)

`npm run build` fails the entire build if typecheck or tests fail. The `prebuild` npm lifecycle hook chains `typecheck && test` before `electron-vite build`. This caught real regressions on the first run - see CHANGELOG.md.

## Known gotchas

- **Transcript caches**: `jsonl-cache.ts` keys by parser source and path plus size, mtime, ctime, inode and device; changed reads are not cached. Its 24-entry/128 MiB LRU budgets estimated retained message memory, not raw JSONL bytes (large discarded tool results must not evict both account copies). `transcript-compatibility.ts` caches only validated whole-file evidence and per-record SHA-256 digests, bounded to 24 paths/100,000 records, with the same file-state checks. Metadata alone never proves two different files equal. Preserve every copy/replacement validation and the source-only settle retries. `loadJsonlCopies` parses the largest profile copy of a session and skips a smaller copy only when its sha256 equals the same-length prefix digest of the largest; a cached file that grew from a state ending on a newline parses only the new bytes, once the old bytes hash to the cached digest. The desktop opens a window (see History windows); cmd+F, global search, fork anchors, export and the handoff preamble load the full history (`ensureFullHistory`, or a backend read).

- `ELECTRON_RUN_AS_NODE=1` is set by Claude Code's shell - `dev` script unsets it explicitly
- `electron` MUST be in `devDependencies`, not `dependencies`
- After `npm install`, run `npm run rebuild` for `node-pty` + `better-sqlite3`
- Claude Code encodes project paths by replacing EVERY non-alphanumeric char (`/`, `_`, `.`, etc.) with `-` in `~/.claude/projects/` - so `/.claude/worktrees/x` becomes `--claude-worktrees-x` (double dash). `encodeClaudeProjectPath` must match this exactly; a stale `/[/_]/g` (missing `.`) mis-filed migrated transcripts under `-.claude-...` and broke resume across profile switches with "No conversation found with session ID"
- Scanner uses **exact dir match** (not substring) - parent paths don't pick up child-project sessions (pre-2026-04-20 bug)
- `canUseTool` overrides the SDK's `permissionMode: 'plan'` - we enforce plan mode explicitly via `decidePermission`
- **Any new per-conversation setting must resolve through `resolveRootThreadId` before touching the `conversations` table.** Claude assigns a session UUID after the first turn; the sidebar then surfaces that UUID as `session.id` instead of the synthetic `agent_<ts>` id the setting was saved under, so a raw `WHERE id = ?` read/write silently misses the row and the setting appears to reset. `thread_sessions` (+ `resolveRootThreadId`) already maps rotated ids back to the original - hit twice so far (`getConversationRuntimeMode`/`setConversationRuntimeMode`, `getConversationProviderInstanceId`/`setConversationProviderInstanceId`, all in `src/main/db/database.ts`) because each was added without reusing that helper. This must be enforced by the shared code path (or a test, see `tests/unit/conversation-rotation-fallback.test.ts`), not by memory - check every future per-conversation getter/setter against this.
- **macOS TCC for project paths under `~/Desktop`/`~/Documents`/`~/Downloads`**: PTYs and the embedded SDK inherit Switchboard.app's TCC grants. If the user toggles "Files and Folders" on after launching, the running process is still denied - every FS call returns `EPERM` until ⌘Q + relaunch. We mitigate two ways:
  1. `electron-builder.yml` declares `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` / `NSDownloadsFolderUsageDescription` via `mac.extendInfo`, so first access triggers a proper consent dialog.
  2. `src/main/path-access.ts` (`assertCwdReadable`) runs as a pre-flight in `provider-registry`'s `START_SESSION` handler. If the cwd is TCC-protected and `fs.access(R_OK)` returns `EPERM`/`EACCES`, we throw `TccAccessError` with copy that names the cause and the fix. The error surfaces in chat as a system message instead of a deep-stack SDK failure, complete with an inline "Relaunch to Apply Permissions" button.

## Architecture

Detail for each area lives in an `AGENTS.md` next to its code. Claude Code
loads one on its own when it reads a file in that folder (each folder also has
a `CLAUDE.md` that imports it). Codex and OpenCode load only the files on the
path to their working directory, so **read the area's file before you edit
there**. Add new area detail to the nearest one, not to this file.

| Area | Read before you touch |
|---|---|
| Transport seam (`ElectronIpcHost`/`WsHost`), wire protocol, resume, epoch, liveness, device auth, phone history windows, SSH machines | `src/main/backend/AGENTS.md` |
| Provider adapters, runtime events, images, question/plan flow, cross-session messaging and links, provider instances and usage, skills, OpenCode 1.x/2.x | `src/main/provider/AGENTS.md` |
| Switchboard MCP server, agent PR tools, approval cards, phone approvals | `src/main/mcp/AGENTS.md` |
| Reviews, PR providers, chat-to-PR links, human writes | `src/main/pull-requests/AGENTS.md` |
| Conversation forking and merge-back | `src/main/conversations/AGENTS.md` |
| Embedded IDE (code-server) and file IPC | `src/main/ide/AGENTS.md` |
| Expo mobile app: update lanes, push, jest setup | `apps/mobile/AGENTS.md` |
| Screenshot regression tests and background windows | `e2e/AGENTS.md` |
| What ships today, feature by feature | `docs/features.md` |

### Window → Row → Window → Pane model (terminals)

- `Row` = horizontal container (full-width stack of columns)
- `Window` = column within a row; holds stacked panes as tabs
- `Pane` = a single xterm instance (tab inside a window)
- `⌘T` new window in row · `⌘⇧T` new window in new row · `⌘\` new tab in window · `⌘⇧]`/`⌘⇧[` cycle tabs · `⌘1-9` focus window · `⌘⌥+arrows` navigate
- Panes default `cwd` to the active session's `projectPath` (fixed 2026-04-20)
- `terminal-registry.ts` - module-level `Map<id, TerminalInstance>` outside React; panes survive re-renders / panel toggles / StrictMode double-mount
- `PaneResizeHandle.tsx` / `ResizeHandle.tsx` - pointer-capture + rAF drag handles, callbacks in refs to avoid tearing down mid-drag

### Archive system

- `archived INTEGER` column on `conversations` table
- `getArchivedConversationIds()` returns a **global** ID set (not per-project) - fixes pre-2026-04-20 bug where a session listed under two project views would reappear after archiving from only one
- Filter applies in `GET_PROJECTS`, `SCAN_SESSIONS`, and `OPEN_FOLDER` handlers

### Slash commands (2026-04-20)

- `SlashCommandMenu` popover wired into `ChatInput` textarea
- Trigger: `/` at start of line, matched by `^\/([^\s/]*)$` (mid-line slashes like paths don't fire)
- Registry in `src/renderer/components/chat/slash-commands.ts`
- v1 commands: `/plan`, `/sandbox`, `/edits`, `/full`, `/clear`, `/archive`, `/image`, `/stop`, `/help`; later `/send-to`, `/link`, `/unlink`, `/merge-back`
- `/help` opens an overlay listing everything

### Theme system

- CSS variables: `.theme-dark`, `.theme-light`, `.theme-translucent` in `global.css`
- Translucent uses macOS vibrancy (`setVibrancy('sidebar')`) + transparent BG
- Theme picker in Settings modal (`⌘,`)

### Git tooling + worktrees

- `ipc/git.ts` (`GitChannels`): `list-refs` (locals + remotes, annotated with current/sha/worktreePath), `switch-ref` (validated, rejects `-`/`..`/control chars), `current-branch`, `file-diff` (parses `git diff HEAD` into add/del/mod gutter hunks - `git/diffHunks.ts`).
- Worktree **creation** lives in one place, not in `worktree.ts`: `worktree-creation/git-adapter.ts` drives the transactional flow behind `KanbanChannels.CREATE_WORKTREE` (kanban card, `<repo>/.switchboard/worktrees/<slug>-<id>`, branch `kanban/<slug>-<id>`) and behind conversation forking (fork-to-worktree, `fork/<name>`). `worktree.ts` itself only lists, finds-stale, and removes worktrees now (`removeWorktree`, `listWorktrees`, `findStaleWorktrees`) - its own creation functions were dead code with no production caller and were deleted.
- **Worktree manager** (Settings > Archive & data > Worktrees, `WorktreeManagerChannels`): rules in `shared/worktree-manager.ts` (`classifyWorktree`, `removalVerdict`), backend in `main/worktree-manager.ts` + `main/worktree-inspect.ts`. Every removal goes through `removeManagedWorktree`, which re-reads ownership, protection and git state and refuses when the losses exceed what the client acknowledged. Owned worktrees (chat, card, catalog, in-flight creation) are never removed there. Protection is the backend settings row `worktrees.protection` (`{ projects, worktrees }`), honoured by `findStaleWorktrees` too.
- Worktrees live under `.switchboard/worktrees/` deliberately - avoids re-tripping the macOS TCC trap on `~/Desktop`-rooted repos and centralizes cleanup.
- **Agents needing another branch**: the main checkout is shared by many sessions and is often on someone else's branch, so don't switch it. Use `git worktree add .switchboard/worktrees/<name> -b <branch> origin/main`, never `/tmp` - each one is ~1.5GB after `npm install` and nothing reaps `/tmp` (leaked worktrees there have filled the disk). Once the PR merges, `git worktree remove .switchboard/worktrees/<name>`.

### Kanban board (⌘⇧K top-level view)

- Top-level view (not a right-pane mode) swapping the chat area for a workspace-scoped board; sidebar stays mounted. `layout-store.appView: 'chats' | 'kanban'`.
- `kanban_cards` table: `(id, project_path, title, description, tags JSON, status, cost_cap_usd, cost_used_usd, runtime_mode, conversation_id, worktree_path, worktree_branch, created_at, updated_at, completed_at)`. Statuses: `backlog | in_progress | needs_input | done`.
- IPC (`KanbanChannels`): `list / create / update / delete / create-worktree / remove-worktree / list-worktrees`. Moving a card to `done` auto-archives its linked conversation (`applyKanbanArchiveSideEffect`); moving back unarchives.
- `card-launch.ts` `launchCardChat`: reuses the linked conversation if live, else spins up a new session rooted at `worktree_path ?? project_path`, links card→conversation, seeds + auto-sends the first turn (title + description). `WorktreeManagerModal` is the Settings worktree manager (`settings/WorktreesPanel.tsx`) scoped to the card's project - one list, one removal path.

### Lexical chat input (pill chips + @-mentions)

- `RichChatTextarea.tsx` - Lexical `PlainTextPlugin` editor that serializes to a plain string with `[[pill:id]]` tokens (draft store stays string-shaped). Replaced the plain `<textarea>`.
- **Pill chips** (`PillNode` decorator + shared `PillChipVisual`): three kinds - `file` (blue), `terminal` (amber), `chat-message` (purple). Inserted by ⌘L context bridge; `×` removes (fires `sb-pill-remove` to prune metadata). Round-trip through `[[pill:id]]` on paste/reload. `renderPillBody` rebuilds chips in sent bubbles.
- **@-mentions**: `@` at a word boundary opens `AtMentionMenu`; `detectAtTrigger` + `filterAtMatches` rank with `services/fuzzy-score`; Enter inserts a file ref.
- `shared/rotation-marker.ts` - when the user swaps provider instance mid-chat, a `[[sb:instance-rotated]] <from> → <to>` system marker renders as a compact pill.
- `BranchPicker` (`main ▾` chip) switches the session's git ref via `git:switch-ref` (policy in `branch-picker-policy.ts`: current first, then locals, then remotes; substring filter).

### Project favicons (`sb-favicon://` protocol)

- `favicon-resolver.ts` probes static icon paths (root → public/ → app/ → src/ → assets/ → .idea/, each `.svg`/`.ico`/`.png`), cached by `(projectPath, parent mtime)`. Fallback `favicon-html-scan.ts` scans `index.html` / framework root files for `<link rel="icon">` (skips data:/http: hrefs, containment-checked).
- Served via the `sb-favicon://favicon?path=<encoded>` custom protocol (`protocol/sb-favicon.ts`) - path must match a known DB project. `ProjectFavicon.tsx` renders it in the sidebar, falling back to a folder glyph on error.

## Test suite

Screenshot tests and how to run e2e without stealing focus: `e2e/AGENTS.md`.

Run the whole suite: `npm test`. Targeted runs: `npx vitest run tests/unit/<file>.test.ts`. Notable files:

- `message-list.test.ts` - `groupIntoTurns` keeper-list (regression for empty-content attachment drops)
- `slash-commands.test.ts` - slash trigger + registry
- `session-scanner.test.ts` - exact-match matching (parent/child bleed)
- `claude-adapter-plan-mode.test.ts` / `provider-policy.test.ts` - plan mode permission policy
- `provider-adapter-tool-filter.test.ts` - `CUSTOM_UI_TOOLS` set membership
- `jsonl-parser.test.ts` / `jsonl-truncate.test.ts` - Claude + Codex schemas, historical images, fork truncation
- `provider-instances-db.test.ts` / `*-instance-env.test.ts` - multi-instance credentials + env overlay
- `worktree.test.ts` / `worktree-paths.test.ts` - worktree list/find-stale/remove + deterministic session worktree paths
- `code-server-manager-*.test.ts` / `ide-bridge-server.test.ts` / `sb-bridge-protocol.test.ts` - embedded IDE: manager lifecycle, bridge routing, extension protocol
- `at-mention.test.ts` / `render-pill-body.test.ts` / `draft-pills.test.ts` - Lexical pills + @-mentions
- `kanban-store.test.ts` / `card-launch.test.ts` / `kanban-archive-side-effect.test.ts` - kanban
- `favicon-resolver.test.ts` / `favicon-html-scan.test.ts` / `favicon-protocol.test.ts` - favicons

better-sqlite3 loads under vitest. For a test of the `db/*` modules, import `createMigratedDb` from `tests/unit/helpers/test-db.ts` (it makes every connection `:memory:`, so `getDb()` runs the real open path and `migrate()`) rather than writing a fake SQL matcher.

`tests/fixtures/model-catalog.json` is `src/shared/models.ts`'s catalogs as data; `model-catalog-fixture.test.ts` keeps it equal (regenerate with `SB_UPDATE_FIXTURES=1`) and Android's `NewSessionDecisionsCatalogFixtureTest` checks its copy against it.

### E2E temp-dir cleanup (MANDATORY)

The e2e scripts (`e2e/ide.e2e.mjs`, `e2e/ide-workflow.e2e.mjs`, etc.) create ~600MB temp dirs per run via `mkdtempSync` (`sb-ide-e2e-*`, `sb-ide-wf-*`, `sb-ide-proj-*`, `sb-update*`, `sb-ide-probe*`) and do NOT clean up after themselves - this has filled the entire disk before (600+ leaked dirs, ~18GB). You are welcome to run e2e tests, but after every e2e run (pass, fail, or crash) you MUST delete the leftovers:

```sh
for p in sb-ide-e2e- sb-ide-wf- sb-ide-proj- sb-update sb-ide-probe; do rm -rf "$TMPDIR$p"* /tmp/"$p"*; done
```

Only these prefixes: never `rm -rf /tmp/sb-*`, which also deletes other sessions' live worktrees.

If you touch the e2e scripts themselves, prefer fixing the leak at the source: register a `process.on('exit')` handler that `rmSync`s every `mkdtempSync` dir the script created.

## File structure (condensed)

```
src/
├── server/index.ts                    # Standalone headless backend (WsHost) for remote VMs → out/server/index.cjs
├── main/
│   ├── index.ts                       # Electron main
│   ├── backend/                       # host.ts (BackendHost: ElectronIpcHost | WsHost) · ws-host.ts
│   ├── machines/                      # sshTunnel · connectionManager · provisioner · reconnectBackoff (remote-over-SSH)
│   ├── agent/
│   │   ├── jsonl-parser.ts            # Source-aware (claude-code | codex) + image extraction
│   │   └── jsonl-truncate.ts          # Pure fork truncation (assembleClaudeForkAtEvent)
│   ├── conversations/fork.ts          # Fork-from-message orchestration (per-provider resume)
│   ├── db/
│   │   ├── database.ts                # getDb + migrate(); re-exports the domain modules below, so import from here
│   │   ├── projects.ts · conversations.ts (+ thread ancestry, archive) · messages.ts · settings.ts (+ session layouts) · kanban.ts · bookmarks.ts
│   │   └── provider-instances.ts       # provider_instances CRUD (safeStorage-encrypted env)
│   ├── files/                         # listing (gitignore-annotated) · writing (atomic+conflict) · gitignore matcher
│   ├── git/                           # diffHunks (gutter) · refs · worktreePaths · checkpoint (diff review)
│   ├── ide/                           # code-server-manager · binary (download) · bridge-server (ws)
│   ├── worktree-creation/             # git-adapter.ts - transactional kanban/fork worktree creation
│   ├── worktree.ts                    # worktree list / find-stale / remove (creation lives elsewhere, see above)
│   ├── mcp/                           # Switchboard MCP server: stdio bridge · loopback server · tokens · approval cards · PR + peer tools
│   ├── ipc/
│   │   ├── terminal.ts · app.ts       # PTY · projects/sessions/archive/fork
│   │   ├── files.ts · git.ts · ide.ts · kanban.ts # files + git + IDE + kanban IPC
│   │   ├── provider-instances.ts       # instance LIST/UPSERT/DELETE/TEST/CREATE_OAUTH_DIR
│   │   └── enrich-display-body.ts       # pill/display-body enrichment for stored messages
│   ├── projects/
│   │   ├── session-scanner.ts         # exact-match Claude + Codex scanners (encodeClaudeProjectPath)
│   │   ├── favicon-resolver.ts         # static icon probe (cached by path+mtime)
│   │   └── favicon-html-scan.ts         # <link rel=icon> fallback scan
│   ├── protocol/sb-favicon.ts         # sb-favicon:// custom protocol handler
│   ├── provider/
│   │   ├── provider-registry.ts       # IPC handlers, instance resolution, event forwarding
│   │   ├── turn-submission-results.ts # pure turn-result helpers (legacyAcceptanceResult, rejectedAtomicTurn, ...)
│   │   ├── policy.ts                  # decidePermission/denialMessage/PLAN_READ_ONLY_TOOLS/CUSTOM_UI_TOOLS
│   │   ├── event-bus.ts               # RuntimeEventBus (decoupled fan-out)
│   │   ├── env-overlay.ts             # instance env merge · claude-session-migrate.ts # oauth_dir rotation
│   │   ├── instance-env.ts            # resolveInstanceEnv (shared by Test + usage probes)
│   │   ├── peer-tools.ts              # cross-session tool names/descriptions/handlers + PeerToolHost
│   │   ├── usage/                     # claude-keychain · claude-usage (HTTP) · codex-usage (app-server probe) · index (dispatch/cache)
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
│   ├── services/global-keybindings.ts  # resolveGlobalKeydown: pure keydown → app shortcut action (App dispatches)
│   ├── components/
│   │   ├── CommandPalette.tsx (⌘⇧P) · QuickPromptModal.tsx (⌘K) · SearchModal.tsx (⌘⇧F) · GoToChatDialog.tsx (⌘P)
│   │   ├── SettingsModal.tsx · settings/ProvidersTab.tsx · settings/ProviderUsagePanel.tsx · SessionPickerModal.tsx
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx · ChatInput.tsx · MessageList.tsx · MessageBubble.tsx
│   │   │   ├── provider-event-reducer.ts # desktop provider event → agent-store reducer (ChatPanel's listener)
│   │   │   ├── ChatWorkspacePanels.tsx # primary/secondary ChatPanel slots + ChatSplitHandle
│   │   │   ├── useChatSearch.ts (in-pane ⌘F) · SlashHelpOverlay.tsx · chat-session-settings.ts (mode/model/effort writes)
│   │   │   ├── picker-keydown.ts (send-to/@/slash picker keys) · EffortPicker.tsx (thinking effort, rules in shared/effort.ts)
│   │   │   ├── ApprovalCard · PlanCard · QuestionCard · FileDiffCard · SlashCommandMenu · slash-commands.ts
│   │   │   ├── UnifiedProviderPicker.tsx # agent tabs → instance rail → model search
│   │   │   ├── BranchPicker.tsx + branch-picker-policy.ts · SkillChip
│   │   │   ├── AtMentionMenu.tsx + at-mention.ts · render-pill-body.tsx
│   │   │   └── lexical/               # RichChatTextarea · PillNode · PillChipVisual
│   │   ├── layout/                    # ResizeHandle · ViewToggle (Chats/Board title-bar toggle)
│   │   ├── ide/                       # IdePane (code-server <webview>)
│   │   ├── kanban/                    # KanbanView (⌘⇧K) · CardModal · WorktreeManagerModal · card-launch.ts
│   │   ├── sidebar/                   # Sidebar · ProjectFavicon · WorkspaceManager · dragLogic
│   │   ├── onboarding/               # FeatureTourModal + featureRegistry
│   │   └── terminal/                  # TerminalStrip · TerminalWindow · TerminalPane · TerminalHeader · TemplatePicker
│   ├── hooks/                         # useTerminalLifecycle · useTerminal
│   ├── services/                      # terminal-registry · session-events · contextBridge · fuzzyScore · notifications
│   └── stores/                        # agent · terminal · layout · theme · draft · kanban · provider-instance · skill · bookmark
├── preload/                           # transport.ts (IpcTransport) · ws-transport (via shared) · hybrid-transport · transport-router · routing-table
├── shared/
│   ├── ipc-channels.ts · provider-events.ts · types.ts · auto-title.ts · models.ts · format.ts · file-path-ref.ts
│   ├── provider-usage.ts · claude-usage-parse.ts · codex-usage-parse.ts   # normalised subscription usage limits
│   ├── transport.ts · ws-protocol.ts · ws-transport.ts · machines.ts   # backend transport seam (local ↔ remote)
└── tests/unit/                        # vitest suite (see Test suite)
```

## Logging conventions

Every module that can produce observable side-effects **must** use the scoped logger, not bare `console.*`. This keeps logs filterable, readable in both DevTools and the on-disk log file, and noise-free.

### Performance timing

Use `perfSpan(name, fields?)` from `src/main/perf.ts` or `src/renderer/perf.ts`
and call `end(extraFields?)` once at the measured boundary. Spans use
`performance.now()` and the `perf` logger. Log only identifiers, counts, sizes,
outcomes and durations, never message text, credentials or extra file paths.
`src/shared/perf-timing.ts` owns thresholds: chat open/load 300 ms, switches
1000 ms, IPC 200 ms. Explicit spans use info above the threshold and debug
otherwise; generic IPC records only slow calls. Renderer perf lines reach the
main log through Electron's console forwarding. Run `node scripts/perf-summary.mjs`
to summarize the newest three log files across desktop and headless data
directories, or pass explicit log filenames. Discovery uses platform app-data
paths and honors `SB_USER_DATA` and `SWITCHBOARD_DATA_DIR`; absent log directories
are skipped. History responses carry optional `loadStatus` diagnostics so a
failed load is not counted as a rendered empty chat.
The script prints count, nearest-rank p50/p90, max and the worst five samples.
IPC excludes send-turn, submit-user-turn, respond-to-request, answer-question
and deliver-peer-message because they can wait for a turn or a human answer.

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

- **Quit source**: any new code path that calls `app.quit()` must call `noteQuitSource(kind, detail)` from `src/main/quit-source.ts` first, so the `quit requested` log line names it. An untagged quit logs as `system`.

- **Module-level constant**: `const log = createXxxLogger('scope')` - never inside functions.
- **Scope format**: `'domain:subsystem'` - e.g. `'ipc:files'`, `'store:agent'`, `'ide:pane'`.
- **No silent swallowing**: every `catch` block that doesn't re-throw must `log.warn` or `log.error`. `catch { /* ignore */ }` is a bug.
- **No AI slop patterns**: don't log "successfully did X" on the happy path unless it's a slow/async operation worth tracking. Log state changes, errors, retries, and lifecycle events.

## Writing style

- **No em dashes (U+2014) anywhere** - not in code, comments, UI copy, log messages, commit messages, PR descriptions, or docs. Use a hyphen with surrounding spaces (` - `), a comma, or two sentences instead. This is enforced repo-wide; a stray em dash is a review-blocker. (Arrows and middots are fine.)
