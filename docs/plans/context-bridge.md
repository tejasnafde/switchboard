# Plan — ⌘+L context bridge + ⌘+K quick prompt

> **Status: shipped 2026-04-26.** Both features are live in production.
> Implementation lives at `src/renderer/services/contextBridge.ts`
> (⌘+L — 50k char cap, multi-line selections wrap in a fenced code
> block, appended to the active chat draft) and
> `src/renderer/components/QuickPromptModal.tsx` (⌘+K — floating
> one-shot prompt bar, optional pre-fill from current terminal
> selection). Wired up in `App.tsx` keybindings.
>
> This file is kept as historical design rationale; bug-fixes go
> directly against the source files above.

---

Both features "bridge" the terminal and the chat: the user has something
selected or visible in a terminal pane, and wants the agent to reason about
it without copy-pasting. Shared primitives, different UX.

---

## ⌘+L — Append terminal selection to chat input

### Goal

User selects text in a terminal pane, presses ⌘+L — the selection is
inserted into the chat input as a formatted **context block**:

```
[from: backend @ 14:32 · npm run dev]
ERROR: dbt test failed on stg_store_metrics
stack trace line 1
stack trace line 2
```

User continues typing their question ("why does this happen?"), hits Send.
The agent receives the selection + metadata + the question in one message.

### Entry points

- ⌘+L keybinding in `App.tsx` (capture-phase listener, same pattern as other shortcuts)
- Command palette item: "Send selection to chat" with shortcut `⌘L`
- (Future) right-click on a terminal pane → "Send selection to chat"

### Data flow

1. **Capture selection** — xterm.js exposes `terminal.getSelection(): string` on the `Terminal` instance. We already keep these instances in `terminal-registry.ts`.
2. **Resolve metadata** — the active pane's ID → `terminal-store.panes[paneId]` → `{ label, command, cwd }`. Timestamp = now.
3. **Format** — build the context block:
   ```
   [from: {paneLabel} @ {HH:mm}{command ? ` · ${command}` : ''}]
   {selection}
   ```
4. **Inject into draft** — append (with `\n\n` separator) to the active
   session's draft via `useDraftStore.appendDraft(sessionId, block)`. Already
   have this primitive from the "ask another agent" forward feature.
5. **Focus the chat input** — so the user can immediately type their question.

### Files touched

| File | Change |
|---|---|
| `src/renderer/services/terminal-registry.ts` | Add `getTerminalSelection(paneId)` helper that reads from the registered xterm instance |
| `src/renderer/App.tsx` | Add ⌘+L keybinding handler |
| `src/renderer/components/terminal/TerminalPane.tsx` | (Optional) add "Send to chat" to right-click menu later |
| `src/renderer/services/contextBridge.ts` | **New** — pure formatter + dispatch function `sendTerminalSelectionToChat()` |
| `src/renderer/components/CommandPalette.tsx` | Register the new command in the registry |
| `tests/unit/context-bridge.test.ts` | **New** — pure tests for the formatter |

### Pure function (testable)

```ts
export function formatTerminalContext(params: {
  selection: string
  paneLabel: string
  command?: string
  cwd?: string
  timestamp: number
}): string {
  const time = new Date(params.timestamp).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit',
  })
  const header = params.command
    ? `[from: ${params.paneLabel} @ ${time} · ${params.command}]`
    : `[from: ${params.paneLabel} @ ${time}]`
  return `${header}\n${params.selection.trim()}\n`
}
```

### Edge cases

