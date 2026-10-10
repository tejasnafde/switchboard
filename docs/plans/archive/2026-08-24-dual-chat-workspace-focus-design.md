# Dual-chat workspace focus design

**Date:** 2026-08-24  
**Status:** Approved for implementation

## Problem

Dual chat currently renders two `ChatPanel` instances but leaves most of the surrounding workspace bound to `agent-store.activeSessionId`. The right chat can accept input and stream independently, yet the IDE, terminal strip, status bar, global shortcuts, context bridge, unread state, notifications, and forwarding often continue to target the left chat. The layout also permits duplicate and stale slot bindings, and the feature is difficult to discover without knowing its shortcut.

The original Phase 6 contract was broader than merely rendering two panels: users should be able to run agents concurrently, compare responses, delegate work, forward context, and keep companion surfaces next to the chat they are working with.

## Product contract

Dual chat has six distinct concepts:

1. **Primary session:** the session in the ordinary single-chat slot.
2. **Secondary session:** the second session displayed in dual mode.
3. **Focused chat slot:** `primary` or `secondary`.
4. **Focused session:** the session currently bound to that slot.
5. **Displayed sessions:** every session currently visible in a chat presentation.
6. **Companion session:** the session whose IDE, terminal strip, status, and companion-origin actions are shown.

The same session cannot occupy both slots. Opening a session already displayed focuses its existing slot. Closing the secondary leaves the primary unchanged; closing the primary promotes the secondary. Removal, archival, ID rotation, remote disconnection, and stale restored state pass through one deterministic reconciliation function.

Sidebar selection replaces the focused slot. If the selected session is already displayed, it focuses that slot instead. A new chat uses the same slot rule. Explicit message actions always retain their owning session regardless of ambient focus.

## Chosen architecture

### Workspace state and reconciliation

Add a renderer-only chat-workspace state seam with the following durable-in-memory shape:

```ts
type ChatSlot = 'primary' | 'secondary'

type ChatWorkspaceState = {
  primarySessionId: string | null
  secondarySessionId: string | null
  focusedSlot: ChatSlot
  splitRatio: number
}
```

A pure reducer accepts explicit transitions for open, focus, close, remove, rotate, restore, and replace. Every transition normalizes duplicate canonical thread identities and invalid slot focus. Zustand actions delegate to this reducer rather than independently repairing state in component effects. The two-slot cap is deliberate: this feature compares or delegates between two chats, not an arbitrary pane graph.

The workspace seam is the only owner of slots and split ratio; the old `layout-store.dualChat`, `rightSessionId`, and independently writable ratio fields are removed or delegated to it. `agent-store.activeSessionId` remains a read-compatible mirror of the primary slot during this focused change, but its setter delegates to the workspace transition rather than writing independently. A regression guard prevents new direct assignments. It no longer determines focused, displayed, or companion sessions.

Slot uniqueness uses the canonical/root thread identity resolved during session load and ID rotation, not only the current renderer string ID. The reducer accepts canonical identity metadata so a synthetic pre-turn ID and its later provider ID cannot occupy both slots.

Transient workspace focus is not written to the conversation database. Restored slot IDs are reconciled against the live session catalog before presentation.

### Focus and action routing

Chat panel roots expose one unambiguous `data-chat-slot` and `data-session-id`. Pointer and focus-capture events inside a panel establish its focused slot, including composers, messages, headers, controls, and empty areas. Focus is shown with a quiet border/header treatment.

Action routing follows this precedence:

1. An explicit message/session ID supplied by the action.
2. A terminal pane's owning session.
3. The session bound to the actually loaded IDE workspace.
4. The containing chat slot.
5. The stored focused slot.
6. The primary session only when no valid slot has been focused or restored.

Moving from a focused chat into its companion IDE or terminal keeps that companion binding. Losing DOM focus does not erase the stored chat focus: closing a popover or returning from a webview must not make a shortcut silently target the other agent. Primary is the initialization and invalid-state fallback.

A composer registry keyed by session ID replaces first-match `document.querySelector()` behavior. Each mounted composer registers a stable focus handle. Context delivery names its target session, appends only to that session, and focuses that registered composer. If the target closes before delivery, the pending pill remains in the transient draft store for that exact session and the UI reports a recoverable error; it has no independent TTL and is never rerouted.

### IDE and terminal binding

The single IDE and terminal strip follow the companion session derived from chat focus. `IdePane` receives or selects the companion session explicitly and shows its project/worktree, machine, and chat identity.

The IDE keeps the current 500 ms folder debounce, one-code-server, and one-webview policy. Its committed binding is the complete `{ sessionId, machineId, folder }` record. Navigation compares machine/folder, so switching between chats sharing a folder updates the binding's session ID without reloading the workbench. Local/remote changes never reuse the other target's filesystem or port. An unavailable remote machine shows an unavailable state.

IDE selection routing uses the committed binding whose folder is actually loaded in the webview, not the latest global session value or a reverse folder lookup. This makes selection capture authoritative even while a focus change is waiting on the navigation debounce and disambiguates two agents working in the same checkout.

Terminal layouts remain keyed and mounted per session. `terminal-store.activeSessionId` becomes a derived companion pointer rather than a third independently selected identity. Displayed sessions are hydrated so a chat opened directly beside another receives its launch-config layout before first companion focus; the visible strip, launch-config hot reload, and new-terminal commands select the companion session. Terminal-origin shortcuts retain the pane's explicit session.

