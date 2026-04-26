# Switchboard: 0 → 100 Implementation Plan

> From empty repo to shippable product. Each phase builds on the last.
> Refer to `concept.md` for the full vision and architecture rationale.
> Day-to-day status and rationale live in `CLAUDE.md` + `CHANGELOG.md`.

---

## Current status (2026-04-26)

The phase checkboxes below are the original day-1 spec and are kept as a
historical reference rather than a live progress tracker. Here's what's
actually shipped:

| Phase | Status | Notes |
|---|---|---|
| 0 — Skeleton | ✅ Done | Electron + React + Vite, hot reload, CI (typecheck+test+build) |
| 1 — Terminal Engine | ✅ Done | Row/Window/Pane model (tmux-style), splits, keyboard nav, resize |
| 2 — Agent Bridge | ✅ Done | Claude SDK streaming-input; Codex app-server JSON-RPC |
| 3 — Context Bridge | ✅ Done | `⌘+L` (terminal selection → chat draft) + `⌘+K` (quick prompt) shipped |
| 4 — Conversation History | 🟨 Partial | Claude + Codex importers working; Cursor import not started |
| 5 — workspace.yaml | 🟨 Partial | Parser + launch-time hydration works; hot-reload + `on_start` wait/then not done |
| 6 — Multi-Agent | ✅ Done | Both adapters at parity (image/plan/approval); side-by-side dual chat panels (`⌘\|`) shipped |
| 7 — Polish & UX | ✅ Done | Theme system, design system, command palette, keyboard-first nav, project switcher, status bar, system notifications, feature tour, ⌘F in-pane search all done. (Vim-nav for terminals still open.) |
| 8 — Persistence | 🟨 Partial | Workspace state + conversation persistence + FTS search done. Reconnect to running PTYs not done. |
| 9 — Distribution | 🟨 In progress | electron-builder + auto-update in flight. Code-signing deferred (no Apple Developer account — ad-hoc unsigned dmg for now). `switchboard` CLI deferred indefinitely. |
| 10 — Advanced | 🟥 Not started | Plugin system, team features, auto-summarize, virtual scrolling |

### Recent feature additions beyond the original plan

- **Plan-mode hard-deny + read-only allow-list** (`decidePermission`)
- **AskUserQuestion → QuestionCard** (T3-style interactive picker)
- **ExitPlanMode → PlanCard** (markdown plan with Implement/Iterate buttons)
- **Image pipeline** end-to-end (paste/drag/drop → SDK image blocks → persists on reload)
- **Archive conversations** with global ID filter
- **Slash command menu** (`/plan`, `/sandbox`, `/edits`, `/full`, `/clear`, `/archive`, `/image`, `/stop`, `/help`)
- **Plan-mode denial pill** in chat stream when a tool is blocked
- **Gated `npm run build`** (typecheck + test required before build)
- **~190 unit tests** across stores, adapters, parsers, UI grouping

Current focus: Phase 9 (electron-builder packaging + signing + auto-update + `switchboard` CLI) and the long tail — Cursor import, workspace.yaml hot-reload, `as any` cleanup. Phases A–C from the 2026-04-20 batch plan all shipped (denial pill, slash menu, side-by-side chat, status bar, notifications, export-as-markdown, in-pane search, feature tour).

---

## Phase 0 — Skeleton & Dev Environment (Days 1-2)

**Goal**: Electron app boots, shows a window, hot-reloads.

- [ ] Initialize project: `npm init`, TypeScript config, ESLint, Prettier
- [ ] Set up Electron + React with Vite (electron-vite or similar)
- [ ] Main process entry (`src/main/index.ts`) — creates BrowserWindow
- [ ] Renderer entry (`src/renderer/App.tsx`) — blank shell with split layout placeholder
- [ ] Dev workflow: `npm run dev` hot-reloads both main + renderer
- [ ] Basic CI: GitHub Actions running lint + typecheck on push
- [ ] Add `vitest` for unit tests, `playwright` for e2e (empty suites for now)

