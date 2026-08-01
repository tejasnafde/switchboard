# Unread indicators missing for remote chats - diagnosis

STATUS: complete (diagnosis). Fix tracked on branch feat/mobile-app.

## Root cause

Pure rendering omission. Local session rows render `<UnreadBadge sessionId={s.id} />`
(`src/renderer/components/sidebar/Sidebar.tsx:742`) and project headers render
`GroupUnreadBadge` (`Sidebar.tsx:662`). Remote session rows are rendered by
`src/renderer/components/sidebar/MachineLayer.tsx:136-150`, which renders only a
status dot + title + time - no badge component at all.

The count path is machine-agnostic and already works for remote:
- `agent-store.ts:259-261` increments `unreadCount` for assistant messages on
  non-active sessions.
- `ChatPanel.tsx:292` global subscription -> `onProviderEvent`; the remote filter
  `shouldDeliverProviderEvent` (`session-events.ts:81-87`) passes because preload
  stamps `event.machineId` (`preload/index.ts:553-554` via TransportRouter) and
  the session carries the same machineId. Remote turn-completed notifications
  already fire, proving event flow.

## Minimal fix

1. Export `UnreadBadge` / `GroupUnreadBadge` from `Sidebar.tsx` (currently
   module-private), or lift into a shared `UnreadBadge.tsx`.
2. Render `<UnreadBadge sessionId={s.id} />` in the MachineLayer session row
   (~line 147). MachineLayer already imports `useAgentStore`.
3. Optional parity: `GroupUnreadBadge` on remote project/machine headers.

## Known ceiling

Only surfaces unread for remote sessions already present in agent-store (opened
once this app run). Never-opened snapshot sessions stay at 0 until opened -
fixing that needs a background subscription for snapshot sessions (larger
change, deliberately out of scope).
