# Switchboard

**Terminals, AI coding agents, and project context — in one window.**

Switchboard is an Electron desktop app that multiplexes shells and AI agent
chats (Claude Code, Codex, OpenCode) over a shared, tmux-style pane tree.
One workspace, every project, every agent — no more juggling iTerm tabs and
three browser windows.

> Status: pre-1.0. macOS arm64 + Windows x64 builds ship via GitHub Releases
> with auto-update. Builds are unsigned (see [install notes](#install)).

---

## Feature tour

The same six clips that play inside the app's first-run tour. Captions are
pulled from `src/renderer/components/onboarding/featureRegistry.ts` so the
README and the in-app tour stay in lockstep.

> **Embedding note for maintainers:** GitHub only autoplays MP4s that were
> uploaded via the web editor (drag-and-drop into a markdown field — GitHub
> rehosts them on `user-images.githubusercontent.com`). Raw `<video
> src="videos/dist/...">` tags pointing at the repo are stripped by the
> renderer. After cloning, open this file in the GitHub web UI, drag each
> MP4 from `videos/dist/` onto the corresponding section, and commit the
> generated CDN URLs.

### 1. Welcome
Terminals, AI agents, and project context in one window. Add a folder from
the sidebar to get started — everything else flows from there.

https://github.com/user-attachments/assets/08a8056c-6497-4ffc-9dec-95664c8006ee

### 2. Slash commands & agent skills
Type `/` in any chat to switch runtime mode, archive, clear, or invoke an
agent-defined skill. Claude SDK commands and Codex skills appear inline
alongside Switchboard built-ins.

https://github.com/user-attachments/assets/74c46508-ca77-4ac6-b3f7-25a195336407

### 3. Plan mode & runtime modes
Plan mode locks the agent to read-only tools. Sandbox prompts before writes.
Accept-edits and Full-access skip the prompts. Block events render as a red
denial pill in chat.

https://github.com/user-attachments/assets/173b404f-0e12-489f-ae4f-484abf3bb22f

### 4. Multi-pane terminals & chat
Split any pane horizontally or vertically — terminals and chats live in the
same tmux-style tree. Drag the handle to resize, ⌘W closes the focused pane.

https://github.com/user-attachments/assets/2cc1312e-4f2a-4b29-b232-b5797f650dff

### 5. Session resume & full-text search
Past sessions live in the sidebar — click to resume any thread. ⌘⇧F searches
every message across every project; click a result to jump straight to it.

https://github.com/user-attachments/assets/86c50159-f723-40d6-9315-0836ac48f302

### 6. Switch agents on the fly
Use the agent dropdown in any chat to swap between Claude Code, Codex, and
OpenCode mid-session. The status bar and model picker update in lockstep.

https://github.com/user-attachments/assets/aa42e86a-e986-46e2-9e58-5efd2547a048

---

## What's in the box

- **Multi-agent chat** — Claude Code, Codex, and OpenCode side-by-side. Each
  pane has its own runtime mode (plan / sandbox / accept-edits / full).
- **Real terminals** — `node-pty` + xterm.js. zsh on macOS, PowerShell /
  cmd on Windows. ⌘F in-pane search, ⌘L to bridge selection into chat.
- **Slash commands** — `/plan`, `/archive`, `/clear`, plus every skill the
  agent itself advertises (Claude SDK, Codex). Type `/` to fuzzy-find.
- **Image pipeline** — drag-drop or paste screenshots straight into chat;
  routed through whichever vision-capable model the agent supports.
- **Dual chat** — split a chat pane to run two agents on the same prompt
  and compare answers.
- **Context bridge (⌘L)** — selected terminal output becomes a quoted block
  in the focused chat with one keystroke.
- **Quick prompt (⌘K)** — global launcher; route a prompt to any chat
  without leaving the keyboard.
- **Full-text search (⌘⇧F)** — across every message in every project.
- **Session archive + auto-title** — chats title themselves from the first
  meaningful turn; old sessions move to Archived without losing history.
- **Auto-update** — `electron-updater` polls GitHub Releases on launch and
  on demand from Settings → About.

---

## Install

Grab the latest build from the [Releases page](https://github.com/tejasnafde/switchboard/releases/latest).

### macOS (Apple Silicon)

Download `Switchboard-X.Y.Z-arm64.dmg`. The build is **unsigned** — we
don't have an Apple Developer cert — so Gatekeeper will refuse the first
launch with "developer cannot be verified."

```bash
# After dragging Switchboard.app to /Applications:
xattr -d com.apple.quarantine /Applications/Switchboard.app
```

Or right-click the app → **Open** → **Open**. Auto-update works fine, but
macOS re-quarantines the bundle on every replacement, so you'll need to
re-run the `xattr` command (or right-click → Open) after each update.

Intel Macs are not currently built. Open an issue if you need x64.

### Windows (x64)

Download `Switchboard Setup X.Y.Z.exe`. SmartScreen will pop "Windows
protected your PC" — click **More info → Run anyway**. First-launch only;
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
npm run dist:mac   # local DMG (Apple Silicon host only)
npm run dist:win   # local NSIS exe (Windows host only)
```

`npm run dist:*` only builds for the host platform. The
`@anthropic-ai/claude-agent-sdk-*` package ships per-platform native
binaries via `optionalDependencies`; cross-compiling skips the right
binary and the packaged app crashes at SDK init. Cross-platform builds
happen on tag push via the Actions matrix — see
[`docs/releasing.md`](docs/releasing.md).

### Architecture

- [`docs/concept.md`](docs/concept.md) — the product thesis.
- [`docs/plan.md`](docs/plan.md) — phased build plan, current status.
- [`docs/architecture/`](docs/architecture/) — deeper dives on IPC,
  session storage, agent adapters, and the pane tree.
- [`docs/releasing.md`](docs/releasing.md) — operator's guide for cutting
  a release.
- [`CLAUDE.md`](CLAUDE.md) — repo conventions read by Claude Code when
  working in-tree.

---

## License

TBD. Until a license file lands, treat this repo as source-available for
inspection only — no redistribution, no commercial use.
