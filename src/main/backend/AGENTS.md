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
- **Auth in a frame, not the URL** (`src/shared/device-auth.ts`, `src/main/backend/device-sessions.ts`). The QR carries a one-time pairing code (5 min); a device redeems it once for its own session, stored as a sha256 hash and revocable on its own. Scopes deny only what is dangerous (`terminal:*` and `mobile-pairing:*` for a phone, so a stolen phone credential can neither open a shell nor revoke your other devices) rather than allowing only what is listed - deny-by-default needs a hand-maintained channel list whose failure mode is a feature breaking silently for paired devices. The headless server's `SWITCHBOARD_TOKEN` still accepts `?token=`; the desktop's phone endpoint does not (see below). `?auth=frame` declares in-band auth, and an unauthenticated socket is closed after 10s.
- **Credential settings rows are admin only, for reads and writes** (`ADMIN_ONLY_SETTING_FAMILIES` in `src/shared/device-auth.ts`, enforced by `isSettingsFrameAllowed` in both hosts). `settings:get`/`set`/`remove` are open channels, so the gate is per key: `deviceSessions`, `devicePairingCode`, `mobilePairing.*`, `pushTokens`, `opencode.env.*` and `google.clientSecret`. A name ending in `.` is a prefix family. A new settings key that holds a credential or a grant goes in that list; `tests/unit/settings-device-auth-gate.test.ts` pins it. The desktop's own IPC is not gated.
- **TLS on the same port** (`tls.ts`, `src/shared/transport-security.ts`). The phone endpoint and the headless server mint one self-signed EC certificate per install (`<data dir>/tls/`, key 0600; hand-built DER because Node cannot create certificates) and serve it through `DualWebSocketServer`, which reads the first byte of each connection: a TLS handshake record goes to an https server, anything else to plain http, both feeding one `ws` server. The QR stays `ws://host:port?pair=<code>` plus `&fp=<sha256 hex>` (`withCertPin`), so a phone that predates this ignores `fp` and keeps ws://. A phone that pins dials wss:// on the same port and treats a different certificate as terminal (re-pair). Deleting `tls/` therefore breaks every pinned phone until it re-pairs. Store builds refuse plain ws:// to a non-loopback host (`cleartextRefusal`); loopback, `10.0.2.2` and the IAP tunnel keep their transport. The native Android release build is stricter: cleartext only to `localhost`, `127.0.0.1` and `::1` (`res/xml/network_security_config.xml` and `CleartextPolicy`, kept equal, the scaffold contract test refuses `10.0.2.2` there), because on a real phone `10.0.2.2` is an ordinary LAN address. Debug builds allow any host.
- **Apple TLS verification**: `tests/unit/backend-apple-tls.test.ts` compiles a small Swift URLSessionWebSocketTask probe on macOS (requires `swiftc`) against the real `DualWebSocketServer` and persisted `loadOrCreateTlsIdentity` certificate. It checks matching and mismatching leaf SHA-256 pins, default TLS and forced TLS 1.2. `backend-tls.test.ts` splits a ClientHello after its first byte for TLS 1.2 and 1.3. A macOS CLI pass does not establish iPhone or Expo bridge compatibility. Preserve install certificates unless an actual incompatibility is reproduced; rotating one requires every paired phone to re-scan.
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
A window request never builds the full history: `loadConversationHistoryWindow`
(`conversations/history-window.ts`, `mergeHistoryWindow`) takes the transcripts
from the parse cache and reads SQLite rows by index range only, from one whole
turn before the window to one turn after it, plus the rows that share an id
with a transcript line in that range (`messageWindowRows` in `db/messages.ts`),
then merges and enriches only those. An assistant row matches only inside its
turn and a user row within a minute, so the result equals the same window cut
from the full merge (`history-window-merge.test.ts`, `history-window-sql.test.ts`
page both and compare). Every older page costs the same. In window mode `total`
is an estimate (the larger of the transcript and stored counts). A window is
also capped at 1 MiB of JSON (`capWindowBytes`, at least one row), so a phone
that takes whole tool calls may get fewer than 200 rows and pages on through
`nextBeforeId`; `chat-load-payload-ceiling.test.ts` fails CI when a window or
an older page grows past its ceiling. `app:load-history-image` and
`app:load-tool-call` misses read one message the same way (`throughId`).
Full-history readers, on purpose: fork (anchors need every row), the handoff
preamble and the merge-back summary (`provider-registry.ts`), and the desktop's
`ensureFullHistory` (cmd+F, global search, export, a jump to an old row).
The desktop opens every chat with the newest 200 rows (`NEWEST_HISTORY_WINDOW`
in `renderer/services/history-loader.ts`), keeps the session's
`olderHistoryCursor`, and prefetches the previous window (`shouldLoadOlder` in
`renderer/services/history-window.ts`: the first turn in view is among the
oldest quarter of the loaded turns, or within 3,000 px of the top, or 6,000 px
while the pointer is in the top fifth of the list or the list has focus), keeping
the row in view in place. `MessageList` applies a size correction above the
view itself and re-renders in the same frame (the virtualizer's own correction
re-rendered a frame late, which painted the jump), and after a prepend renders
the rows around the kept row before paint. `e2e/history-prepend.e2e.mjs`
checks the row in view never moves. It also asks `imageRefs: true`: base64
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
refresh. A foreground return after under 10 s resumes; a longer absence reconnects.
Resume (Android `AuthenticatedWsCoordinator.resume`, `WsTransport.resume`) never
trusts the state the app left: a ready socket gets a 3 s ping and is redialled at
once when silent, a connection between retries or parked offline (Android also
after a handshake timeout) dials now, and a handshake in flight gets a fresh
timeout. Android destroys a frozen app's TCP sockets, and a frozen process's
executor clock keeps running, so a timer armed before a freeze fires on thaw.
Desktop logs from 2026-10-19 show it: every phone disconnect closed from the
phone side with no heartbeat warning, and an FCM push woke the app for a 3 to
5 s reconnect. Android's OkHttp client also sends WebSocket pings every 15 s,
which the ws server answers on its own, and a default-network change while
visible resumes every connection. Auth rejection, a changed certificate and a
user disconnect stay stopped. `FleetLeasedRemoteRpc` listeners match the
coordinator's current generation, which a redial inside the lease bumps.
On the WebSocket host `ready` and ping answers shipped together (74dcf945), so a
`ready` frame is heartbeat proof there. The IAP TCP host needs `heartbeat_v1`; without
it the phone hands the tunnel to connect() instead of probing.

