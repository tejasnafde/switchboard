# Switchboard

Electron workspace that multiplexes terminals and agent chats (Claude Code + Codex) into one surface per project.

## Stack

- **Shell**: Electron 33 + React 19 + TypeScript 5.7
- **Build**: electron-vite + Vite 6
- **Terminal**: `@xterm/xterm` 6 + `node-pty` (native, rebuild after install)
- **Agents**:
  - Claude Code via `@anthropic-ai/claude-agent-sdk` (streaming-input mode, AsyncIterable prompt queue, `canUseTool` callback)
  - Codex via `codex app-server` over stdio JSON-RPC 2.0
- **State**: Zustand (`agent-store`, `terminal-store`, `layout-store`, `theme-store`, `draft-store`)
- **DB**: `better-sqlite3` at `~/Library/Application Support/switchboard/data/switchboard.db` (FTS5 enabled)
- **Logger**: file-based in `~/Library/Application Support/switchboard/logs/` with 7-day retention

## Commands

- `npm run dev` — launches Electron (auto-unsets `ELECTRON_RUN_AS_NODE`)
- `npm test` — vitest (~320 tests)
- `npm run test:watch` — vitest in watch mode
- `npm run typecheck` — main + renderer tsc
- `npm run build` — **gated build**: `prebuild` runs typecheck + test before the actual build fires
- `npm run build:fast` — escape hatch, skips the gate
- `npm run rebuild` — rebuild `node-pty` + `better-sqlite3` for Electron

## Build gate (2026-04-20)

`npm run build` fails the entire build if typecheck or tests fail. The `prebuild` npm lifecycle hook chains `typecheck && test` before `electron-vite build`. This caught real regressions on the first run — see CHANGELOG.md.

## Known gotchas

- `ELECTRON_RUN_AS_NODE=1` is set by Claude Code's shell — `dev` script unsets it explicitly
- `electron` MUST be in `devDependencies`, not `dependencies`
- After `npm install`, run `npm run rebuild` for `node-pty` + `better-sqlite3`
- Claude Code encodes project paths by replacing BOTH `/` and `_` with `-` in `~/.claude/projects/`
- Scanner uses **exact dir match** (not substring) — parent paths don't pick up child-project sessions (pre-2026-04-20 bug)
- `canUseTool` overrides the SDK's `permissionMode: 'plan'` — we enforce plan mode explicitly via `decidePermission`
- **macOS TCC for project paths under `~/Desktop`/`~/Documents`/`~/Downloads`**: PTYs and the embedded SDK inherit Switchboard.app's TCC grants. If the user toggles "Files and Folders" on after launching, the running process is still denied — every FS call returns `EPERM` until ⌘Q + relaunch. We mitigate two ways:
  1. `electron-builder.yml` declares `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` / `NSDownloadsFolderUsageDescription` via `mac.extendInfo`, so first access triggers a proper consent dialog.
  2. `src/main/path-access.ts` (`assertCwdReadable`) runs as a pre-flight in `provider-registry`'s `START_SESSION` handler. If the cwd is TCC-protected and `fs.access(R_OK)` returns `EPERM`/`EACCES`, we throw `TccAccessError` with copy that names the cause and the fix. The error surfaces in chat as a system message instead of a deep-stack SDK failure, complete with an inline "Relaunch to Apply Permissions" button.

## Architecture

### Window → Row → Window → Pane model (terminals)

