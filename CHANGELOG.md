# Changelog

All notable changes across Switchboard development sessions. Reverse-chronological.

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
