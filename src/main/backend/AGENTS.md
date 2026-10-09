# Backend transport and phone protocol

Detail for this part of the code. The root `AGENTS.md` holds the rules that apply everywhere (shipping checklist, cross-surface policy, logging, writing style); they apply here too.

## Backend transport seam (local in-process ↔ remote server)

The renderer NEVER touches `ipcRenderer` directly - it calls `window.api.*` → a `Transport` (`src/shared/transport.ts`: `invoke/send/on`). The same backend handlers (`src/main/ipc/*` + `ProviderRegistry`) run behind one of two hosts (`src/main/backend/host.ts`):

- **`ElectronIpcHost`** - default. Handlers run in the Electron main process, over `ipcMain`. Fully local, no network.
- **`WsHost`** (`src/main/backend/ws-host.ts`) - the SAME handlers served over a `ws` WebSocket. Used by the standalone headless server.

**Standalone server**: `src/server/index.ts` → bundled to `out/server/index.cjs` (`scripts/build-server.mjs`, esbuild, `electron` external). A headless Node process wrapping the identical handlers under `WsHost` (default `127.0.0.1:8765`, pidfile `~/.switchboard-server/server.pid`). Run via `npm run server`. This is what runs on a remote VM; PTYs/agents/git/fs spawn THERE and stream back.

**Wire protocol**: `src/shared/ws-protocol.ts` - JSON frames `req/res/snd/evt` plus `hello/ready/ping/pong` (`encodeFrame`/`decodeFrame`), `invoke`→req/res correlated by id. `decodeFrame` validates shape, not just the `k` discriminant.

Three things beyond plain RPC, all driven by the phone case:
- **Resume.** `evt` frames carry a monotonic `seq` and `WsHost` keeps a bounded `EventReplayBuffer` (`src/shared/event-replay-buffer.ts`). A reconnecting client sends `hello { since, epoch }` and is replayed exactly what it missed. `terminal:output`/`terminal:exit` are excluded from the sequence space (`NON_REPLAYABLE_EVENT_CHANNELS`): it is high-volume and re-seeds itself on reattach, so buffering it would evict the provider events that cannot be recovered.
- **A gap can hide a turn's end.** On `onResumeGap` the desktop also re-reads the backend's sessions (`provider:list-sessions`): a chat the backend no longer runs stops showing Working, and a displayed chat that is not mid-turn reloads its transcript (a newer gap on the same machine supersedes an older one). `provider:interrupt` answers `{ live }`; every client clears a running status on `live: false` (an older backend answers nothing, and the client keeps waiting for the closing event). A Stop or `STOP_SESSION` while `startSession` is in flight is recorded: the start stops the session as soon as it exists and rejects with `SESSION_START_STOPPED`, so the waiting turn is never submitted.
- **Epoch.** `WsHost` mints a random `epoch` per process. A restarted server resets `seq` to 0, so without this a client holding a high cursor would silently discard every later event. A changed epoch, or an evicted cursor, answers `ready { gap: true }` and the client re-seeds via `onResumeGap` rather than showing a transcript with a hole in it.
- **Liveness.** The host pings every 15s and terminates clients that stop answering; the client re-dials after 40s of silence and exposes `probe()`/`forceReconnect()`. A mobile socket dies with no FIN, so elapsed silence is the only signal a client that cannot send protocol pings has. Both sides require proof the peer speaks the heartbeat before acting on its silence, because a phone updates over OTA independently of the desktop it pairs with.
- **Auth in a frame, not the URL** (`src/shared/device-auth.ts`, `src/main/backend/device-sessions.ts`). The QR carries a one-time pairing code (5 min); a device redeems it once for its own session, stored as a sha256 hash and revocable on its own. Scopes deny only what is dangerous (`terminal:*` and `mobile-pairing:*` for a phone, so a stolen phone credential can neither open a shell nor revoke your other devices) rather than allowing only what is listed - deny-by-default needs a hand-maintained channel list whose failure mode is a feature breaking silently for paired devices. Legacy `?token=` still works; `?auth=frame` declares in-band auth, and an unauthenticated socket is closed after 10s.
- **Content is incremental.** `content` events carry a delta with `append`, folded by `applyContentText` (`src/shared/content-stream.ts`). Cumulative text cost O(n^2) bytes per reply. `mergeContentChunks` is associative, which is what lets the renderer's 30fps coalescer and the phone's 50ms batcher drop intermediate commits losslessly.

