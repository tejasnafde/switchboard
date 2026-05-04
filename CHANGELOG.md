# Changelog

All notable changes across Switchboard development sessions. Reverse-chronological.

## 2026-05-04 — Fork from here

### Added
- **Right-click any chat message → "Fork from here"** to spawn a new chat tab containing every message up to and including the one you clicked. The new conversation is wired to the agent's resume primitive: for Claude Code we truncate the source `~/.claude/projects/<encoded>/<uuid>.jsonl`, write a fresh `<new-uuid>.jsonl` next to it (with each line's `sessionId` rewritten to the new UUID), and pass the new id as `resumeSessionId` so the SDK picks up real context — not just visual continuity. Codex falls back to "best-effort" (writes a truncated rollout file as an audit record but starts the daemon cold; TODO to pipe through Codex's `session/start` JSON-RPC). OpenCode is summary-only with a TODO for ACP `session/load`.
- **Lineage in DB**: new nullable `parent_conversation_id` + `forked_at_message_id` columns on `conversations`. Sidebar arrow/indent UI is deferred (out of scope for v1) but the data is there for future audit + bulk-fork flows.
- **Pure JSONL truncation functions** in `src/main/agent/jsonl-truncate.ts` (`truncateClaudeJsonl` / `truncateCodexJsonl` / `assembleClaudeFork`) — visibility-aware, replicate JsonlParser's predicate so non-visible meta lines (Claude `summary`, Codex `session_meta` / developer prompts) ride along verbatim and the truncated file still loads cleanly. `assembleClaudeFork` walks all chronological fragments so threads spanning multiple JSONL files (Claude SDK rotates `session_id` during compaction) are forked correctly. 11 unit tests covering anchor capture, sessionId rewrite, malformed-line skip, over-/under-cap, and multi-fragment cuts.
- **Position-based fork contract**: the IPC takes `upToIndex` (renderer's array position) instead of a message id — JsonlParser regenerates ids on every reload, so id-based lookup never matched. The renderer's message order matches the parser's emission order for both Claude and Codex (same visibility predicates), so position survives a re-parse. The original id rides along as `forkedAtMessageId` for audit / lineage only.
- **Dual-chat correctness**: `MessageBubble` accepts a `sessionId` prop wired from `MessageList`, so right-clicking the right panel forks the right session instead of whichever pane holds focus.
- **Non-resumable fork notice**: Codex / OpenCode forks (which can't yet resume real context) get a synthetic system message prepended in the new tab so users aren't misled into thinking the agent has the prior turns.
- IPC: `app:fork-conversation` handler in `src/main/ipc/app.ts`, orchestration in `src/main/conversations/fork.ts`, renderer service in `src/renderer/services/forkSession.ts`, popover UI in `MessageBubble.tsx`. Concurrency guard: refuses to fork while the source session has a turn in flight.

---

## 2026-05-02 — Kanban promoted to top-level view

### Changed
- **Kanban is no longer a right-pane mode**. It's now a top-level alternate view that swaps the chat + right-pane area for a workspace-scoped board, with the sidebar still mounted (and ⌘B still hiding it). The card *is* the unit of work; making the user "be in a chat" to see the board was backwards.
- **⌘⇧K** now toggles `appView: 'chats' | 'kanban'` instead of jumping the right pane to a per-session kanban. Persisted under `layout.appView`.
- **⌘⇧E** is back to a 2-mode toggle (`terminal ↔ files`). Legacy persisted `'kanban'` value migrates to `'terminal'`.
- **Workspace + project filters** in the toolbar drive scope. Default is "All workspaces"; selecting a workspace narrows to its projects, and a further project filter drills down to one. Filters are persisted under `layout.kanbanWorkspaceFilter` / `layout.kanbanProjectFilter`. Changing the workspace filter clears any stale project filter under the previous workspace.
- **Cross-project board** unions cards from every in-scope project; tiles show the project basename so the wide view stays legible. Card hydration runs per-project via the existing IPC — N round-trips on first paint, but kanban-store dedupes so toggling scopes doesn't re-fetch.
- **Sidebar session click** drops back to chats view automatically (and so does `+ New Chat`), so the user lands in the conversation they just clicked instead of staring at the unchanged board.
- `KanbanPane.tsx` deleted; replaced by `KanbanView.tsx` mounted as a top-level sibling of the chat + terminal stack (see follow-up below).

### Fixed (later same day)
- **No more overlay bleed-through.** First cut mounted the kanban as an absolute-positioned overlay with `background: var(--bg)`, which is *transparent* in the translucent theme — the chat UI showed through. Restructured to a true view swap: chat + terminal stack and `<KanbanView />` are siblings, and we toggle `display: none` on whichever isn't active. Same pattern as the right-pane terminal↔files toggle, so PTY + xterm + Shiki state still survives. (User feedback: "shouldnt the uis be swapped... it looks like we are overlaying the board on top of the chat".)
- **Visible "Chats / Board" toggle in the title bar** (right of the Switchboard wordmark, left of the gear). Mirrors ⌘⇧K — discoverability for users who don't know the shortcut. The kanban is a top-level mode of the app, not a side pane: PM view ↔ engineering view.

### Added (later same day)
- **Tour clip for the two-mode swap.** New `kanban-view` step in `FEATURE_TOUR_STEPS`, slotted right after `welcome` so the app's two top-level modes are introduced before any chat-specific feature. `TOUR_VERSION` bumped to `2026-05-02` so existing users auto-see it on next launch. HyperFrames scene at `videos/scenes/kanban-view/index.html`, rendered MP4 at `videos/dist/kanban-view.mp4`.
- **Drag-and-drop column moves** (`@dnd-kit/core`). Tiles are draggable across columns; the destination column highlights with an accent border, and the dropped card lands in the new column on the same frame the overlay disappears. `kanban-store.move()` is now optimistic (cache patched synchronously, IPC follows) so drag feels instant — backed by 2 unit tests covering the synchronous patch + the no-such-card no-op. PointerSensor activation distance of 5px keeps clicks (open the edit modal) distinct from drags.
- **AskUserQuestion auto-promotes a card to `needs_input`.** When an agent calls AskUserQuestion (Claude or Codex), the runtime's `question.asked` event handler in ChatPanel looks up the linked card via `kanbanStore.findByConversationId(threadId)` and flips status `in_progress → needs_input`. `question.answered` flips it back. The `needs_input` column finally has a population mechanism — previously it was a manual label nothing in the runtime ever set. Symmetric, idempotent; we deliberately don't auto-flip cards that aren't currently in_progress (backlog/done were placed there intentionally).
- **Live tile state** — the per-card session pip now subscribes to `agent-store` and renders a green pulse for `running` / `thinking`, a static dot for `idle`, and red for `error`. An accent "N new" unread badge surfaces `session.unreadCount`. Pulse animation lives in `global.css` as `@keyframes sb-kanban-pulse` (distinct from the typing-indicator pulse so we can tune the ring color independently).

### Fixed (later same day, follow-ups)
- **CardModal now shows the project association** as a chip at the top of the body, or as a picker when create-mode scope spans multiple projects. Edit mode locks the project — moving a card across projects would invalidate worktrees and conversation links.
- **Filter dropdowns are no longer empty on toggle.** `KanbanView` was being unmounted every time the user flipped to chats view; remount re-fired `getProjects` + `workspaces.list` and the dropdowns rendered empty until IPC returned. Both views are now always-mounted (display:none on the inactive one), matching the right-pane terminal↔files pattern.

---

## 2026-05-02 — Kanban v1 + worktrees + main-process hardening

### Added
- **Kanban board** (right pane, ⌘⇧K). Per-project task cards with title / description / comma-tags / status / cost ceiling. Four columns: Backlog, In progress, Needs input, Done. Cards persist in SQLite (`kanban_cards` table) and round-trip through IPC — no optimistic updates, since human-paced mutations don't need them and the failure modes are easier to reason about with a single source of truth in main.
- **Per-card git worktrees**. Opt-in checkbox at create time spawns `git worktree add -b kanban/<slug>-<shortId> .switchboard/worktrees/<slug>-<shortId> HEAD`. Cards expose Attach / Detach buttons in the edit modal. Branch deletion on remove is namespace-guarded (only `kanban/*` branches get pruned — user-created branches are left alone).
- **Card → session start**. Click a card's ▶ button to spawn a chat whose `projectPath` is the card's worktree (or the project root if no worktree). Terminal panes spawned inside that session and the file tree / viewer all root themselves at the worktree automatically — no extra plumbing in the lifecycle hook. Card → conversation linkage is patched on first start so subsequent clicks jump (↗) instead of duplicating.
- **Worktree manager modal** (⎇ Worktrees button on the kanban toolbar). Lists every worktree git knows about, tags each as linked / orphaned / prunable / stale, and offers per-row remove + a "Clean up N stale" footer action. Stale = git-prunable, missing on disk, or orphaned (no kanban card).
- **Right-pane mode `'kanban'`**. `layout-store.toggleRightPaneMode` now cycles `terminal → files → kanban → terminal`. Persisted in settings.
- **`RuntimeEventBus`** in `src/main/event-bus.ts` — EventEmitter-backed pub/sub for adapter → renderer event flow. Decouples adapters from `provider-registry` and gives tests a clean injection seam (6 unit tests).
- **`stopSession` on tab close** — `agent-store.removeSession` now fires `provider.stopSession(id)` before dropping renderer state. Prevents leaked Codex app-server / OpenCode ACP / Claude SDK loops that previously held cwd / file handles / sockets until app exit.
- **Unhandled-rejection logger** in `src/main/index.ts` and **rejection logging** across Claude / Codex / OpenCode adapters and `provider-registry`. Replaces `.catch(() => {})` swallow points that hid real errors.

### Changed
- `removeWorktree` falls through to `git worktree prune` when the directory was manually deleted, so the metadata cleans up either way.
- New IPC: `kanban:list / create / update / delete / create-worktree / remove-worktree / list-worktrees / list-stale-worktrees / remove-stale-worktree`. The path-based stale removal refuses to operate outside `<projectPath>/.switchboard/worktrees/` to neutralise a malformed renderer call.

### Why
Cards-with-worktrees gives parallel agentic work without the test/checkout collision that branches-in-place suffer. Cleanup UI matters because every iteration leaves a worktree behind, and a stale-worktree avalanche is a hostile first run for a returning user. Event-bus + rejection logging are the same lesson learned twice: silent failures eat days of debugging time, the fix is cheap, ship it before it bites.

---

## 2026-05-02 — Deslop ESLint pre-commit

### Added
- **`eslint.config.mjs`** (flat ESLint 9 config, deslop-focused). Four rules: `@typescript-eslint/no-explicit-any`, `no-useless-catch`, `no-else-return`, `no-useless-rename`. Deliberately tight scope — every additional rule is a tax that invites `--no-verify`.
- **lint-staged + pre-commit hook**: `npx lint-staged` runs eslint with `--max-warnings=0` on staged `src/**/*.{ts,tsx}` only. New `as any` casts and other tells fail the commit; pre-existing slop in unmodified files is untouched.
- **`scripts/pre-commit.sh`** (checked into the repo) and **`scripts/install-hooks.mjs`** (runs as `prepare` lifecycle on `npm install` to copy the hook into `.git/hooks/`). Future clones get the hook automatically.
- **`npm run lint:deslop`** for ad-hoc full-tree audits — exposes deslop debt to drive toward zero.

### Known debt
- **64 pre-existing `no-explicit-any` violations** across 27 files (top offenders: codex-adapter 10, opencode-acp-adapter 9, claude-adapter 8, sidebar 7). Will be cleaned up in a follow-up commit. Until then, edits to those files will block on commit — fix the local violations or add `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- <reason>`.

### Why
Mechanical AI-noise (defensive `as any`, useless try/catches, `else return`) accumulates faster than reviewers can catch it. ESLint can't tell good code from bad, but it CAN tell mechanical noise from non-noise. Use it for what it's good at; leave the judgement calls to `/review` and `/simplify`.

---

## 2026-05-02 — OpenCode legacy adapter retired

### Removed
- **`opencode-adapter.ts`** (911 lines, the `opencode run --format json` shell-out variant) deleted. The ACP-based adapter has been default since 2026-04-28 and is now the only path.
- **`opencode.useAcpAdapter` setting** removed (was: gate flag, default `true`). Existing values in the settings DB are inert and harmless.
- **Settings → OpenCode → Adapter** toggle removed from `SettingsModal.tsx`.

### Changed
- `provider-registry.ts` simplified: dropped `resolveOpencodeAdapter()` indirection; the OpenCode entry in the adapter map points directly at the ACP instance. `OPENCODE_LIST_MODELS` IPC handler now calls the ACP adapter directly.
- `opencode-acp-adapter.ts` header comment updated to reflect retirement (no longer "replaces" — it replaced, past tense).
- `CLAUDE.md` "What's currently working" + file structure updated.

### Why
The ACP adapter has been default for a release with no fallback complaints. Live-streaming tool progress, real plan mode, permission RPCs, image input, and inline model catalog made the legacy CLI fallback obsolete. Carrying 911 lines of dead code (plus its toggle UI and IPC indirection) was pure tax on every refactor.

---

## 2026-04-20 — Phase A (docs, UX polish, slash commands)

### Added
- **Slash command menu**: type `/` at start of a line in chat to open an inline popover. v1 commands: `/plan`, `/sandbox`, `/edits`, `/full`, `/clear`, `/archive`, `/image`, `/stop`, `/help`. Keyboard-only: ↑↓/Enter/Esc in the menu, typing filters the list live. Trigger detector is a pure function with 11 regression tests to lock down mid-line vs line-start semantics.
- **Plan-mode denial pill**: when `canUseTool` hard-denies a tool (e.g. Plan mode blocked Write), a red-bordered pill appears in the chat stream with the tool name + reason. Previously only the agent's prose reaction surfaced the block.
- **ApprovalCard collapsible detail**: tool-input JSON wraps in `<details>` with a smart one-line summary (command / file_path / first key). Long JSON no longer hides inside a 160px scrolling box.
- **Historical images reconstruct from JSONL**: `JsonlParser.extractImages` rebuilds `MessageImage[]` from Claude's `image` content blocks. Previously, images attached via Switchboard would disappear after app restart because the parser dropped non-text blocks.
- **Source-aware JSONL parser**: `JsonlParser` takes a `source: 'claude-code' | 'codex'` arg. Codex sessions (with `response_item`/`event_msg` events instead of Claude's `assistant`/`user`) now load their messages. Imported Codex chats previously showed titles in the sidebar but zero messages.
- **Typed wire events**: `RuntimeEvent` union moved to `src/shared/provider-events.ts` so preload + renderer share the same discriminated union. `window.api.provider.onEvent` is now typed — no more `as any` casts in ChatPanel/App.

### Changed
- `src/preload/index.ts` — `provider` methods typed against `RuntimeMode`, `ApprovalDecision`, `StartSessionOpts`. Removed unused `any` boundaries.
- `src/renderer/components/chat/ChatPanel.tsx` — dropped legacy `--print` agent fallback; all traffic goes through the provider bridge.

### Fixed
- Multiple real bugs surfaced by enabling the gated build (typecheck + test + build):
  - `CommandPalette.tsx` was calling `addPane` / `addRow` — both removed in the terminal refactor. Palette items "New Terminal Pane" and "New Terminal Row" had been silently broken since. Now wired to `addPaneToActiveWindow` + `addWindow`/`splitActiveWindow` with `cwd`.
  - `claude-adapter.ts` could call `CUSTOM_UI_TOOLS.has(undefined)` when `block.name` was absent. Added null guard.
  - `provider-registry.ts` Map literal was inferring as a union rather than `Map<ProviderKind, ProviderAdapter>` — added explicit generic.
  - `SearchModal.tsx` `useRef<Timeout>()` without initial value; added null initializer + guard on `clearTimeout`.
  - `App.tsx` + `ThemeSwitcher.tsx` had `WebkitAppRegion: 'no-drag' as any` — added global CSSProperties augmentation in `env.d.ts`, removed casts.

### Infrastructure
- **Build gate**: `npm run build` now chains `prebuild → typecheck → test → build`. Build fails if typecheck or tests fail. Escape hatch: `npm run build:fast`.
- **+60 tests** (~130 → ~190):
  - `tests/unit/slash-commands.test.ts` (18) — trigger detection + registry
  - `tests/unit/jsonl-parser.test.ts` (+11) — Codex source + historical images
  - `tests/unit/message-list.test.ts` (+1) — denial message keeper
  - `tests/unit/session-scanner.test.ts` (+6) — exact-match cases
- **Docs rewrite**: this file (`CHANGELOG.md`), `CLAUDE.md` rewritten to match reality, docs/plan.md status updated.

---

## Earlier sessions (pre-CHANGELOG)

### 2026-04-20 AM — Plan mode + tests expansion

- Extracted `decidePermission` / `PLAN_READ_ONLY_TOOLS` / `CUSTOM_UI_TOOLS` as pure exported functions from `claude-adapter.ts`
- Added `tests/unit/claude-adapter-plan-mode.test.ts` (12) and `tests/unit/provider-adapter-tool-filter.test.ts` (5) — locking down plan-mode policy and the custom-UI tool allowlist
- Fixed **plan mode writing to disk** — previously fell through to the generic approval prompt; now hard-denies all non-read-only tools
- `MessageList.groupIntoTurns` now exported + tested; fixed regression that dropped messages with only `question` / `plan` / `image` attachments
- `session-scanner.ts` exports `encodeClaudeProjectPath` + `isClaudeDirForProject` for testing; scanner uses exact dir equality (was substring match, caused parent/child session bleed)
- `getArchivedConversationIds()` returns a global set — archive filter now robust against same session appearing under multiple project paths

### 2026-04-20 — Image pipeline (end-to-end fix)

Images in chat were captured in the UI and saved to DB but **never sent to the agent**. Traced the gap and wired all four layers:
- `ChatPanel.tsx:384` passes `messageImages` to `sendTurn`
- `preload/index.ts` `sendTurn` signature now accepts images
- `provider-registry.ts` IPC handler forwards images to the adapter
- `claude-adapter.ts` strips `data:…;base64,` prefix and constructs SDK `image` content blocks alongside text

### 2026-04-20 — QuestionCard rewrite + tool filter

- Rewrote `QuestionCard.tsx` in T3-Code style: one question at a time with `i/N` pagination, number shortcuts 1-9, single-select auto-advance 200ms, multi-select waits for Next
- Suppressed `tool.started` emission for `AskUserQuestion` and `ExitPlanMode` (raw JSON tool block was rendering alongside the custom card)

### 2026-04-20 — Archive bug (two root causes)

- Scanner was using `dir.includes(encoded)` — substring match caused parent project `/Users/foo/ssg` to pick up sessions from child `/Users/foo/ssg/sub`
- Archive filter was per-project (`getConversationsForProject(path)`) — archiving from one view didn't hide the session from the other
- Fixed scanner to exact match + archive filter now queries a global set of archived IDs

### 2026-04-20 — Terminal cwd defaults

Panes created via `⌘T`, `⌘⇧T`, `⌘\`, and the "+" buttons defaulted to electron's cwd (the switchboard dir) instead of the active session's project path. Fixed across `App.tsx` keybindings, `TerminalStrip.tsx` toolbar, `TerminalWindow.tsx` per-tab +, and `CommandPalette.tsx`.

### Earlier — Major infrastructure (pre-April)

- Tmux-style terminal panes: rows of windows holding stacked pane tabs; keyboard nav, splits, resize handles
- Claude SDK streaming-input integration via `AsyncIterable<SDKUserMessage>` prompt queue
- `canUseTool` callback + `setPermissionMode` for live runtime-mode updates
- File-based logger with 7-day retention
- Single-instance lock
- Translucent theme with macOS vibrancy
- Archive/unarchive conversations
- FTS5 full-text search over message bodies
- Drag-to-reorder projects via `@dnd-kit`
- Context window meter from live SDK polling
- Session resume via `--resume <session-id>`
- Pre-commit hook runs tests
- GitHub Actions CI (typecheck + test + build on push/PR)
