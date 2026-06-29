# Keybindings

Shortcuts are **scoped by focus** - the same chord does the right thing
depending on which pane is active, mirroring how VS Code uses `when:` clauses.
Three contexts:

- **Editor** - bindings live in the CodeMirror keymap; only fire when the code
  editor has focus.
- **Terminal** - scoped to the focused terminal pane's subtree.
- **Global** - app-level actions, handled regardless of focus.

`⌘` = Cmd on macOS / Ctrl on Windows·Linux unless noted.

## Editor (when the code editor is focused)

| Keys | Action |
|---|---|
| `⌘-click` / `F12` | Go to definition (LSP → `git grep` fallback) |
| `⇧F12` | Go to references - inline peek (1 result auto-jumps; ↑↓·⏎·esc) |
| `⌘`-hover | Underline the symbol under the cursor (clickable affordance) |
| `⌘S` | Save (atomic; prompts on external-edit conflict) |
| `⌘/` | Toggle line comment |
| `⌥↑` / `⌥↓` | Move line up / down |
| `⇧⌥↑` / `⇧⌥↓` | Copy line up / down |
| `⌘D` | Select next occurrence (multi-cursor) |
| `Ctrl+G` | Go to line |
| `⌘F` | Find in file · `⌘G` / `⇧⌘G` find next / prev |
| `⌘Z` / `⇧⌘Z` | Undo / redo (per-buffer history) |
| `Ctrl+-` / `Ctrl+⇧-` (mac), `⌥←` / `⌥→` (win·linux) | Navigate back / forward |
| `⌘W` | Close the active editor tab |
| `Tab` / `⇧Tab` | Indent / outdent |

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
| `⌘P` | Quick Open (fuzzy file finder) |
| `⌘⇧P` | Command palette |
| `⌘K` | Quick prompt |
| `⌘L` | Context bridge (selection → chat draft) |
| `⌘B` | Toggle sidebar |
| `⌘⇧E` | Toggle right pane (terminal ↔ files) |
| `⌘⇧K` | Toggle kanban board |
| `⌘\|` | Toggle dual-chat |
| `⌘⇧F` | Search across conversations |
| `⌘,` | Settings |

## Notes

- `⌘W` is intercepted once in the main process and routed by focus: editor tab →
  chat panel (dual mode) → terminal tab → app window. It will **not** close a
  terminal (and its pty / SSH session) while you're in the editor.
- Most editor bindings come from CodeMirror's bundled `defaultKeymap` /
  `searchKeymap`; the app only adds the ones that touch app concepts
  (`F12`, `⌘W`, navigation).