- **No selection** — show a small toast / palette feedback "Select text in a terminal first". Don't fail silently.
- **Active session focus** — if focus is in a chat input, ⌘L should NOT fire (unless there's a terminal selection AND no text field focus). Follow the same guard pattern as ⌘⇧\.
- **Multi-line selection** — quote properly so markdown preserves line breaks. Consider wrapping in ``` for very long selections.
- **Size cap** — clamp to ~4 KB (1000 tokens) so users don't blow their context window by accident. Truncate with `…<N more lines>`.

### Effort

- `contextBridge.ts` + unit tests: ~45 min
- Keybinding + registry wiring: ~20 min
- Toast / no-selection feedback: ~15 min
- **Total: ~1.5 hours**

---

## ⌘+K — Quick prompt (Spotlight-style)

### Goal

Floating prompt bar — ⌘+K anywhere opens it. User types a one-off
question, hits Enter, response streams into the active chat panel as if
they'd sent it normally. Unlike ⌘L, this bypasses the chat input entirely.

Dismiss with Esc. Pre-fills with current terminal selection if present
(so ⌘L and ⌘K overlap — ⌘L stages context; ⌘K sends a quick one-shot).

### UX

- Modal centered vertically at ~15% from top (like Spotlight / command palette)
- Single-line input (or auto-expanding textarea capped at 5 lines)
- Placeholder: "Ask the agent…" or "Ask {agentLabel}…"
- Below input: muted hint "Sends to: {active session title} · Enter to send · Esc to cancel"
- If terminal selection exists: show a small "With context from {paneLabel}" pill above the input; click to remove.

### Data flow

1. **Open via ⌘+K** — set `quickPromptOpen = true` in layout-store (or local App state).
2. **Capture selection** (same helper as ⌘L) — pre-stage as context if any.
3. **On submit**:
   - If no active session, fail gracefully ("No active chat — click + New Chat first").
   - Format the message: `{context?}\n\n{user question}`.
   - Dispatch via `providerApi.sendTurn(activeSessionId, message)` — same entry point as the normal chat input.
   - Close the quick-prompt bar.
   - Scroll the active chat panel to bottom (it's streaming now).
4. **Dismiss** — Esc or click outside.

### Files touched

| File | Change |
|---|---|
| `src/renderer/components/QuickPromptModal.tsx` | **New** — the floating bar component |
| `src/renderer/App.tsx` | ⌘+K keybinding + mount the modal |
| `src/renderer/components/CommandPalette.tsx` | Register command "Quick prompt (⌘K)" |
| `src/renderer/services/contextBridge.ts` | Reused for pre-filling selection |

### Relationship to existing features

- **Reuses `providerApi.sendTurn`** — no new adapter code. Quick prompt IS a regular turn; it just bypasses the ChatInput textarea.
- **Reuses `useDraftStore`** — optionally save quick-prompt draft to the active session so it persists if user ⌘K-dismisses mid-type.
- **Doesn't replace ⌘L** — ⌘L stages context in the input for editing; ⌘K sends immediately. Think "bookmark vs. send-now".

### Edge cases

- **Active agent is running a turn** — queue the message (same as hitting Enter while running = "Queue a follow-up"). Show the quick-prompt bar with the "Queue" label.
- **No active session** — toast + close the bar. Don't silently swallow.
- **Empty input** — disabled Send; Esc closes.
- **Dual-chat mode** — sends to the LEFT panel (the primary `activeSessionId`). Could add a "target session" switcher later if needed.

### Effort

- `QuickPromptModal.tsx` + styles: ~1 hour
- Keybinding + dispatch wiring: ~30 min
- Terminal selection pre-fill + pill UI: ~30 min
- Tests for the formatter (shared with ⌘L): covered above
- **Total: ~2 hours**

---

## Suggested build order

1. **`contextBridge.ts` + unit tests** first — pure logic, no UI. Lock down the formatter.
2. **⌘+L** next — smaller feature, validates the context capture plumbing against a real flow (insert into draft).
3. **⌘+K** last — builds on the same primitives, adds the modal UI.

**Total effort: ~3.5 hours.**

## Out of scope

- **Automatic error detection** (Phase 3c stretch) — highlighting error output in terminals and offering a one-click "send to agent". Defer until we see how often users manually ⌘L error traces.
- **Streaming context from terminals without user selection** — e.g. "send last 50 lines". Interesting but not asked for.
- **Multiple context blocks stacked** — user could ⌘L twice to stage two selections. Current plan just appends both to the draft; works by default.