## Push token ownership and revocation

`push:register` records `deviceSessionId` from the backend request context,
never from client arguments. `revokeSession` deletes that session's push tokens
and viewing leases before closing its live sockets. Socket revocation runs in
`finally` even if push-settings persistence fails. The existing
`push:unregister(token)` request is idempotent and is used by both phones before
unpair teardown. A token with no owner (registered before ownership tracking,
or by a legacy shared-token or IAP phone) is deleted by ANY revoke, because it
may be the revoked phone's; a phone that keeps access registers again on its
next connect. `listSessionViews` leaves revoked sessions out (a row that stays
reads as if Revoke did nothing); its tombstone stays in the store.
The desktop's phone endpoint (`MobileEndpoint`) accepts device sessions only.
The old shared token (`mobilePairing.token`) is retired: `apply()` deletes the
stored value, the endpoint starts only from `mobilePairing.enabled`, and a
phone that still dials `?token=` is closed with 4001. Phones show
`CONNECTION_SECURITY_COPY.removed` ("This computer removed this phone. Pair
again.") on any 4001, so no phone change was needed
(`mobile-legacy-token-retired.test.ts`).

## Device names and the Devices tab

A custom name (`customName`, optional, on the session row) is set from the
desktop only, through `mobile-pairing:rename` (`renameSession`; null or blank
clears it, bounded to 128 characters). It sits under the `admin` scope like
every `mobile-pairing:` channel. A re-reported identity never overwrites it,
and `deviceDisplayName` (custom, then reported, then the pairing label) is the
one name the desktop shows. The Settings list rules (groups, search, the
30-day inactive fold, relative and absolute dates) are pure, in
`renderer/components/settings/device-list.ts`; nothing expires a device on its
own, "Revoke inactive" asks first and lists what goes.

## Device identity (`device_identity_v1`)

Phones send `device { installId, name, manufacturer, model, platform,
osVersion, appVersion }` (`src/shared/device-identity.ts`) on the pairing auth
and on every session auth. They send it before they know the capability,
because `ready` (which carries capabilities) only follows a successful auth; an
older backend's `decodeFrame` rebuilds the auth frame from known keys and drops
it. `decodeFrame` drops a malformed identity, never the credential. The
identity and the normalised remote address (`lastAddress`) are stored on the
session in the `deviceSessions` setting; rows from before have neither and
stay valid. A pairing whose installId an unrevoked session holds revokes that
session through `revokeSession` (socket closes, push tokens go). Only a
pairing does this, because it already needs the one-time QR code. `WsHost`
refreshes `lastSeenAt` on traffic at most once a minute per connection
(`LAST_SEEN_REFRESH_MS`; the 15 s heartbeat pongs keep traffic flowing), and
`onlineSessionIds()` feeds the in-memory `online` flag of
`mobile-pairing:devices`. All new view fields are optional. iOS stores its install
id in the keychain with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it survives a
reinstall but not a restore to another phone. Android mints its own in
`noBackupFilesDir` (`NoBackupInstallIdStorage`), out of Auto Backup and device
transfer for the same reason, so a reinstall there gets a new id and the old
row stays until it is revoked. A failure to store it sends no identity.