### Message actions and forwarding

File pills call a session-aware viewer action with the message's owning session. Fork, approval, plan, question, diff, and other explicit message actions continue to receive their owning session directly.

`ForwardMenu` receives `sourceSessionId`. It excludes that source, uses the actual source title/provider in quoted context, and offers the other displayed chat first as **Send to other panel**. Forwarding only appends to the target draft, focuses the receiving slot and composer, and never sends automatically.

For a target not displayed, the target replaces the slot opposite the source so the source remains visible. When the source is primary this naturally opens the target as secondary. No transition can leave the target in both slots.

Dual mode also exposes **Copy prompt to other chat**. The operation copies the current draft without sharing mutable state: pill IDs and inline tokens are remapped, and image attachments receive independent IDs and object URLs. The receiving draft carries visible source provenance. Crossing to another machine or provider instance requires confirmation because materialized terminal/file pill contents cross that trust boundary. Sending remains independently confirmed in each chat; this change does not add an atomic or coupled send-both workflow.

### Visibility, unread, and notifications

All displayed chats suppress local unread increments. While the desktop window is focused, messages rendered in either displayed chat also advance their durable backend read points, keeping local/sidebar/mobile state coherent. When the app window is visible, displayed chats suppress redundant native completion notifications. Notification clicks focus a session's existing slot or open it using normal reconciliation.

Only the focused chat reports the single desktop viewing lease used for presence-based push suppression. This preserves the existing wire contract and mobile behavior while read-point commits accurately reflect content visibly presented in the focused desktop window.

### Discoverability and identity

The chat header gains a restrained split/open-beside action with the tooltip **Compare or delegate with two chats side by side**. Sidebar session menus gain **Open beside**. The canonical displayed shortcut is `⌘⇧\\`, with `⌘|` described only as a keyboard-layout alias where useful. The native application menu owns the shortcut, and the renderer fallback explicitly permits this non-text-producing chord while a composer is focused.

The session picker deliberately lists loaded/live chats because those entries have authoritative runtime and machine state. It clearly says so and identifies provider, project, machine, worktree/branch, and status. An unloaded historical session can be opened beside directly from the sidebar; that path loads and binds it before assigning a slot.

README, keybindings/help, and feature-tour content explain comparison, delegation, forwarding, focus, and companion-surface behavior.

### Narrow and data-science presentation

Two slot bindings remain intact at all widths. Both panel instances stay persistently mounted and keyed by slot; CSS presentation changes between split and tabs without remounting either chat. When the chat region cannot provide the minimum usable width to both composers, or when data-science mode docks chat into the narrow side column, presentation collapses to one visible chat with Primary/Secondary tabs. Both sessions continue streaming and retain drafts, attachments, scroll state, and runtime state. The split presentation returns automatically when enough width is available.

The threshold is based on the measured chat container, not only the browser viewport. It uses hysteresis and is frozen during split-handle drag so measurement cannot oscillate against imperative drag widths. No transition destroys the secondary binding.

### Performance and lifecycle

Provider-event reduction moves out of `ChatPanel` into one always-mounted application subscriber. The shared coalescer keeps its flush-before-non-content-event ordering; panels become scoped store views and no longer race through a `WeakSet` claim. This keeps reduction exactly once even while chat presentation changes or a terminal session temporarily replaces the chat surface. One session's tokens do not rerender the other composer. Closing a visual slot does not stop its provider process. Search listeners, split-handle pointer capture, overlays, cursor state, and selection suppression all clean up on cancellation and unmount.

## Testing strategy

Implementation follows red-green-refactor:

1. Pure reducer tests for every slot invariant, removal, rotation, restoration, duplicate prevention, and open/close/promotion rule.
2. Pure routing tests for explicit messages, terminals, IDE bindings, chat slots, and neutral fallback.
3. Store/component-contract tests for composer registration, draft copying, trust-boundary confirmation, context retention, forwarding, unread, notifications, and read state.
4. DOM/Electron coverage for nested close-focus classification, panel focus, discoverability, responsive tab presentation, split-handle cleanup, and companion binding.
5. Concurrent provider-event/coalescer coverage to prove isolated streams are still reduced once.
6. A packaged/dev Electron scenario if the current harness can create deterministic mock sessions without touching live Switchboard data.

Electron E2E runs use a dedicated temporary root and user-data directory. The harness registers exit cleanup for every directory it creates. Before running, the test records existing Switchboard temporary directories; the required post-run sweep is performed only when it cannot delete another live run, preserving both the repository cleanup mandate and the user's live sessions.

## Cross-surface scope

- **Desktop Electron:** fully affected across layout, focus, IDE, terminals, context bridge, messages, notifications, documentation, and tests.
- **React Native/iOS:** dual-pane presentation is not applicable because the app displays one thread route at a time. Existing mark-read/viewing APIs remain unchanged.
- **Native Android:** dual-pane presentation is not applicable because Android also displays one thread at a time. Existing read/viewing contracts remain unchanged.
- **Shared backend/API:** no wire change. Desktop continues reporting one focused viewing thread.
- **Stored data/migrations:** no database change. Workspace focus remains transient renderer state; any persisted layout IDs are reconciled safely.
- **Packaging/rollout:** renderer-only desktop behavior with ordinary desktop packaging. Mobile packages are unaffected and no staged flag is required.

The implementation must add `docs/feature-parity/dual-chat-workspace-focus.json` with these decisions and pass the feature-parity validator.