**Deliverable**: `npm run dev` opens an Electron window with "Switchboard" title.

---

## Phase 1 — Terminal Engine (Days 3-7)

**Goal**: Render real PTY terminals in the app with split panes.

### 1a — Single terminal pane
- [ ] Install `xterm.js`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `node-pty`
- [ ] Create `TerminalPane` React component — mounts xterm.js instance
- [ ] Main process: spawn a PTY via `node-pty`, pipe I/O over Electron IPC
- [ ] IPC channel design: `terminal:create`, `terminal:data`, `terminal:resize`, `terminal:kill`
- [ ] Handle resize events (xterm fit addon ↔ PTY cols/rows sync)
- [ ] Test: spawn a shell, type commands, see output

### 1b — Multi-pane terminal strip
- [ ] `TerminalStrip` component — renders N `TerminalPane` instances in a column/grid
- [ ] Each pane has: label, status indicator (running/exited/error), close button
- [ ] Pane management: add, remove, reorder panes
- [ ] Keyboard nav: `⌘+1/2/3` to focus panes, `⌘+T` to add new pane
- [ ] Pane resize via drag handles

### 1c — Layout system
- [ ] Split layout: chat panel (left, 65%) + terminal strip (right, 35%)
- [ ] Resizable divider between chat and terminal strip
- [ ] Terminal strip arranges panes in configurable rows (default: 2)
- [ ] Persist layout dimensions to local storage

**Deliverable**: App with a blank left panel and 2-3 working terminal panes on the right.

---

## Phase 2 — Agent Runtime Bridge (Days 8-14)

**Goal**: Spawn Claude Code in a managed PTY, capture its output, render as chat.

### 2a — Claude Code subprocess
- [ ] Detect `claude` CLI location (`which claude` or configurable path)
- [ ] Spawn `claude --json` (or appropriate flag for structured output) in a managed PTY
- [ ] Capture JSONL output stream, parse each line into typed events
- [ ] Define TypeScript types for Claude Code events: `assistant_message`, `tool_use`, `tool_result`, `user_message`, `system`, etc.
- [ ] Handle lifecycle: start, pause (Ctrl+C), resume (`claude --resume <id>`), kill

### 2b — Chat UI (primary surface)
- [ ] `ChatPanel` component — scrollable message list + input box
- [ ] Render assistant messages as markdown (use `marked` + `shiki` for code blocks)
- [ ] Render tool calls as collapsible blocks: tool name, input, output
- [ ] Render user messages with sent timestamp
- [ ] Input box: multi-line, `Enter` to send, `Shift+Enter` for newline
- [ ] Sending a message: write to Claude Code's PTY stdin
- [ ] Auto-scroll to bottom on new messages, with scroll-lock when user scrolls up

### 2c — Raw TUI toggle
- [ ] "Raw mode" toggle in chat header — shows the actual Claude Code TUI terminal
- [ ] Seamless switch: chat view ↔ raw TUI, same session
- [ ] Power users can interact directly with the TUI when needed

**Deliverable**: Working chat with Claude Code — send messages, see rendered markdown responses with collapsible tool calls.

---

## Phase 3 — Context Bridge (Days 15-19)

**Goal**: Terminal output can be sent to the agent as context.

### 3a — Text selection capture
- [ ] Detect text selection in any `TerminalPane` (xterm.js selection API)
- [ ] `⌘+L` keyboard shortcut: capture selected text + pane metadata
- [ ] Context object: `{ text, paneName, command, timestamp }`
- [ ] Insert into chat input as a formatted context block:
  ```
  [from: backend @ 14:32]
  ERROR: dbt test failed on stg_store_metrics
  ```

### 3b — Quick prompt (⌘+K)
- [ ] `⌘+K` opens a floating prompt bar (like Spotlight / Raycast)
- [ ] Pre-filled with selected terminal text as context
- [ ] Send to current agent session, response appears in chat panel
- [ ] Dismiss with `Esc`

