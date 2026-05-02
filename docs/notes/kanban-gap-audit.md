# Kanban product-gap audit (2026-05-02)

Surface read end-to-end: `KanbanView.tsx`, `CardModal.tsx`, `kanban-store.ts`, `shared/kanban.ts`, `main/ipc/kanban.ts`. Triaged into P0/P1/P2 by user-facing impact × delta-from-existing-code (cheaper if the seam already exists).

Companion mockups (open in a browser):
- `docs/notes/kanban-mockup-dnd-and-liveness.html` — drag/drop + live tile state
- `docs/notes/kanban-mockup-card-detail.html` — slide-in detail panel (replaces modal)

---

## P0 — ship-blockers for "PM view that reflects reality"

### 1. No drag-and-drop between columns
`kanban-store.move(id, status)` exists but **no UI consumer**. Today the only way to move a card across columns is open the edit modal → status dropdown → Save. For a tool whose entire point is column-state, this is the biggest gap.

- **Why it matters**: kanban without drag-and-drop is just a four-up filter.
- **Effort**: small. We already use `@dnd-kit` for sidebar project reorder. Wrap `Column` body in `<SortableContext>`, `<Droppable>` per status, `useSortable` per tile, on drop call `move(card.id, newStatus)`. Re-fetch is unnecessary because `update()` already patches the store.
- **Bonus**: same scaffolding gives us **manual reorder within a column** (gap #6).

### 2. AskUserQuestion does not auto-promote a card to `needs_input`
The `needs_input` column exists and has a special tile glow (`data-needs-input`), but nothing in the runtime flips a card's status to it. Today `needs_input` is a manual label.

- The seam: when an adapter emits `question.asked` for a session whose `conversationId` matches a kanban card, the main process should `kanbanStore.update(cardId, { status: 'needs_input' })`. On `question.answered`, demote back to `in_progress`.
- Lookup: index `kanban_cards` by `conversation_id` in main; cheap.
- **Why it matters**: this is the killer feature of running agents on a board — "which agents need me right now" answered at a glance.

### 3. Tile doesn't reflect live session state
A card with a linked conversation just shows a static `● session` dot. No indication of:
- Is the agent running a turn right now?
- Did it complete a turn since I last looked? (unread)
- Is it idle / errored / waiting for tool approval?

`agent-store` already tracks per-session status. The kanban tile should subscribe to the matching session and show a colored pulse / spinner / "1 new" badge.

- **Effort**: small. `useAgentStore((s) => s.sessions.find((x) => x.id === card.conversationId)?.status)` per tile.
- **Why it matters**: you can't run agents in the background and trust the board if the board lies about what's happening.

---

## P1 — meaningful UX improvements, smaller individual lift

### 4. Delete is destructive only — no archive
`remove()` hard-deletes the row + (optionally) the worktree. There's no archive bucket, so the Done column grows forever and there's no "I want to forget this for now without losing history" path.

- Add `archived INTEGER` column on `kanban_cards`.
- Hide archived from the board by default; expose via a "Show archived" toggle in the toolbar.
- Optional: auto-archive Done cards older than N days (settings-tunable).

### 5. No activity timeline / "last touched" on the tile
Tile shows nothing time-relative. Stale in-progress cards look identical to ones the agent finished a turn on 30s ago.

- Cheap version: `card.updatedAt` → "2m ago" badge using `fmtDuration`.
- Richer version: a per-card activity log (status changes, turn completions, cost ticks) shown in the detail panel.

### 6. No manual ordering within a column
Cards are creation-time sorted. There's no "this is the next thing I'll pick up" priority signal.

- Comes free with #1 if we add a `sortOrder` column. Without it, drag-within-column is a no-op.

### 7. CardModal is cramped for rich cards
Description is a 5-row textarea inside a 480px modal. Anything with paragraphs + acceptance criteria + agent context ends up scrolled. Replace with a slide-in side panel (mockup #2) that stays open as the user navigates the board.

### 8. No empty state copy
Empty board renders four `(empty)` placeholders. First-run users get no guidance on what cards are for or why they'd opt into a worktree.

- **Effort**: trivial.

### 9. "⎇ Worktrees" disabled until project filter is set
Discoverability bug. The button is visible but disabled with no obvious next step. Either:
- Always-enabled, opens a project-picker first if scope is ambiguous; or
- Hide entirely until a project filter is set (current state communicates "broken" rather than "scope a project first").

### 10. Cost cap warnings are silent
A card hitting `costUsedUsd >= costCapUsd` flips a `data-over-budget` attribute that styles the cost badge red — but no notification, no column re-promotion, no user-facing event. Easy to miss while in chats view.

- Add a system notification when a session crosses 80% / 100% of cap.
- Auto-promote to `needs_input` at 100% (parallel to gap #2).

---

## P2 — nice-to-haves, low priority but worth listing

11. **No keyboard nav** between cards (arrow keys, j/k focus).
12. **No bulk select** for archive/delete/move (shift-click, lasso).
13. **No tag autocomplete** in CardModal — tags are free-form so typos fragment.
14. **No card linking / dependencies** ("blocked by #foo", "relates to #bar").
15. **No WIP limits** per column (soft cap to encourage focus).
16. **No card sort options** within a column (by cost, by priority, by recently active).
17. **No card templates** for common patterns ("triage bug", "refactor module").
18. **No "All workspaces" project chip is ambiguous** — the chip shows project basename only; on collisions (two `web` projects in different workspaces) you can't tell them apart. Add a workspace indicator color.
19. **Worktree creation surfaces no progress** for slow disks — UI sits frozen during create, no spinner state in the tile.
20. **No undo** on column moves or deletes.

---

## Suggested ship order

If we're picking a single PR: **#1 (drag/drop) + #2 (auto-promote needs_input) + #3 (live tile state)**. Together they convert kanban from "a static labeling UI" into "a live agent dashboard," which is the actual product thesis. Each is small individually; together they're the smallest coherent unit that makes the PM view feel alive.

The in-flight uncommitted changes (project chip in CardModal, always-mount KanbanView) belong in this same PR — the picker is a precondition for confidently dragging cards, and always-mount eliminates dropdown-flicker that worsens during drag interactions.
