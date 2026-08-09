# Task: cross-session messaging phase 1 (same backend, user-directed)

## Plan
- [x] 1. pure guards module `src/shared/peer-messaging.ts` + tests (16 green)
- [x] 2. registry `deliverPeerMessage` + `peer.message` RuntimeEvent + IPC channel + WS tests (8 green)
- [x] 3. preload plumbing + routing key (fromThreadId in OBJECT_KEY_PRIORITY, +1 test)
- [x] 4. `/send-to` parsing + target resolution (pure, renderer) + tests (12 green)
- [x] 5. UI wiring: ChatPanel intercept, /send-to registry entry (takesArgs), peer marker kind
- [x] 6. full gate green: typecheck clean, 213 files / 2181 tests

## Current step: DONE

## Next concrete action
None. Phase 1 complete. Out of scope by design: agent-callable send tool,
cross-backend routing, hold/approve trust tiers, receiver notification.

## Files touched so far
- CHECKPOINT.md
- src/shared/peer-messaging.ts (new)
- src/shared/provider-events.ts (peer.message event)
- src/shared/ipc-channels.ts (DELIVER_PEER_MESSAGE)
- src/main/db/database.ts (getConversationTitle)
- src/main/provider/provider-registry.ts (deliverPeerMessage handler)
- tests/unit/peer-message-delivery-ws.test.ts (new, 8 green)
- src/preload/routing-table.ts + tests/unit/routing-table.test.ts (fromThreadId key)
- src/preload/index.ts (provider.deliverPeerMessage)
- src/renderer/components/chat/sendToCommand.ts (new) + tests/unit/send-to-command.test.ts (12 green)
- tests/unit/peer-messaging-guards.test.ts (new)

## Design decided (do not re-litigate)
- Guard constants: 16 KiB body cap, 5 sends per (from,target) per 60_000 ms,
  identical content-addressed id dropped within 10 min. `now` is injected on
  every call; no clock inside the module.
- Content-addressed id: `pm_<16 hex>` = pure-TS FNV-1a 64 over
  `fromThreadId \0 targetThreadId \0 text`. No node:crypto - `src/shared/*`
  has zero node imports and is consumed by the RN app.
- Wire wrapper lives in shared (`wrapPeerMessage`) so the renderer can rebuild
  the receiver bubble's `content` without the event carrying it twice.
- Delivery goes through the SAME code path as `ProviderChannels.SEND_TURN`
  (extracted private `runSendTurn`). `respondToRequest` is never called, so a
  peer message structurally cannot resolve a pending approval.
- Target resolved through `resolveRootThreadId` before the adapter lookup
  (CLAUDE.md gotcha: sidebar surfaces the rotated Claude session UUID).
- New event `peer.message` with `direction: 'sent' | 'received'` - one type,
  emitted on both threads. Sender renders a marker pill, receiver a user
  bubble whose `displayBody` names the provenance.
- Sender marker prefix `[[sb:peer-sent]]` lives in shared/peer-messaging.ts
  (main writes it too, so it cannot live in renderer/rotationMarker.ts).
  `parseRotationMarker` gains kind `'peer'`; the `<from> → <to>` shape is
  exactly what that parser already reads.
- `getSystemMarkerMessages` already matches `content LIKE '[[sb:%'`, so the
  sender marker survives a JSONL reload with no DB change.
- `/send-to` is an args-taking built-in: selecting it in the menu INSERTS
  `/send-to ` (like agent-source skills) instead of running. `SlashCommand`
  gains `takesArgs?: true` for that branch.

## Gotchas learned
- `npm install` is required in a fresh worktree (done).
- Registry handlers register in `ProviderRegistry.registerIpcHandlers()`, which
  both `ElectronIpcHost` and `WsHost` construct - no separate server wiring.
- `tests/unit/provider-switch-ws.test.ts` mocks `src/main/db/database`; any new
  DB function the registry calls must be added to that mock or the test throws.
- `RoutingTable.resolve` keys on `OBJECT_KEY_PRIORITY`; `fromThreadId` must be
  added there or a remote sender's call silently lands on the local backend.