### 3c — Automatic error detection (stretch)
- [ ] Monitor terminal output for common error patterns (stack traces, exit codes)
- [ ] Show subtle indicator on pane when error detected
- [ ] Click indicator → pre-fills context bridge with the error

**Deliverable**: Select text in a terminal → `⌘+L` → it appears in chat input with metadata → agent can reason about it.

---

## Phase 4 — Conversation History (Days 20-26)

**Goal**: Import and browse past conversations from Claude Code, Codex, and Cursor.

### 4a — Unified conversation schema
- [ ] Define normalized schema: `Conversation { id, source, project, messages[], startedAt, summary }`
- [ ] Define normalized message: `Message { role, content, toolCalls[], timestamp }`
- [ ] Source enum: `claude-code | codex | cursor | switchboard`

### 4b — Claude Code importer
- [ ] Read `~/.claude/projects/{encoded-path}/sessions-index.json` for session list
- [ ] Parse individual JSONL session files into normalized `Conversation[]`
- [ ] Match sessions to current project by encoded CWD path
- [ ] Handle large files: stream-parse JSONL, don't load entire files into memory

### 4c — Codex importer
- [ ] Read `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
- [ ] Filter by CWD metadata to match current project
- [ ] Parse into normalized format

### 4d — Cursor importer
- [ ] Read `~/Library/Application Support/Cursor/User/workspaceStorage/*/state.vscdb`
- [ ] Use `better-sqlite3` to query `composer.composerData` key
- [ ] Parse JSON blob into normalized conversations
- [ ] Match to project by workspace folder path in SQLite metadata

### 4e — Session sidebar
- [ ] `SessionSidebar` component in left panel
- [ ] List all imported conversations grouped by source, sorted by date
- [ ] Search across conversation content
- [ ] Click to view read-only conversation
- [ ] "Fork" button — starts a new Claude Code session with `--resume` from that point
- [ ] "Continue" button — resumes the exact session if still valid

**Deliverable**: Sidebar shows all past Claude Code/Codex/Cursor conversations for this project. Can browse, search, and fork them.

---

## Phase 5 — Project Config: workspace.yaml (Days 27-31)

**Goal**: Declarative project layouts that live in the repo.

### 5a — Schema & parser
- [ ] Define JSON Schema for `.switchboard/workspace.yaml`
- [ ] Fields: `name`, `agent`, `terminals[]`, `layout`, `on_start`
- [ ] Each terminal: `name`, `cmd`, `cwd`, `env`, `autostart` (default true)
- [ ] Layout: `chat` %, `terminals` %, `terminal_rows`
- [ ] `on_start` hooks: `wait` (terminal + pattern), `then` (next terminal)
- [ ] Validate on load, show clear errors for invalid configs
- [ ] YAML parsing via `js-yaml`

### 5b — Layout hydration
- [ ] On app launch, check CWD for `.switchboard/workspace.yaml`
- [ ] If found: auto-create terminal panes per config, apply layout percentages
- [ ] If not found: show default layout with single empty terminal
- [ ] `switchboard init` command — generates a starter workspace.yaml from running processes

### 5c — Startup orchestration
- [ ] Parse `on_start` section
- [ ] Implement `wait` — monitor terminal output for regex pattern match
- [ ] Implement `then` — start next terminal after wait condition met
- [ ] Timeout handling: if pattern not matched within N seconds, warn and proceed
- [ ] Visual indicator: "Waiting for frontend to compile..." on dependent panes

### 5d — Config reload
- [ ] Watch `.switchboard/workspace.yaml` for changes (fs.watch)
- [ ] Hot-reload layout changes without killing running terminals
- [ ] Prompt before killing terminals if commands changed

**Deliverable**: Drop a `workspace.yaml` in any repo, run `switchboard`, get the full workspace with orchestrated startup.

---

## Phase 6 — Multi-Agent Support (Days 32-37)

**Goal**: Run multiple agent sessions concurrently, switch between them.

### 6a — Agent session manager
- [ ] `AgentSessionManager` — tracks N concurrent agent sessions
- [ ] Each session: agent type, PTY handle, conversation state, status
- [ ] Tab bar in chat panel header — switch between active sessions
- [ ] "New session" button — spawn additional Claude Code / Codex instances

### 6b — Codex CLI integration
- [ ] Spawn `codex` CLI in managed PTY (same pattern as Claude Code)
- [ ] Parse Codex JSONL output into normalized messages
- [ ] `codex resume --session <id>` for session continuity
- [ ] Agent selector in new session dialog: Claude Code vs Codex

### 6c — Cross-agent context
- [ ] Share terminal context (`⌘+L`) with whichever agent tab is focused
- [ ] "Ask another agent" — forward a message or context to a different active session
- [ ] Side-by-side mode: two chat panels for comparing agent responses

**Deliverable**: Run Claude Code and Codex simultaneously in separate tabs, share terminal context with either.

---

## Phase 7 — Polish & UX (Days 38-45)

**Goal**: Make it feel like a real product, not a prototype.

### 7a — Design system
- [ ] Color scheme: dark mode default (developers), light mode optional
- [ ] Typography: monospace for terminals, system font for chat UI
- [ ] Component library: buttons, inputs, tabs, modals, tooltips
- [ ] Status indicators: running (green pulse), error (red), exited (gray), waiting (amber)
- [ ] Smooth animations: pane transitions, message fade-in, collapsible blocks

### 7b — Project switcher
- [ ] `ProjectSwitcher` in top-left — list of known projects
- [ ] Project = any directory with `.switchboard/workspace.yaml` OR previous Switchboard sessions
- [ ] Switch projects: tear down current workspace, hydrate new one
- [ ] Recent projects list, pinned favorites
- [ ] `switchboard <path>` CLI arg to open directly into a project

### 7c — Keyboard-first UX
- [ ] Command palette (`⌘+Shift+P`) — search all actions
- [ ] `⌘+J` — toggle terminal strip visibility
- [ ] `⌘+B` — toggle session sidebar
- [ ] `⌘+/` — focus chat input
- [ ] All actions accessible via keyboard, mouse optional
- [ ] Vim-style navigation option for terminal focus switching

### 7d — Notifications & status bar
- [ ] Status bar at bottom: current project, agent status, active terminals count
- [ ] Notification badges on terminal panes when output arrives while unfocused
- [ ] Notification badges on agent tabs when response arrives while on different tab
- [ ] System notifications for long-running agent completions (optional)

**Deliverable**: Polished, keyboard-driven app with project switching, notifications, and consistent design.

---

## Phase 8 — Persistence & State (Days 46-52)

**Goal**: Everything survives app restarts.

### 8a — Workspace state persistence
- [ ] On quit: save full workspace state to `~/.switchboard/state/{project-hash}.json`
- [ ] State includes: layout dimensions, open terminals (commands, CWD), active agent sessions, sidebar collapsed state
- [ ] On relaunch: restore state, reconnect to still-running processes if possible
- [ ] Handle stale state gracefully (process died while app was closed)

### 8b — Conversation persistence
- [ ] Switchboard-native conversations stored as JSONL in `~/.switchboard/conversations/{project}/`
- [ ] Index file for fast sidebar loading without parsing all JSONL
- [ ] Conversation metadata: title (auto-generated from first message), tags, starred
- [ ] Export conversation as markdown

### 8c — Settings
- [ ] Settings UI: agent paths, default layout, theme, keyboard shortcuts
- [ ] Stored in `~/.switchboard/config.yaml`
- [ ] Per-project overrides in `.switchboard/workspace.yaml`

**Deliverable**: Close and reopen Switchboard — everything is exactly where you left it.

---

## Phase 9 — Distribution & Packaging (Days 53-60)

**Goal**: Ship it. People can install and use it.

### 9a — Electron packaging
- [ ] electron-builder config for macOS (DMG + auto-update)
- [ ] Code signing for macOS (Apple Developer cert)
- [ ] Linux: AppImage + .deb
- [ ] Windows: NSIS installer (lower priority, but don't break it)
- [ ] Auto-update via electron-updater (GitHub Releases as backend)

### 9b — CLI entry point
- [ ] `switchboard` CLI command — opens the app in CWD
- [ ] `switchboard init` — creates `.switchboard/workspace.yaml`
- [ ] `switchboard open <path>` — opens specific project
- [ ] Install via: `npm install -g switchboard` or `brew install switchboard`
- [ ] If app is already running, open new project in existing instance (single-instance lock)

### 9c — Landing page & docs
- [ ] Simple landing page: hero demo GIF, feature list, download links
- [ ] Docs site (Docusaurus or similar): getting started, workspace.yaml reference, keyboard shortcuts
- [ ] README with installation instructions and quick start

### 9d — Open source prep
- [ ] LICENSE (MIT)
- [ ] CONTRIBUTING.md
- [ ] Issue templates, PR template
- [ ] GitHub Releases with changelogs

**Deliverable**: Anyone can download, install, and use Switchboard on macOS. Linux works. Windows is alpha.

---

## Phase 10 — Advanced Features & Growth (Ongoing)

**Goal**: From useful tool to indispensable platform.

### 10a — Plugin system
- [ ] Extension API: register custom agent backends, terminal integrations, importers
- [ ] Plugin manifest format
- [ ] Example plugin: "import from Windsurf" or "import from Aider"

### 10b — Team features
- [ ] Shared `.switchboard/workspace.yaml` in repo — team-wide workspace configs
- [ ] Optional: share conversation snapshots via link (privacy-first, opt-in)
- [ ] Optional: team conversation search across shared conversations

### 10c — Smart features
- [ ] Auto-summarize long conversations for the sidebar
- [ ] Suggested context: when an error appears in a terminal, auto-suggest sending it to the agent
- [ ] Agent routing: based on the question, suggest which agent (Claude Code vs Codex) is better suited
- [ ] Workspace templates: "React + Node + Postgres" pre-built workspace.yaml

### 10d — Performance & scale
- [ ] Lazy-load conversation history (virtual scrolling for long chats)
- [ ] Background indexing of imported conversations
- [ ] Memory management: limit buffered terminal output, rotate old JSONL
- [ ] Benchmark: app should launch in <2s, terminal input latency <16ms

---

## Milestone Summary

| Phase | Name | Timeline | Key Deliverable |
|-------|------|----------|-----------------|
| 0 | Skeleton | Days 1-2 | Electron app boots |
| 1 | Terminal Engine | Days 3-7 | Working terminal panes |
| 2 | Agent Bridge | Days 8-14 | Chat with Claude Code |
| 3 | Context Bridge | Days 15-19 | ⌘+L terminal → chat |
| 4 | Conversation History | Days 20-26 | Import & browse past sessions |
| 5 | Project Config | Days 27-31 | workspace.yaml |
| 6 | Multi-Agent | Days 32-37 | Concurrent agents |
| 7 | Polish & UX | Days 38-45 | Production-quality UI |
| 8 | Persistence | Days 46-52 | Survives restarts |
| 9 | Distribution | Days 53-60 | Installable app |
| 10 | Advanced | Ongoing | Plugin system, team features |

---

## Principles

1. **Ship incrementally.** Each phase is usable on its own. Don't wait for Phase 10 to use Phase 1.
2. **TDD everything.** Use `/tdd` for every feature. Terminal IPC, JSONL parsing, YAML validation — all tested first.
3. **Steal shamelessly.** Study t3code's agent spawning, cmux's design language, Warp's launch configs. Don't reinvent.
4. **Keyboard-first.** Every action has a shortcut. Mouse is optional.
5. **Don't build what you can import.** xterm.js, node-pty, marked, shiki, better-sqlite3 — leverage the ecosystem.
6. **Config lives in the repo.** `.switchboard/workspace.yaml` is checked into git. New team member clones and goes.
