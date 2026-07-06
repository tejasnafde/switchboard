# Switchboard

**Terminals, AI coding agents, and project context - in one window.**

Switchboard is an Electron desktop app that multiplexes shells and AI agent
chats (Claude Code, Codex, OpenCode) over a shared, tmux-style pane tree.
One workspace, every project, every agent - no more juggling iTerm tabs and
three browser windows.

> Status: pre-1.0. macOS arm64 + Windows x64 builds ship via GitHub Releases
> with auto-update. Builds are unsigned (see [install notes](#install)).

---

## Feature tour

The twelve clips from the app's first-run tour, in order. Clips marked
*(coming soon)* are rendered in `videos/dist/` but not yet embedded here -
see the maintainer note below.

> **Embedding note for maintainers:** GitHub only autoplays MP4s that were
> uploaded via the web editor (drag-and-drop into a markdown field - GitHub
> rehosts them on `user-images.githubusercontent.com`). Raw `<video
> src="videos/dist/...">` tags pointing at the repo are stripped by the
> renderer. After cloning, open this file in the GitHub web UI, drag each
> MP4 from `videos/dist/` onto the corresponding section, and commit the
> generated CDN URLs.

### 1. Welcome
Terminals, AI agents, and project context in one window. Add a folder from
the sidebar to get started - everything else flows from there.

https://github.com/user-attachments/assets/08a8056c-6497-4ffc-9dec-95664c8006ee

### 2. Two modes: Chats & Board
Toggle the whole app between engineering view (chats + terminals + files)
and a workspace-scoped kanban board with ⌘⇧K. Cards double as chats - hit ▶
to start a conversation rooted in the card's own git worktree.

<!-- maintainer: drag videos/dist/kanban-view.mp4 here in the GitHub web editor --> *(coming soon)*

### 3. Slash commands & agent skills
Type `/` in any chat to switch runtime mode, archive, clear, or invoke an
agent-defined skill. Claude SDK commands and Codex skills appear inline
alongside Switchboard built-ins.

https://github.com/user-attachments/assets/74c46508-ca77-4ac6-b3f7-25a195336407

### 4. Plan mode & runtime modes
Plan mode locks the agent to read-only tools. Sandbox prompts before writes.
Accept-edits and Full-access skip the prompts. Block events render as a red
denial pill in chat.

https://github.com/user-attachments/assets/173b404f-0e12-489f-ae4f-484abf3bb22f

### 5. Multi-pane terminals & chat
Split any pane horizontally or vertically - terminals and chats live in the
same tmux-style tree. Drag the handle to resize, ⌘W closes the focused pane.

https://github.com/user-attachments/assets/2cc1312e-4f2a-4b29-b232-b5797f650dff

### 6. File viewer & context bridge
⌘⇧E flips the right pane to a file tree + viewer with syntax highlighting.
⌘P fuzzy-finds any file; ⌘L pipes a terminal or file selection straight into
the chat draft.

<!-- maintainer: drag videos/dist/file-viewer-context.mp4 here in the GitHub web editor --> *(coming soon)*

### 7. Named terminal templates
Save a terminal layout as a named template and apply it to any new chat -
the last-applied template stays pinned per chat. Templates live in
`workspace.yaml`.

<!-- maintainer: drag videos/dist/terminal-templates.mp4 here in the GitHub web editor --> *(coming soon)*

### 8. Workspace config
Drop a `.switchboard/workspace.yaml` into a project to declare terminals and
startup commands, so a workspace boots the same way every time.

<!-- maintainer: drag videos/dist/workspace-config.mp4 here in the GitHub web editor --> *(coming soon)*

### 9. Switch agents per chat
Pick Claude Code, Codex, or OpenCode for any chat from the agent dropdown -
the status bar and model picker update to match. Switching starts a fresh
context with the new agent.

https://github.com/user-attachments/assets/aa42e86a-e986-46e2-9e58-5efd2547a048

### 10. Session resume & full-text search
Past sessions live in the sidebar - click to resume any thread. ⌘⇧F searches
every message across every project; click a result to jump straight to it.

https://github.com/user-attachments/assets/86c50159-f723-40d6-9315-0836ac48f302

### 11. Remote machines (experimental)
Run agents and terminals on another computer over SSH. Add a machine from
the sidebar - Switchboard uses your existing SSH config, installs a small
helper on first connect, and tunnels everything.

<!-- maintainer: drag videos/dist/remote-machines.mp4 here in the GitHub web editor --> *(coming soon)*

### 12. Sidebar workspaces
Group projects under named, color-tagged workspaces - Work, Personal, side
quests. Filter the tree by chat title; collapse state persists across launches.

<!-- maintainer: drag videos/dist/workspaces.mp4 here in the GitHub web editor --> *(coming soon)*

---

## What's in the box

- **Multi-agent chat** - Claude Code, Codex, and OpenCode side-by-side. Each
  pane has its own runtime mode (plan / sandbox / accept-edits / full).
- **Real terminals** - `node-pty` + xterm.js. zsh on macOS, PowerShell /
  cmd on Windows. ⌘F in-pane search, ⌘L to bridge selection into chat.
- **Slash commands** - `/plan`, `/archive`, `/clear`, plus every skill the
  agent itself advertises (Claude SDK, Codex). Type `/` to fuzzy-find.
- **Image pipeline** - drag-drop or paste screenshots straight into chat;
  routed through whichever vision-capable model the agent supports.
- **Dual chat** - split a chat pane to run two agents on the same prompt
  and compare answers.
- **Context bridge (⌘L)** - selected terminal output becomes a quoted block
  in the focused chat with one keystroke.
- **Quick prompt (⌘K)** - global launcher; route a prompt to any chat
  without leaving the keyboard.
- **Full-text search (⌘⇧F)** - across every message in every project.
- **Code editor (⌘⇧E)** - CodeMirror with multi-tab, syntax highlighting, a
  git diff gutter, and ⌘-click jump-to-definition (TypeScript + Python LSP).
  ⌘P fuzzy-opens any file in the repo.
- **Kanban board (⌘⇧K)** - a workspace-scoped board where each card launches
  an agent in its own git worktree, so parallel work stays isolated.
- **Conversation forking** - right-click any message to branch the chat from
  that point (Claude resumes real context); optionally fork into a worktree.
- **In-chat diff review** - after each agent turn, changed files surface as
  Cursor-style diff cards with per-hunk accept/reject buttons directly in
  chat.
- **Multi-account providers** - store named credential sets per agent
  (e.g. work / personal) and switch between them from the model picker.
- **Rich chat input** - inline file/terminal/chat pill chips and `@`-mention
  file autocomplete.
- **Session archive + auto-title** - chats title themselves from the first
  meaningful turn; old sessions move to Archived without losing history.
- **Auto-update** - `electron-updater` polls GitHub Releases on launch and
  on demand from Settings → About.

---

## Remote machines (experimental)

Switchboard can run agents and terminals on a remote host over SSH, so
heavy work happens on a server while the app stays on your laptop.

- **Add a machine** from the sidebar: pick a host from your `~/.ssh/config`
  or enter host, user, and port. Optionally set "Run as user" if the remote
  should run work as another account via passwordless sudo - leave it blank
  to use your login user.
- **Auth is your normal SSH setup** (keys and agent). Switchboard never
  stores a password or key; it shells out to `ssh` with `BatchMode=yes`.
- **First connect provisions a small helper** into `~/.switchboard-server`
  on the remote and opens an SSH tunnel. The remote backend binds to
  localhost only - all access goes through the tunnel.
- **Then it's just Switchboard, remotely**: add a project by absolute path
  (with live autocomplete) and start a chat - the agent, terminals, git,
  and file access all run on the remote. Recent projects stay browsable
  read-only while you're offline.

Remote requirements: a Linux host reachable over SSH with Node.js 20+
already installed for the target user.

---

## Under the hood

The parts that were genuinely hard, for the technically curious:

- **One adapter interface, three wire protocols.** Claude Code speaks the
  Agent SDK (streaming input mode, `canUseTool` interception), Codex speaks
  JSON-RPC 2.0 over stdio to `codex app-server`, OpenCode speaks the Agent
  Client Protocol. All three normalize into a single discriminated-union
  event stream (`src/shared/provider-events.ts`) so the renderer never knows
  which agent it's talking to.
- **Permission policy enforced app-side.** Plan mode doesn't trust the SDK's
  own plan flag - a pure, unit-tested policy module
  (`src/main/provider/policy.ts`) hard-denies non-read-only tools for all
  three agents and renders the denial in chat.
- **Git as the source of truth for edits.** A checkpoint is taken at turn
  start; the diff against it drives per-hunk accept/reject cards in chat,
  regardless of what the agent claims it edited. Kanban cards run their
  agents in isolated git worktrees so parallel work can't collide.
- **Real infrastructure, not wrappers**: `node-pty` + xterm.js terminals,
  CodeMirror 6 editor with LSP jump-to-def (tsserver + pyright spawned per
  workspace/language), SQLite + FTS5 for cross-project message search,
  `safeStorage`-encrypted multi-account credentials.
- **1100+ unit tests** and a gated build: `npm run build` fails if typecheck
  or tests fail.

Deeper dives live in [`docs/architecture/`](docs/architecture/).

---

## Install

Grab the latest build from the [Releases page](https://github.com/tejasnafde/switchboard/releases/latest).

### macOS (Apple Silicon)

Download `Switchboard-X.Y.Z-arm64-mac.zip` (not a `.dmg` - see
[`docs/releasing.md`](docs/releasing.md) for why). The build is
**unsigned** - we don't have an Apple Developer cert - so Gatekeeper will
refuse the first launch with "developer cannot be verified."

```bash
# Unzip, drag Switchboard.app to /Applications, then:
xattr -d com.apple.quarantine /Applications/Switchboard.app
```

Or right-click the app → **Open** → **Open**. Auto-update works fine, but
macOS re-quarantines the bundle on every replacement, so you'll need to
re-run the `xattr` command (or right-click → Open) after each update.

Intel Macs are not currently built. Open an issue if you need x64.

### Windows (x64)

Download `Switchboard Setup X.Y.Z.exe`. SmartScreen will pop "Windows
protected your PC" - click **More info → Run anyway**. First-launch only;
auto-update is silent.

A `.zip` portable build is also published for users who'd rather not run
the NSIS installer.

---

## Develop

```bash
git clone https://github.com/tejasnafde/switchboard.git
cd switchboard
npm install
npm run dev      # vite + electron, hot reload on save
```

Other scripts:

```bash
npm test           # vitest
npm run typecheck  # tsc --noEmit across main / preload / renderer / shared
npm run build      # bundle main + renderer (no packaging)
npm run dist:mac   # local zip build (Apple Silicon host only)
npm run dist:win   # local NSIS exe (Windows host only)
```

`npm run dist:*` only builds for the host platform. The
`@anthropic-ai/claude-agent-sdk-*` package ships per-platform native
binaries via `optionalDependencies`; cross-compiling skips the right
binary and the packaged app crashes at SDK init. Cross-platform builds
happen on tag push via the Actions matrix - see
[`docs/releasing.md`](docs/releasing.md).

### Architecture

- [`docs/concept.md`](docs/concept.md) - the product thesis.
- [`docs/plan.md`](docs/plan.md) - phased build plan, current status.
- [`docs/architecture/`](docs/architecture/) - deeper dives on IPC,
  session storage, agent adapters, and the pane tree.
- [`docs/releasing.md`](docs/releasing.md) - operator's guide for cutting
  a release.
- [`CLAUDE.md`](CLAUDE.md) - repo conventions read by Claude Code when
  working in-tree.

---

## License

[MIT](LICENSE) © Tejas Nafde
