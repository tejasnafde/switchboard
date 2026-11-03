# Keybindings

Shortcuts follow focus: the embedded workbench handles editor keys, terminal
search targets the focused terminal, and chat actions target the focused chat.
The default app bindings live in `src/shared/shortcuts.ts`. Settings > Keyboard
shortcuts can rebind app commands; the workbench has its own keyboard settings.

`⌘` means Cmd on macOS and Ctrl on Windows/Linux unless noted.

## Editor

The embedded workbench supplies file editing, search, navigation and language
features through its own commands and installed extensions. There is no
separate built-in editor keymap or repository-search fallback.

The Switchboard bridge adds these defaults (`resources/sb-bridge/package.json`):

| Keys | Action |
|---|---|
| `⌘L` | Send editor selection to the chat draft |
| `⌘K` | Quick edit with the editor selection |
| `⌘J` / `Ctrl+backtick` / `⌘⇧E` | Open Switchboard's terminal pane |
| `⌘⇧J` | Toggle data science layout |

## Terminal (when a terminal pane is focused)

| Keys | Action |
|---|---|
| `⌘F` | Search within the terminal buffer |
| `⌘W` / `⌘⇧W` | Close the active tab / whole window |
| `⌘T` / `⌘⇧T` | New window in row / in a new row |
| `⌘\` | New tab in the window |
| `⌘⇧]` / `⌘⇧[` | Cycle tabs |
| `⌘1`–`⌘9` | Focus window N |

## Global

| Keys | Action |
|---|---|
| `⌘P` | Go to chat (search titles and projects) |
| `⌘⇧P` | Command palette |
| `⌘K` | Quick prompt |
| `⌘⇧O` | New chat |
| `⌘⇧B` | Chat Details |
| `⌘⌫` | Stop the running agent |
| `⌘J` | Toggle terminal |
| `⌘⇧J` | Toggle data science layout |
| `⌘L` | Context bridge (selection → chat draft) |
| `⌘B` | Toggle sidebar |
| `⌘⇧E` | Switch right pane (terminal ↔ IDE; preview returns to terminal) |
| `⌘⇧K` | Toggle kanban board |
| `⌘⇧\\` (`⌘\|`) | Open a chat beside the current one, or close the secondary chat |
| `⌘⇧F` | Search across conversations |
| `⌘,` | Settings |

## Notes

- `⌘W` is intercepted in main and routed by focus. In the editor the host
  leaves the tab lifecycle to the workbench; in dual-chat mode it closes the
  focused chat panel; in a terminal it closes its active tab. Ambiguous focus
  does nothing. A focused terminal with no active pane can close the app window.
- In dual-chat mode, session-scoped shortcuts target the focused chat. Neutral
  focus falls back to the primary chat. Terminal selections target the
  terminal's owning session; IDE selections target the session to which the
  workbench was bound when the selection was captured.

- `⌘Z` undoes the latest Settle, Snooze or Wake action for eight seconds when focus is outside a text field, terminal or editor.
- `⌘⌥` plus an arrow moves focus between terminal windows; `⌘⇧W` closes the whole focused terminal window.