**Client transports** (`src/preload/`): `IpcTransport` (local), `WsTransport` (`src/shared/ws-transport.ts`, browser WebSocket + reconnect/outbox), `HybridTransport` (desktop-only channels → IPC, everything else → remote WS), `TransportRouter` + `routing-table.ts` (one transport per machine keyed by threadId/terminal id, so one window drives local + multiple remotes at once). `SWITCHBOARD_BACKEND_URL=ws://host:8765` flips the base transport to hybrid; unset = pure local.

`src/shared/*` is the transport-agnostic contract layer (channels, wire protocol, transport interface, events, types) - **no `electron`, no `react` imports**. Consumed by preload AND both backend hosts.

**Remote machines / SSH** (`src/main/machines/`): `ssh-tunnel.ts` builds `ssh -L localPort:127.0.0.1:remotePort … <bootstrap>` (uses the system `ssh` binary - no `ssh2`/native deps; `BatchMode`, `accept-new`), `connection-manager.ts` owns connect/provision/health-probe/auto-reconnect, plus `provisioner.ts`/`remote-exec.ts`/`reconnectBackoff.ts`/`ssh-config.ts`. The renderer then connects to `ws://127.0.0.1:<localPort>` as if local. Docs: `docs/notes/ssh-remote-plan.md`, `docs/notes/remote-machines-handoff.md`. No mobile client and no cloud relay - the "remote client" is the desktop app pointed at a tunneled remote backend.

## History windows (`history_window_v1`, `history_image_refs_v1`, `history_tool_previews_v1`)

`app:load-session-by-id(id, { window: true, limit: 200, beforeId?, imageRefs?, toolPreviews? })`
returns at most 200 chronological rows, `total`, `truncated`,
`nextBeforeId` (the oldest returned id when more older rows exist, else null),
and `cursorReset` (a removed cursor returns a fresh tail). Phones feature-detect
`history_window_v1`; an older backend still gets the legacy `{ limit }` call.
Callers without `window` keep the original contract.
This bounds wire rows, not JSONL parsing. Keep parse caching separate.
The desktop opens every chat with the newest 200 rows (`NEWEST_HISTORY_WINDOW`
in `renderer/services/history-loader.ts`), keeps the session's
`olderHistoryCursor`, and loads the previous window when the list nears its
top, keeping the row in view in place. It also asks `imageRefs: true`: base64
images come back as `MessageImage.ref` (message id, index, byte size, with
`mimeType`) and `app:load-history-image` serves the bytes when a thumbnail
scrolls into view. A fork anchor digested over a referenced image still
matches (`fork-anchor.ts`). It asks `toolPreviews: true` too: a tool call with
more than 2,000 characters of input or output arrives shortened with
`preview: true` (`shared/history-tool-previews.ts`; JSON input keeps its keys,
each string cut to 200 characters, so the collapsed row reads the same), and
`HistoryToolCall` loads the whole call through `app:load-tool-call` on the
first click. A fork anchor digested over a preview matches too, and export
reloads a chat that holds previews (`holdsWholeHistory`). Phones ask for
neither, so they keep data URLs and whole tool calls; an older backend ignores
these options and answers in full.

`loadConversationHistory` keeps the merged history of up to 8 chats (200,000
messages) and reuses it while the parse cache returns the same transcript
arrays and `message_revisions` (one counter per conversation, bumped by
SQLite triggers on every insert, update and delete of its `messages` rows)
is unchanged. The revision is read before the rows, so a write in between
leaves the memo stale-by-revision, never stale-by-content. A returned history
is shared: never mutate it. `app:load-tool-call` reads a finished call from
that memo without re-checking it.

WsHost servers (`wsServerOptions`: the headless server and the phone
endpoint) negotiate permessage-deflate for frames of 4 KiB or more, with no
context takeover. Chromium and OkHttp (Android, Expo on Android) offer it;
iOS's WebSocket does not and gets plain frames. OkHttp refuses a response
naming `client_max_window_bits`, which `ws` sends only when the client offered
it (`ws-host-deflate.test.ts` pins OkHttp's offer). TcpHost (IAP) is NDJSON
and unchanged.

Clean replay resumes reuse the in-memory history cache; disk restores and real
gaps reload it. Android's ProtocolEventHub updates the cache synchronously
before publishing replay events, so an absent screen cannot lose the replay.
Live events render during a refresh and are reconciled when its snapshot lands.
Never hide a connected thread behind the saved-messages banner for a background
refresh. A foreground return after under 10 s probes; a longer absence reconnects.
On the WebSocket host `ready` and ping answers shipped together (74dcf945), so a
`ready` frame is heartbeat proof there. The IAP TCP host needs `heartbeat_v1`; without
it the phone hands the tunnel to connect() instead of probing.