- `Row` = horizontal container (full-width stack of columns)
- `Window` = column within a row; holds stacked panes as tabs
- `Pane` = a single xterm instance (tab inside a window)
- `⌘T` new window in row · `⌘⇧T` new window in new row · `⌘\` new tab in window · `⌘⇧]`/`⌘⇧[` cycle tabs · `⌘1-9` focus window · `⌘⌥+arrows` navigate
- Panes default `cwd` to the active session's `projectPath` (fixed 2026-04-20)
- `terminal-registry.ts` — module-level `Map<id, TerminalInstance>` outside React; panes survive re-renders / panel toggles / StrictMode double-mount
- `PaneResizeHandle.tsx` / `ResizeHandle.tsx` — pointer-capture + rAF drag handles, callbacks in refs to avoid tearing down mid-drag

### Provider bridge (`src/main/provider/`)

- `types.ts` re-exports from `src/shared/provider-events.ts` so renderer can type the IPC boundary
- `ProviderAdapter` interface: `startSession`, `sendTurn(threadId, message, runtimeMode, images?)`, `interruptTurn`, `respondToRequest`, `answerQuestion?`, `setRuntimeMode`, `isAvailable`
- `decidePermission(mode, toolName)` pure policy function — exported + unit-tested
- `PLAN_READ_ONLY_TOOLS` set — Read/Glob/Grep/NotebookRead/WebFetch/WebSearch/TodoWrite allowed in plan mode, everything else denied
- `CUSTOM_UI_TOOLS` — AskUserQuestion + ExitPlanMode skip `tool.started` emission so the custom cards render instead of raw JSON

### Runtime events (wire format)

Defined in `src/shared/provider-events.ts`. Discriminated union:

- `content` · streaming assistant/reasoning/plan text
- `tool.started` · tool call begun (skipped for custom-UI tools)
- `tool.completed` · tool finished
- `tool.denied` · **2026-04-20**: `canUseTool` hard-denied (e.g. Plan mode blocked Write) — UI renders denial pill
- `request.opened` / `request.closed` · approval prompt flow
- `turn.completed` · turn ended, with token usage
- `context_window` · live token count (polled after each turn)
- `plan.proposed` · ExitPlanMode intercept → PlanCard
- `question.asked` / `question.answered` · AskUserQuestion intercept → QuestionCard

### Image pipeline (2026-04-20)

1. User pastes/drags image in `ChatInput` → `ImageAttachment[]`
2. `ChatPanel.handleSend` converts each `File` to data URL via `FileReader.readAsDataURL`
3. `providerApi.sendTurn(..., messageImages)` passes through preload → `provider-registry` IPC → adapter
4. Claude adapter strips the `data:image/png;base64,` prefix and builds `{type:'image', source:{type:'base64', media_type, data}}` content blocks alongside text
5. Codex adapter currently ignores images (Phase B will fix)
6. On JSONL reload, `JsonlParser.extractImages` reconstructs data URLs from image blocks — historical images survive restart

### Question / Plan flow

1. Agent calls `AskUserQuestion` or `ExitPlanMode` (both in `CUSTOM_UI_TOOLS`) — raw `tool.started` is suppressed
2. SDK fires `canUseTool` → our handler intercepts, emits `question.asked` / `plan.proposed`
3. ChatPanel appends a message with `question` or `plan` attachment
4. `MessageBubble` routes to `QuestionCard` (T3-style, numbered shortcuts 1-9, auto-advance) or `PlanCard` (markdown + Implement/Iterate buttons)
5. User answers → `provider.answerQuestion(threadId, requestId, answers)` resolves the blocked Promise
6. `canUseTool` returns allow + `updatedInput` with the answer payload

### Archive system

- `archived INTEGER` column on `conversations` table
- `getArchivedConversationIds()` returns a **global** ID set (not per-project) — fixes pre-2026-04-20 bug where a session listed under two project views would reappear after archiving from only one
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

## What's currently working

- Claude Code SDK integration end-to-end: streaming text, tool calls, context window metrics, interrupt
- Codex app-server integration: basic chat + plan-mode + AskUserQuestion + image support (Phase B done)
- **OpenCode adapter** (2026-04-26): `opencode run --format json` with NVIDIA NIM / Gemini / built-in free tier, dynamic model list via `opencode models`, shell-env probing for API keys, settings-DB key injection, placeholder + heartbeat + 3-min timeout (free-tier-aware error message) for cold-boot UX. Also wires up OpenCode's `debug skill` endpoint to provide dynamically discovered agent skills!
- **OpenCode ACP adapter** (2026-04-28, default): newer Agent Client Protocol variant (`opencode-acp-adapter.ts`), gated by setting `opencode.useAcpAdapter` (default `true`). Legacy CLI adapter (`opencode-adapter.ts`) retained as one-release fallback. Helper: `adapters/opencode/env.ts` for shared env-probing.
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
- **Slash command menu in chat input** with agent-skill exposure (2026-04-26): Claude SDK `init.commands` + Codex `skills/list` surfaced alongside Switchboard's 9 built-ins. Source-grouped sections in the menu; agent-source selections insert `/<name> ` for the user to fill in args. OpenCode has no skill registry — falls back to built-ins only.
- **`⌘L` multi-source context bridge** (2026-04-29): single keybinding routes by the focused element's `data-context-source` attribute (`terminal | file-viewer | chat-message`). Terminal selection → fenced code block w/ pane label header (50k char cap). File-viewer selection → `@<path>:<start>-<end>` pill + fenced block. Chat-message selection → `> from <agent>: "..."` quoted block. All three append to the active session's draft via `useDraftStore.appendDraft`. Pure formatters (`formatTerminalContext`, `formatFileViewerContext`, `formatChatMessageContext`) are unit-tested.
- **Per-turn duration badge** (2026-04-29): adapters stamp `turnStartedAt` on `sendTurn` and emit `durationMs` on `turn.completed`. MessageBubble renders "Worked for X.Xs" under the assistant message via `fmtDuration` from `src/shared/format.ts`. Wired across all 4 adapters (claude, codex, opencode, opencode-acp).
- **Right-pane "Files" mode** (2026-04-29, ⌘⇧E to toggle): the right column flips between the existing terminal strip and a file tree + viewer. `layout-store.rightPaneMode` (persisted under `layout.rightPaneMode`). Both panes stay mounted (positioned overlay) so toggling preserves xterm/pty state and Shiki highlighter cache.
- **File tree pane** with VS Code-style gitignore annotation: `files:list-dir` IPC enumerates a directory and tags each entry with `isGitignored`. Renderer applies `data-gitignored="true"` for 50% opacity but keeps entries clickable. Parsed `.gitignore` cached in main by `(absPath, mtimeMs)` so hot tree expansions don't re-parse. Path-traversal-safe (`resolveWithinRepo` rejects `..`-escapes).
- **File viewer pane** with Shiki highlighting: `files:read-file` IPC enforces a 2 MB hard cap (returns `truncated:true` flag). Highlighter is a module-level singleton (`src/renderer/services/shikiHighlighter.ts`) with concurrent-init coalescing — one WASM cold-start per session, regardless of viewer mount count. Theme-aware (github-dark / github-light follows `theme-store`). Auto-scrolls to line range from `viewerLineRange` when set.
- **Inline file pills in agent messages** (2026-04-29): `MessageBubble` post-process walks rendered markdown DOM; inline `<code>` tokens that match `looksLikeRepoPath()` become clickable chips. Path heuristic in `src/shared/filePathRef.ts` (must contain `/`, must end in `.<ext>` or have `:line[-line]` suffix; rejects URLs and absolute paths to avoid false positives). Click → `layout-store.openInViewer(path, lineRange)` flips right pane to `files` and scrolls. Existence verified via `files:resolve` IPC; non-existent paths revert to plain code.
- **`⌘L` context bridge** (legacy alias retained for the terminal flow inside the multi-source dispatch above)
- **`⌘K` quick prompt**: floating prompt bar that sends a one-shot turn to the active session, optionally pre-fills with current terminal selection
- **Side-by-side dual chat panels** (`⌘|` toggle, `dualChat`/`rightSessionId`/`chatSplitRatio` in layout-store)
- **"Send to other panel"** forward action on messages
- **Status bar** at bottom showing project, agent, status, terminal count
- **System notifications** on `turn.completed` for non-active sessions (`src/renderer/services/notifications.ts`)
- **Export conversation as markdown** (`exportMarkdown.ts` + Sidebar right-click)
- **`⌘F` in-pane search** for terminals (xterm SearchAddon with decoration overlays — requires `allowProposedApi: true`) and individual chat panes (DOM TreeWalker wraps first match in `<mark.sb-search-mark>`); shared `InPaneSearchBar` component, document-level keydown listeners scoped to focused pane via `[data-terminal-pane]` / `[data-chat-panel]` attrs
- **Feature Tour modal** (`FeatureTourModal.tsx` + `featureRegistry.ts`) — auto-opens on first launch and after `TOUR_VERSION` bumps; replayable from Settings → Tour. MP4 clips streamed via `sb-tour://<id>.mp4` custom protocol (resolves to `videos/dist/`, served via `net.fetch('file://...')` for byte-range support)
- **Agent-aware UI labels**: `agentLabel()` / `agentShortLabel()` helpers in `shared/types.ts` so StatusBar / MessageBubble / etc. all reflect Claude Code / Codex / OpenCode correctly
- Single-instance lock
- Native app menu (`⌘,` for settings, standard Edit/View/Window)
- File-based logger at `~/Library/Application Support/switchboard/logs/`
- Workspace YAML parser (runtime hydration on launch)

## What's NOT working yet

- **electron-builder packaging + auto-update** — Phase 9 complete; unsigned macOS arm64/x64 `.dmg`/`.zip` and Windows `.exe`/`.zip` builds shippable via `npm run dist:*`. `electron-updater` wired via `main/updater.ts` (auto-check + manual). Awaiting Apple Developer cert for code-signing only.
- **workspace.yaml hot-reload** + `on_start` wait/then orchestration — partial; runtime hydration works
- **HyperFrames onboarding videos** (Phase D) — `FeatureTourModal.tsx` + `featureRegistry.ts` framework shipped with `sb-tour://` protocol; `videos/dist/*.mp4` artifacts not yet rendered.
- **Cursor import** (read `state.vscdb`) — not started

## Skill exposure (shipped 2026-04-26)

`ProviderAdapter.listSkills?(threadId)` is the seam:
- **Claude adapter** captures `system/init.{slash_commands|commands}` and prefers live `query.supportedCommands()`. Cached on the active session.
- **Codex adapter** sends JSON-RPC `skills/list`, caches result. Older builds get a graceful empty cache (logged, not retried).
- **OpenCode** queries `opencode debug skill` to discover skills.
- IPC: `ProviderChannels.LIST_SKILLS` → `provider:list-skills` (preload `window.api.provider.listSkills(threadId)`).
- UI: `ChatInput` fetches on session start with retry-while-empty (handles late `system/init`); `mergeWithAgentSkills` keeps built-ins first, name-collisions resolve in favor of built-ins so `/clear` always means "clear chat" not whatever a skill named `clear` does. `SlashCommandMenu` renders source-grouped sections + argument-hint suffix. Agent-source selections insert `/<name> ` into the textarea (no special wire path) — the SDK / CLI parses leading slash from the prompt itself.

Pure parsers exported and unit-tested: `parseClaudeSlashCommands` (claude-adapter), `parseCodexSkills` (codex-adapter), `mergeWithAgentSkills` + `skillsToSlashCommands` (slashCommands.ts).

## Test suite (~320 tests)

Run the whole suite: `npm test`. Targeted runs: `npx vitest run tests/unit/<file>.test.ts`. Notable files:

- `message-list.test.ts` — `groupIntoTurns` keeper-list (regression for empty-content attachment drops)
- `slash-commands.test.ts` — slash trigger + registry
- `session-scanner.test.ts` — exact-match matching (parent/child bleed)
- `claude-adapter-plan-mode.test.ts` — plan mode permission policy
- `provider-adapter-tool-filter.test.ts` — `CUSTOM_UI_TOOLS` set membership
- `jsonl-parser.test.ts` — Claude + Codex schemas + historical images

## File structure (condensed)

```
src/
├── main/
│   ├── index.ts                       # Electron main
│   ├── agent/
│   │   ├── agent-manager.ts           # Legacy --print agent (deprecated)
│   │   └── jsonl-parser.ts            # Source-aware (claude-code | codex) + image extraction
│   ├── db/database.ts                 # SQLite schema, archive, FTS, settings
│   ├── ipc/
│   │   ├── terminal.ts                # PTY IPC
│   │   ├── agent.ts                   # Legacy agent IPC (deprecated)
│   │   └── app.ts                     # Projects, sessions, archive, workspace-config
│   ├── projects/
│   │   └── session-scanner.ts         # exact-match Claude + Codex scanners (exports encodeClaudeProjectPath)
│   ├── provider/
│   │   ├── provider-registry.ts       # IPC handlers, event forwarding
│   │   ├── types.ts                   # ProviderAdapter + re-exports from shared/provider-events
│   │   └── adapters/
│   │       ├── claude-adapter.ts      # SDK integration, canUseTool, plan-mode policy, image blocks
│   │       ├── codex-adapter.ts       # JSON-RPC over stdio (Phase B done)
│   │       ├── opencode-adapter.ts    # Legacy CLI fallback (gated by opencode.useAcpAdapter)
│   │       ├── opencode-acp-adapter.ts # Default OpenCode adapter via ACP
│   │       ├── opencode/env.ts        # Shared env-probe helper
│   │       └── question-answers.ts    # Pure helper: shape AskUserQuestion answers for SDK wire format
│   ├── terminal/pty-manager.ts        # PTY lifecycle
│   └── logger.ts                      # File logger
├── preload/index.ts                   # Typed window.api (SwitchboardAPI), strongly-typed provider.onEvent
├── renderer/
│   ├── App.tsx                        # Flat flex-row layout, keybindings, command palette hotkey
│   ├── components/
│   │   ├── CommandPalette.tsx         # ⌘⇧P
│   │   ├── SettingsModal.tsx
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx          # Event dispatch, send handler, slash help overlay
│   │   │   ├── ChatInput.tsx          # Textarea + slash trigger + image picker + mode/model selectors
│   │   │   ├── MessageList.tsx        # Turn grouping (groupIntoTurns exported for tests)
│   │   │   ├── MessageBubble.tsx      # Markdown + tool calls + approval + plan + question + denial pill
│   │   │   ├── ApprovalCard.tsx       # Collapsible JSON detail
│   │   │   ├── PlanCard.tsx           # ExitPlanMode UI
│   │   │   ├── QuestionCard.tsx       # AskUserQuestion UI (T3-style)
│   │   │   ├── SlashCommandMenu.tsx   # Inline / popover
│   │   │   └── slashCommands.ts       # Trigger detector + registry
│   │   ├── sidebar/Sidebar.tsx        # Projects + sessions + dnd + archive button
│   │   └── terminal/
│   │       ├── TerminalStrip.tsx      # Rows of windows with resize handles
│   │       ├── TerminalWindow.tsx     # Window (tabs)
│   │       └── TerminalPane.tsx       # Single pane
│   ├── hooks/useTerminalLifecycle.ts  # Layout hydration from workspace.yaml or defaults
│   ├── services/
│   │   ├── terminal-registry.ts       # xterm instance registry outside React
│   │   └── session-events.ts          # Cross-component event bus
│   └── stores/
│       ├── agent-store.ts             # Sessions + messages (multi-session-aware)
│       ├── terminal-store.ts          # Rows/Windows/Panes
│       ├── layout-store.ts            # Sidebar/terminal widths + visibility
│       ├── theme-store.ts             # Active theme
│       └── draft-store.ts             # Per-session unsent drafts (localStorage)
├── shared/
│   ├── ipc-channels.ts                # Channel name constants
│   ├── provider-events.ts             # RuntimeEvent union (wire format)
│   ├── types.ts                       # ChatMessage, Session, Project, MessageImage, denial?
│   ├── auto-title.ts                  # generateTitle from first message
│   └── models.ts                      # Model catalog per agent
└── tests/unit/                        # ~320 tests
```
