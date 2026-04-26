# Switchboard — install & first-run (coworker)

> Unsigned development build — skip the signing warnings the first time, you won't see them again.

## Prerequisites

- **macOS 11 (Big Sur) or newer**
- **Apple Silicon Mac** (M1 / M2 / M3 / M4). This DMG is arm64-only; if your Mac is Intel-based, tell Tejas and he'll build an `--x64` DMG.
- **Claude Code CLI** installed and authenticated — Switchboard shells out to it:
  ```
  brew install --cask claude
  # or: npm install -g @anthropic-ai/claude-code
  claude login
  ```
- **Codex CLI** (optional, only if you want to use OpenAI too):
  ```
  npm install -g @openai/codex
  codex login
  ```

## Install

1. Download `Switchboard-0.1.0-arm64.dmg` (Tejas will send it — it's in `release/` of his local clone).
2. Double-click the DMG to mount it.
3. Drag **Switchboard** into **Applications**.
4. Eject the DMG (right-click → Eject).

## First launch — strip quarantine

The DMG is unsigned. Before first launch, strip the quarantine attribute so Gatekeeper gets out of the way:

```bash
xattr -dr com.apple.quarantine /Applications/Switchboard.app
```

Then launch normally from Applications / Spotlight / Dock. One-time; subsequent launches just work.

## What works out of the box

- **Claude Code & Codex chats** — `+ New Chat` on any project in the sidebar.
- **Terminal panes** — `⌘T` to open one, inside your project's cwd.
- **Shell keybindings** — `⌘+←/→` line start/end, `Option+←/→` word navigation, `⌘+Backspace` kill line, `Option+Backspace` kill word. Works for zsh users without touching your `.zshrc` (we stage a Switchboard-specific override on the side).
- **Chat shortcuts** — `⌘K` quick prompt, `⌘L` send terminal selection to chat, `⌘⇧\` split-chat, `⌘⇧F` search, `⌘,` settings.
- **Notifications** — when an agent finishes a turn in a backgrounded chat. Allow them via Settings → Notifications → Send test notification.

## Keyboard cheatsheet

Open **Settings → General → Keyboard Shortcuts** for the full list, or `⌘⇧P` for the command palette.

## Known rough edges

- **Claude / Codex binaries must be on `$PATH`** — if Switchboard says the provider is unavailable, open a terminal inside it and run `which claude`. If nothing prints, your login shell's PATH isn't getting picked up. Quick fix: `launchctl setenv PATH /opt/homebrew/bin:/usr/local/bin:$PATH` and relaunch.
- **Images attached to chats are stored in the app's SQLite DB** at `~/Library/Application Support/switchboard/data/switchboard.db`. If it gets huge, delete old conversations via the sidebar archive.
- **No auto-update yet.** When Tejas ships a new DMG, trash the old app and drag the new one into Applications. Your chats, layouts, settings, and drafts all persist in `~/Library/Application Support/switchboard/`.

## What to report back

- Any crash — there are logs at `~/Library/Application Support/switchboard/logs/`; send the most recent one.
- Console errors — `⌥⌘I` opens devtools; paste anything red.
- UX annoyances — screenshots welcome (`⌘+⇧+4`, paste into the chat with Tejas; image pipeline actually works now).

## Uninstall

1. Quit Switchboard.
2. Trash `/Applications/Switchboard.app`.
3. (Optional, wipes all data) `rm -rf ~/Library/Application\ Support/switchboard`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Switchboard is damaged and can't be opened" | You skipped the `xattr` step — run `xattr -dr com.apple.quarantine /Applications/Switchboard.app` and retry |
| Terminal opens but typing does nothing | Quit + relaunch. If it persists, paste contents of `~/Library/Application Support/switchboard/logs/` to Tejas |
| Word navigation keys do nothing | Open Settings → General, click **Send test notification** to confirm the app's settings pipe is alive. If yes but word nav still broken: `echo $SWITCHBOARD_SHELL` in a Switchboard terminal — should print `1`. If not, ZDOTDIR isn't being picked up; report which shell you use (`echo $SHELL`) |
| Claude says "I'm not authenticated" | Quit Switchboard, run `claude login` in Terminal.app, relaunch Switchboard |
