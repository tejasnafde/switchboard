# Changelog

All notable changes across Switchboard development sessions. Reverse-chronological.

## 2026-06-24 — Focus-scoped keybindings + editor shortcuts

### Fixed
- **`⌘W` no longer kills a terminal (or its SSH session) from the editor.** It was a single global handler that always closed a terminal pane. It's now routed by focus: editor → close the active editor tab and stop; chat panel (dual) → close that panel; else terminal tab → app window.
- **Back/forward navigation (`Ctrl±`) was flaky** — the focus guard failed after a jump. The editor now takes focus after navigating, so editor-scoped keys keep working without an extra click.
- **Diff-card color cutoff** — the +/- row background now spans the full horizontal scroll (`width:max-content; min-width:100%`) instead of clipping at the visible width.

### Added
- **`F12`** → go to definition at the cursor (reuses the LSP → `git grep` resolver).
- **`Ctrl+G`** → go to line (VS Code's macOS binding; `⌘G` stays find-next).
- **`docs/keybindings.md`** — full reference. Documents that comment-toggle `⌘/`, move/copy line `⌥↑↓`/`⇧⌥↑↓`, and multi-cursor `⌘D` already ship via CodeMirror's bundled keymaps.

### Internal
- Shortcuts are now **scoped by focus** (editor / terminal / global) — editor-concept keys live in the CM6 keymap, only app-concept keys touch the global layer. Shared `closeEditorTab()`; pure, unit-tested `classifyCloseFocus()`. Suite: 887 → 892.

---

## 2026-06-24 — File-editor bug sweep, jump-to-definition UX, SSH plan

### Fixed
- **Symlink path-traversal in the files IPC** — `resolveWithinRepo` was lexical only; a symlink inside the repo could read/write/delete outside it. Now resolves the realpath of the nearest existing ancestor and re-checks containment.
- **UTF-8 read boundary** — `readFileCapped` sliced mid-codepoint at the 2 MB cap, emitting `U+FFFD`. Uses `StringDecoder` to drop the partial trailing codepoint instead.
- **gitignore annotation** — added `**` cross-segment matching and case-insensitive matching (mirrors `core.ignorecase` on macOS/Windows).
- **EOL preservation on save** — majority-vote CRLF/LF detection (a leading bare `\n` no longer flips a CRLF file to LF); lone `\r` normalized.
- **Tab-switch lost undo history** — editor now swaps whole `EditorState`s (`setState`) instead of replacing the doc, so undo no longer bleeds across buffers.
- **Jump-to-line was dead** — cmd-click / file-pill / ⌘P-line navigation wrote to the store but never moved the editor; `EditorHost` now dispatches the scroll into the live view (fixes cmd-click go-to-definition visibly doing nothing, including cross-file jumps).
- **Git gutter stayed stale after save** — added `lineMarkerChange` so the bars repaint on the post-save hunks refresh.
- **Save-conflict silently dropped** — ⌘S on a file changed on disk now prompts overwrite / reload instead of swallowing the write.
- **Nav history** — `openInViewer` is the single push point (no more double-push from `navigateTo`); back/forward replays pass `recordHistory:false` so the forward stack isn't truncated.
- **LSP crash recovery + didClose** — the client nulls its dead child and the manager evicts the entry on exit so the next call respawns; `textDocument/didClose` is now sent on tab close (was never sent — leaked docs / stale results).
- **Worktree-mode file browsing** — file tree + quick-open now use `worktreePath ?? projectPath` like the viewer (kanban-card / fork-to-worktree sessions browsed the parent repo before).
- **Monotonic diff turn id** — `CheckpointTracker` used `Date.now()`, so two turns in the same millisecond collided and dropped diff cards; switched to a counter.
- **Markdown-preview XSS** — README preview is sanitized with DOMPurify before `dangerouslySetInnerHTML`.

### Added / improved
- **⌘/Ctrl-hover underline** on the symbol under the cursor (VS Code-style affordance for cmd-click).
- **`git grep` go-to-definition fallback** — when LSP can't resolve (cold server or non-LSP language), grep the repo for the declaration. The previously-advertised tree-sitter fallback was a never-populated stub. New `files:grep-symbol` IPC.
- **Quick-open ranking** — `fuzzyScore` leading-gap penalty so basename-prefix matches outrank buried ones.
- **`$/cancelRequest`** — superseded same-method LSP requests are cancelled so the server stops computing discarded results.
- **SSH "Connect to Remote" implementation plan** (`docs/notes/ssh-remote-plan.md`).

### Tests
- +24 unit tests across 4 new files (file edge-cases, nav history, fuzzy score, git-grep) plus diff/checkpoint/editor/definition-provider additions. Suite: ~790 → 887.

---

## 2026-06-10 — Fix leaked `claude` subprocesses on session stop

### Fixed
- **Claude sessions leaked a live `claude` CLI subprocess every time they were stopped.** Each `sdk.query()` spawns a child `claude` process; `stopSession` closed the prompt queue and aborted the `AbortController` but never called `query.close()`, so the SDK kept its spawned child alive. Closing a tab, archiving a chat, or rotating a provider instance abandoned the subprocess instead of reaping it — they accumulated as children of the Switchboard app (observed: ~15 orphaned `claude` processes parented to one multi-day app session). `stopSession` now calls `active.query.close()` (the SDK's documented "terminate the underlying process … including the CLI subprocess") inside a try/catch with `log.warn`, before clearing session state. `stopAll` (app quit) inherits the fix since it loops `stopSession`.
- **Downstream symptom:** the abandoned subprocesses could each grab `~/.claude/.update.lock` during a background version check and then never release it, wedging `claude update` behind a stale lock.
- **In practice the leak fired on archive.** Switchboard has no "close tab" flow — `stopSession` runs on archive, auth/agent rotation, and app quit. Archiving a conversation reaped its UI state but left the subprocess alive, so archived chats accumulated live processes.
- **Guarded the `startDraining` retry path:** force-closing the subprocess surfaces as "process exited with code N", which matched the resume-failed retry branch and could respawn a fresh query (with an unclosed prompt queue) *after* the session was stopped — re-leaking a process. The catch now bails when the session is no longer the active one for its thread.
- 6 new unit tests (`claude-adapter-stop-session.test.ts`): asserts `query.close()` is called, abort + prompt-queue close still happen, the session is removed from the registry, `close()` throwing is tolerated, and `query === null` / unknown-thread are safe no-ops.

---

## 2026-06-02 — In-chat diff review (Cursor-style accept/reject) + editor/file-tree fixes

### Added
- **Per-file diff cards in chat, with per-hunk accept/reject** — when an agent edits files during a turn, each changed file renders as its own inline card showing the unified diff with **Keep all / Reject all**, per-hunk **Revert**, and **Apply**. Works identically across **all three providers** (Claude Code, Codex, OpenCode) because the diff is derived from **git checkpoints**, not provider-specific tool payloads: a temp-index snapshot (`git add -A` → `write-tree`, never touching the user's index/HEAD) is taken before each turn and diffed against the working tree after `turn.completed`. Provider-agnostic, deterministic, modeled on the open-source `t3code` approach. New modules: `src/main/git/checkpoint.ts`, `src/main/provider/checkpoint-tracker.ts`, `src/renderer/components/chat/FileDiffCard.tsx` + `fileDiffResolve.ts`; new `file.edited` runtime event.
- Diff rendering + accept/reject math is powered by **`@pierre/diffs`** (Apache-2.0). Reject reverts a hunk to its baseline; partial accept writes the resolved subset back via the existing atomic `files:write-file`. **Rejecting an agent-*added* file deletes it** (new `files:delete-file` IPC) rather than leaving an empty file — matching Cursor's revert semantics.
- 30 new unit tests (checkpoint primitives incl. a real-git integration test, the turn tracker, the resolve/row helpers, the message keeper-list, and `deleteFileSafe`).

### Fixed
- **File viewer loaded the first-opened file blank**, then re-selecting its tab did nothing and showed a phantom unsaved dot. Two compounding `EditorHost` lifecycle bugs: the view-recreate cleanup didn't reset the mounted-buffer marker (so a remount skipped loading the buffer into the fresh empty view), and the buffer-swap set that marker *after* dispatching — so the view's round-trip wrote the new file's content back over the *previous* buffer, corrupting it and flagging it dirty. Marker is now cleared on teardown and set before the swap dispatch.
- **CodeMirror search panel (⌘F) was unstyled** under the translucent/light/dark themes — raw browser buttons, checkboxes, and an orange focus ring. Now themed via CSS variables, laid out with flex (stable two-row layout that doesn't reflow awkwardly on pane resize, pinned close button, checkbox-label spacing), and Escape reliably closes it.
- **gitignore annotation** mishandled patterns containing a mid-slash (`foo/bar` matched at any depth instead of anchoring to root).
- **Silent error swallowing** removed across `EditorHost`, `FileTreePane` (now shows a "couldn't read folder" state), `FileViewerPane`, `cmdClickJump`, and the LSP frame parser — each now logs via the scoped logger per the repo's logging rules. Also fixed a ⌘-click jump-to-definition race that could navigate the wrong session.

### Notes
- Diff cards are **session-ephemeral** (v1): they live in the live session and aren't restored on reload; disk already reflects the user's decisions. Files ignored by `.gitignore` (including a file ignored by a same-turn `.gitignore` edit) don't produce a card — intentional, to avoid cards for build output / `node_modules`.

---

## 2026-05-04 — Sidebar archive button: anchor instead of overlap-with-time

### Fixed
- **Clicking the sidebar archive icon did nothing**, though right-click → "Archive" from the context menu worked. The icon was inserted into the row's flex flow with `margin-left: -18px` so it overlapped the adjacent `.sidebar-thread-time` element; on hover the time element collapsed via `width: 0` while the icon's margin snapped to 0. Because `.sidebar-thread-time` kept `overflow: visible` (so its text could keep painting during the opacity fade) the click target flickered across the layout transition and a click on the visible icon often landed on residual time-text rendering before the button's hit area resolved. Right-click bubbled to the row's `onContextMenu` regardless and was unaffected. Fix: anchor the archive button with `position: absolute; right: 8px` so it has a single, stable hit area; add `pointer-events: none` to `.sidebar-thread-time` on hover (it's just text — never a click target — and `none` while collapsed keeps it from intercepting clicks meant for the button); add `pointer-events: none` to the SVG so clicks on the icon's hollow centre don't fall through `pointer-events: visiblePainted`. `z-index: 1` on the button is belt-and-braces.

---

## 2026-05-04 — Fork to worktree

### Added
- **"Fork to worktree"** in the chat message right-click menu — same flow as "Fork from here", plus a `git worktree add -b fork/<slug> <repo>/.switchboard/worktrees/<slug> HEAD` runs first so the new conversation is rooted at an isolated working tree on its own branch. Slug derives from the picked message body via `makeBranchSlug` (lower-case, alnum-or-dash, capped at 40 chars, prefixed `fork/`). On a successful fork the chat surfaces a "Forked to fork/<slug>" toast, the sidebar title becomes `<parent> · fork/<slug>`, and the Claude SDK's resume / terminal panes / file pane all pick up the worktree as cwd via the existing `projectPath` plumbing (no extra wiring needed downstream).
- **Collision handling**: branch / dir collisions retry with `-2`, `-3`, … suffixes (capped at 20 attempts) so two forks of the same message coexist; non-collision errors (unknown ref, shallow repo) bail immediately with the verbatim git stderr.
- **DB**: nullable `worktree_path` + `worktree_branch` columns on `conversations`; persisted iff the fork opted into a worktree. Existing rows stay valid without a backfill.
- **Test seam**: `forkConversation` accepts an optional `gitRunner` so the fork→worktree path can be unit-tested without shelling out to real git. 6 new tests in `tests/unit/worktree.test.ts` cover the happy path, collision retry, non-collision fail-fast, relative-path / empty-slug rejection. 12 tests in `tests/unit/branch-slug.test.ts` cover the slug rules (case, dash collapsing, mid-cut trim, empty fallback).
- The Claude fork path now writes the truncated `<newId>.jsonl` to `~/.claude/projects/<encoded-effective-path>/` (the worktree's encoded dir for worktree forks; same as before for plain forks) — without this, a worktree-rooted fork would resume from the wrong project dir and lose context.

### Notes
- v1 derives the branch slug deterministically from the picked message body, not via an LLM summary call. The kickoff doc named `summarizeForBranchName` as a follow-up; deferred until we want the branch names to read more naturally (e.g. "fix-redis-timeout" vs. "fix-the-redis-timeout-i-was-seein"). The deterministic path has zero added latency and no API key dependency.
- Cleanup ("Delete worktree" UI when a forked conversation is archived) deferred — `git worktree list` + `git worktree remove` still work from a terminal.

---

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
