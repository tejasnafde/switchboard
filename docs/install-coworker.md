# Switchboard - install & first-run (coworker)

> macOS releases from v0.9.128 are signed and notarized, so they open normally.
> Switchboard downloads available updates and asks you to restart to install them.

## Prerequisites

- **macOS 12 (Monterey) or newer**
- **Apple Silicon Mac**. The release is arm64-only; if your Mac is Intel-based, tell Tejas.
- **Claude Code CLI** installed and authenticated - Switchboard shells out to it:
  ```
  npm install -g @anthropic-ai/claude-code
  claude auth login
  ```
- **Codex CLI** (optional, only if you want to use OpenAI Codex too):
  ```
  npm install -g @openai/codex
  codex login
  ```

## Install

1. Go to the [latest GitHub Release](https://github.com/tejasnafde/switchboard/releases/latest) and download **`Switchboard-X.Y.Z-arm64-mac.zip`**.
2. Unzip it (double-click in Finder or `unzip Switchboard-*.zip`).
3. Drag **Switchboard.app** into **Applications**.

## First launch

Launch Switchboard from Applications, Spotlight or the Dock. Releases from v0.9.128 are signed and notarized, so macOS opens them without a warning.

Only a build you make yourself, or a release older than v0.9.128, is unsigned. If Gatekeeper blocks one of those, run this once:

```bash
xattr -dr com.apple.quarantine /Applications/Switchboard.app
```

## What works out of the box

- **Claude Code, Codex & OpenCode chats** - `+ New Chat` on any project in the sidebar.
- **Terminal panes** - `⌘T` opens one in the chat's worktree or project folder.
- **Shell keybindings** - `⌘←/→` line start/end, `⌥←/→` word navigation, `⌘⌫` kill line, `⌥⌫` kill word. Works for zsh users without touching your `.zshrc`.
- **Chat shortcuts** - `⌘K` quick prompt, `⌘L` send selection to chat (terminal / file / chat message), `⌘|` split-chat, `⌘⇧F` full-text search, `⌘,` settings.
- **Code editor** - `⌘⇧E` switches between terminals and the embedded workbench. The editor binary downloads on demand.
- **Kanban board** - `⌘⇧K` opens the workspace-scoped board; cards launch agents in their own git worktrees.
- **Notifications** - when an agent finishes a turn in a backgrounded chat. Allow them via Settings → General → Send test notification.
- **Auto-update** - Switchboard checks releases on launch, hourly and on resume. When an update is ready you'll see "Restart and install" in Settings → General → Updates. No manual installs after the first one (except the `xattr` quarantine step above).

## Keyboard cheatsheet

`⌘⇧P` opens the command palette with a searchable list of everything. Settings → About → Feature tour replays the feature tour.

## Known rough edges

- **Claude / Codex / OpenCode binaries must be on `$PATH`** - if Switchboard says the provider is unavailable, open a terminal inside it and run `which claude`. If nothing prints, your login shell's PATH isn't getting picked up. Quick fix: `launchctl setenv PATH /opt/homebrew/bin:/usr/local/bin:$PATH` and relaunch.
- **Images attached to chats are stored in the app's SQLite DB** at `~/Library/Application Support/switchboard/data/switchboard.db`. Archive hides conversations; it does not delete their stored messages or shrink the database.
- **macOS TCC (Files & Folders permission)**: if your project lives under `~/Desktop`, `~/Documents`, or `~/Downloads` and you recently toggled Files & Folders access in System Preferences, the running process still sees `EPERM` until you quit and relaunch. Switchboard will show a clear error in chat with a "Relaunch to Apply Permissions" button.

## What to report back

- Any crash - logs live at `~/Library/Application Support/switchboard/logs/`; send the most recent file.
- Console errors - `⌥⌘I` opens DevTools; paste anything red.
- UX annoyances - screenshots welcome (`⌘⇧4`, paste into a chat with Tejas; image pipeline works).

## Uninstall

1. Quit Switchboard.
2. Trash `/Applications/Switchboard.app`.
3. (Optional, wipes all data) `rm -rf ~/Library/Application\ Support/switchboard`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Switchboard is damaged and can't be opened" or "the developer cannot be verified" | You have an unsigned build (made yourself, or older than v0.9.128). Install the latest release, or run `xattr -dr com.apple.quarantine /Applications/Switchboard.app` once |
| Terminal opens but typing does nothing | Quit + relaunch. If it persists, paste the latest log from `~/Library/Application Support/switchboard/logs/` to Tejas |
| Provider shows as unavailable | Run `which claude` (or `which codex`) in a Switchboard terminal. If blank, your shell PATH isn't loading - see Known rough edges above |
| Claude says "I'm not authenticated" | Quit Switchboard, run `claude auth login` in Terminal.app, relaunch Switchboard |
| Files & Folders error / EPERM on project path | Quit and relaunch after granting Files and Folders access in System Preferences → Privacy & Security |
