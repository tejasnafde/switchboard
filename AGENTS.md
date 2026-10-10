# Switchboard

The one agent-instructions file for this repo. `CLAUDE.md` imports it; do not
edit `CLAUDE.md` for anything that is not Claude-Code-specific.

Electron workspace that multiplexes terminals, agent chats (Claude Code + Codex + OpenCode), a kanban board, and an embedded VS Code IDE into one surface per project.

## Stack

- **Shell**: Electron 33 + React 19 + TypeScript 5.7
- **Build**: electron-vite + Vite 6
- **Terminal**: `@xterm/xterm` 6 + `node-pty` (native, rebuild after install)
- **IDE**: embedded VS Code workbench via code-server (Coder, MIT) in a single reused `<webview>`; binary downloaded on demand to userData, never bundled
- **UI primitives**: shadcn/ui (Radix) in `src/renderer/components/ui/` on Tailwind 4 utilities only (`styles/tailwind.css`: no preflight, no default theme, scanned from `components/ui` plus the files listed in `tailwind.css`, tokens mapped onto the theme variables). New menus, popovers and dialogs use `ui/popover` and `ui/dialog` (Radix) rather than hand-rolled outside-click, Escape and focus code (a few older ones, such as the sidebar context menu and the native session import modal, are still hand-rolled); `DialogContent` returns focus to whatever had it on open (or the composer), since these dialogs open from shortcuts with no `Dialog.Trigger`. Focus an input from `onOpenAutoFocus`, not `autoFocus`: autoFocus runs first, so Radix records the input itself as the element to return focus to. Never `window.confirm`: it is a native alert that blocks the renderer and Playwright cannot click it. Use `if (!(await confirm({ title, body, confirmLabel, destructive }))) return` from `components/ui/confirm` (`ConfirmHost` is mounted in `App`)
- **Chat input**: Lexical (`@lexical/react`) rich textarea with inline pill chips + `@`-mention file autocomplete
- **Agents** (3, all behind the `ProviderAdapter` interface):
  - Claude Code via `@anthropic-ai/claude-agent-sdk` (streaming-input mode, AsyncIterable prompt queue, `canUseTool` callback)
  - Codex via `codex app-server` over stdio JSON-RPC 2.0
  - OpenCode via `opencode acp` over the Agent Client Protocol (`@agentclientprotocol/sdk`), long-lived stdio child
- **State**: Zustand - `agent-store`, `terminal-store`, `layout-store`, `theme-store`, `draft-store`, `kanban-store`, `provider-instance-store`, `skill-store`, `bookmark-store`
- **DB**: `better-sqlite3` at `~/Library/Application Support/switchboard/data/switchboard.db` (FTS5 enabled; path = `app.getPath('userData')/data/switchboard.db`)
- **Logger**: file-based in `~/Library/Application Support/switchboard/logs/` with 7-day retention

## Commands

- `npm run dev` - launches Electron (auto-unsets `ELECTRON_RUN_AS_NODE`)
- `npm test` - vitest
- `npm run test:watch` - vitest in watch mode
- `npm run typecheck` - main + renderer tsc
- `npm run build` - **gated build**: `prebuild` runs typecheck + test before the actual build fires; `postbuild` runs `scripts/smoke-test.mjs`
- `npm run build:fast` - escape hatch, skips the gate
- `npm run rebuild` - rebuild `node-pty` + `better-sqlite3` for Electron

## Shipping checklist (MANDATORY, 2026-07-21)

Nothing merges to main or ships in a release without, in order:

1. `/deslop` - strip AI slop from the branch diff
2. `/review` (code review) - finder + verify pass over the diff; every CONFIRMED finding gets fixed or an explicit written deferral
3. `/deslop` again over the review fixes
4. Full gate green: `npm run typecheck` + `npm test`

Applies to every batch including "small" fixes. Releases additionally
require green CI on main first (see docs/releasing.md).

If the batch goes through a pull request, CodeRabbit reviews it automatically
(config in `.coderabbit.yaml`, no workflow). It is a second opinion, not a
replacement for step 2: it sees only the PR diff and it does not block the
merge button. Read its findings, then fix or dismiss each one. Work merged
from a local branch without a PR never gets reviewed by it.

## Cross-surface feature policy (merge-blocking)

Every feature or behavior change must be planned as one Switchboard product change, not as a Desktop-only implementation. Before editing, explicitly scope all of these impact areas:

1. Desktop Electron (`src/main`, `src/preload`, `src/renderer`)
2. React Native/iOS (`apps/mobile`)
3. Native Android (`apps/android`)
4. Shared backend/API contract
5. Stored data, migrations, and upgrade compatibility
6. Update channels, release packaging, and rollout

For each affected slice, carry the work through storage → API → state → UI → lifecycle → tests, keeping every app installable and releasable. Preserve package identity, signing, deep links, stored data, API semantics, and update compatibility. Do not claim cross-platform parity from compilation or unit tests alone; record automated, hardware, and unexercised verification separately.

Any pull request that changes behavior-bearing product paths must add or update `docs/feature-parity/<feature>.json`. The manifest must cover every impact area. Use `not_applicable` only with a concrete reason. Incomplete cross-surface work is allowed only as `staged`, with both a named feature flag and a named follow-up release; unflagged staged behavior must not merge. Run `npm run validate:feature-parity -- --base <base-ref>` locally. The schema and workflow are documented in `docs/plans/2026-08-20-cross-surface-feature-policy-design.md`.

## Build gate (2026-04-20)

`npm run build` fails the entire build if typecheck or tests fail. The `prebuild` npm lifecycle hook chains `typecheck && test` before `electron-vite build`. This caught real regressions on the first run - see CHANGELOG.md.

## Known gotchas

- **Transcript caches**: `jsonl-cache.ts` keys by parser source and path plus size, mtime, ctime, inode and device; changed reads are not cached. Its 24-entry/128 MiB LRU budgets estimated retained message memory, not raw JSONL bytes (large discarded tool results must not evict both account copies). `transcript-compatibility.ts` caches only validated whole-file evidence and per-record SHA-256 digests, bounded to 24 paths/100,000 records, with the same file-state checks. Metadata alone never proves two different files equal. Preserve every copy/replacement validation and the source-only settle retries. `loadJsonlCopies` parses the largest profile copy of a session and skips a smaller copy only when its sha256 equals the same-length prefix digest of the largest; a cached file that grew from a state ending on a newline parses only the new bytes, once the old bytes hash to the cached digest. The desktop opens a window (see History windows); cmd+F, global search, fork anchors, export and the handoff preamble load the full history (`ensureFullHistory`, or a backend read).

- `ELECTRON_RUN_AS_NODE=1` is set by Claude Code's shell - `dev` script unsets it explicitly
- `electron` MUST be in `devDependencies`, not `dependencies`
- After `npm install`, run `npm run rebuild` for `node-pty` + `better-sqlite3`
- Claude Code encodes project paths by replacing EVERY non-alphanumeric char (`/`, `_`, `.`, etc.) with `-` in `~/.claude/projects/` - so `/.claude/worktrees/x` becomes `--claude-worktrees-x` (double dash). `encodeClaudeProjectPath` must match this exactly; a stale `/[/_]/g` (missing `.`) mis-filed migrated transcripts under `-.claude-...` and broke resume across profile switches with "No conversation found with session ID"
- Scanner uses **exact dir match** (not substring) - parent paths don't pick up child-project sessions (pre-2026-04-20 bug)
- `canUseTool` overrides the SDK's `permissionMode: 'plan'` - we enforce plan mode explicitly via `decidePermission`
- **Any new per-conversation setting must resolve through `resolveRootThreadId` before touching the `conversations` table.** Claude assigns a session UUID after the first turn; the sidebar then surfaces that UUID as `session.id` instead of the synthetic `agent_<ts>` id the setting was saved under, so a raw `WHERE id = ?` read/write silently misses the row and the setting appears to reset. `thread_sessions` (+ `resolveRootThreadId`) already maps rotated ids back to the original - hit twice so far (`getConversationRuntimeMode`/`setConversationRuntimeMode`, `getConversationProviderInstanceId`/`setConversationProviderInstanceId`, all in `src/main/db/database.ts`) because each was added without reusing that helper. This must be enforced by the shared code path (or a test, see `tests/unit/conversation-rotation-fallback.test.ts`), not by memory - check every future per-conversation getter/setter against this.
- **macOS TCC for project paths under `~/Desktop`/`~/Documents`/`~/Downloads`**: PTYs and the embedded SDK inherit Switchboard.app's TCC grants. If the user toggles "Files and Folders" on after launching, the running process is still denied - every FS call returns `EPERM` until ⌘Q + relaunch. We mitigate two ways:
  1. `electron-builder.yml` declares `NSDesktopFolderUsageDescription` / `NSDocumentsFolderUsageDescription` / `NSDownloadsFolderUsageDescription` via `mac.extendInfo`, so first access triggers a proper consent dialog.
  2. `src/main/path-access.ts` (`assertCwdReadable`) runs as a pre-flight in `provider-registry`'s `START_SESSION` handler. If the cwd is TCC-protected and `fs.access(R_OK)` returns `EPERM`/`EACCES`, we throw `TccAccessError` with copy that names the cause and the fix. The error surfaces in chat as a system message instead of a deep-stack SDK failure, complete with an inline "Relaunch to Apply Permissions" button.

## Architecture

### Backend transport seam (local in-process ↔ remote server)

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

### History windows (`history_window_v1`, `history_image_refs_v1`, `history_tool_previews_v1`)

`app:load-session-by-id(id, { window: true, limit: 200, beforeId?, imageRefs?, toolPreviews? })`
returns at most 200 chronological rows, `total`, `truncated`,
`nextBeforeId` (the oldest returned id when more older rows exist, else null),
and `cursorReset` (a removed cursor returns a fresh tail). Phones feature-detect
`history_window_v1`; an older backend still gets the legacy `{ limit }` call.
Callers without `window` keep the original contract.
This bounds wire rows, not JSONL parsing. Keep parse caching separate.
The desktop opens every chat with the newest 200 rows (`NEWEST_HISTORY_WINDOW`
in `renderer/services/history-loader.ts`), keeps the session's
`olderHistoryCursor`, and prefetches the previous window (`shouldLoadOlder` in
`renderer/services/history-window.ts`: the first turn in view is among the
oldest quarter of the loaded turns, or within 3,000 px of the top), keeping
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
refresh. A foreground return after under 10 s probes; a longer absence reconnects.
On the WebSocket host `ready` and ping answers shipped together (74dcf945), so a
`ready` frame is heartbeat proof there. The IAP TCP host needs `heartbeat_v1`; without
it the phone hands the tunnel to connect() instead of probing.

### Mobile app (`apps/mobile/`)

Expo SDK 57 React Native client for the same backends. Talks to a desktop app
or a headless server through `WsTransport`, or to an IAP-tunnelled VM through
`IapTransport` (NDJSON over the raw TCP stream IAP gives us - `TcpHost` serves
that side). Imports `@shared/*` and nothing else from the repo.

**Two update lanes.** `mobile-ota.yml` publishes JS-only changes over
expo-updates; `mobile-release.yml` builds an APK on EAS and attaches it to a
`mobile-v*` GitHub Release, which the app installs itself
(`src/lib/self-update.ts`). Native changes - a new module, a permission, an SDK
bump - MUST take the APK lane. `runtimeVersion` uses the **`fingerprint`**
policy (changed 2026-08-01, was `appVersion`), so the hash covers native deps,
config plugins and the native-affecting parts of app.json. An OTA can therefore
only reach a binary whose native side matches it, with nobody having to
remember anything. `appVersion` pinned to the version *string*, so adding a
native module without bumping `version` shipped a bundle to an APK that lacked
it. `.fingerprintignore` keeps generated (`/android`, `/ios`) and test-only
paths out of the hash. Switching policy re-targets every future update, so
APKs built before the switch need replacing once.

**Android release builds block cleartext, and dev builds do not.** RN's Gradle
plugin sets `usesCleartextTraffic=false` for the release build type, and Expo's
main manifest sets nothing, so targetSdk 28+ defaults to blocking it. Our whole
transport is `ws://`, so a `preview`/`production` APK failed every connection
while `expo run:android` worked. `plugins/withAndroidCleartextTraffic.js` sets
the attribute on the main manifest; iOS needs `NSAllowsArbitraryLoads` plus
`NSLocalNetworkUsageDescription` (both in app.json) for the same reason. Verify
after touching either with `npx expo prebuild -p android --clean` then grep the
manifest, and delete the generated `android/` afterwards (prebuild also rewrites
the `android`/`ios` npm scripts for a bare workflow; revert that).

**Push** (`src/main/push/`, `src/shared/push-policy.ts`): the BACKEND sends,
because the phone is asleep when it matters. `attachPushNotifier` subscribes to
the provider registry's bus and posts to Expo for approvals, questions, turn
end and errors only. Devices report which thread they have open so they are not
notified about the screen in the user's hand, and registration carries the
client's connection id, echoed back so a tap knows which backend to open.
Android needs FCM credentials on the EAS project - see the Firebase section in
CLAUDE.local.md. A new registry is created when a closed window is reopened, so
the notifier must be re-attached there.

**Testing: two runners, one rule.** Pure logic goes in the root vitest suite
(`tests/unit/**`, `@shared` alias resolves). Anything importing react-native
CANNOT load there, so components get jest instead: `npm test --prefix apps/mobile`,
config in `apps/mobile/jest.config.js`, tests in
`src/**/__tests__/**/*.test.{ts,tsx}`. The globs do not overlap (vitest matches
`.ts` under `tests/unit/` only), so neither runner sees the other's files. **A
root `npm install` is required as well as the mobile one** - the tests reach
`@shared/*` outside the package, so babel resolves its runtime helpers from the
root `node_modules`. CI runs the jest suite on the ubuntu runner only.

Keep decision logic in `src/lib/*.ts` (vitest) and assert only what RENDERS in
jest - `lib/composer.ts` and `lib/gestures.ts` hold the rules, and the component
test checks the glyph and label those rules produce. PanResponder derives
gesture state from real touch history, so a drag cannot be faked by calling the
handlers. Note that a plain `Pressable` tap is NOT a gesture and can be driven
with `root.findByProps({...}).props.onPress()` inside `act`; no handler is
currently exercised, so `onSend`, `onStopTurn` and tool-output expansion have no
coverage.

Three traps in that jest setup, all cost time:
- `@testing-library/react-native` 14 returned an EMPTY render result under this
  React 19 / RN 0.86 / jest-expo combination, even for a bare `<View>`, so
  `src/test/render.tsx` drives `react-test-renderer` directly. RNTL is NOT a
  dependency, so that finding cannot be re-verified from the repo; re-test it
  before assuming it still holds. `react-test-renderer` is itself deprecated by
  React, so this foundation has a shelf life.
- `findAll` visits composite instances as well as host ones. Without
  `{ deep: false }` every icon is found twice (the mock's testID rides on both),
  and a name comparison against `node.type` matches the composite. Host-node
  counts must test `typeof node.type === 'string'`.
- A decorative `Animated.loop` keeps firing on real timers after its test ends
  and crashes the worker inside react-native's `Easing` once jest tears the
  module registry down. `src/test/render.tsx` unmounts after every test.

**Looking at it.** `DevGalleryScreen` (dev-only route, linked from the bottom of
Connections) renders assistant text, tool calls and composer states on one
screen, for states that are awkward to reach on purpose. It is NOT every feed
row: `user`, `approval`, `question`, `plan`, `fileEdit`, `denial`, `error` and
`notice` are absent, and `approval`/`question` are the two most stateful.
Adding them means lifting their handlers out of `ThreadScreen` first (the
row components themselves live in `src/screens/ThreadFeedItems.tsx`, the
screen's styles in `ThreadScreen.styles.ts`). Its
loading and empty tiles are replicas against the gallery's own stylesheet, not
the production path, so they would not have caught the upside-down loader
(a `scaleY: -1` on `ThreadScreen`'s `emptyWrap` under the inverted `FlatList`).
`BuildStamp` shows version + channel + OTA id, and names an emergency launch
separately, because an APK plus stacked OTAs means the version alone does not
identify what is running.

**Trap that cost a whole debugging cycle:** if `expo-doctor` reports dependency
drift, fix it before believing anything else. A react-native/metro version
mismatch made Metro unable to resolve files outside the project root, which is
how this app reaches `src/shared`, and it surfaced only as a failed
"Bundle JavaScript" phase on EAS. `npx expo install --fix`, and keep doctor at
20/20.

### Window → Row → Window → Pane model (terminals)

- `Row` = horizontal container (full-width stack of columns)
- `Window` = column within a row; holds stacked panes as tabs
- `Pane` = a single xterm instance (tab inside a window)
- `⌘T` new window in row · `⌘⇧T` new window in new row · `⌘\` new tab in window · `⌘⇧]`/`⌘⇧[` cycle tabs · `⌘1-9` focus window · `⌘⌥+arrows` navigate
- Panes default `cwd` to the active session's `projectPath` (fixed 2026-04-20)
- `terminal-registry.ts` - module-level `Map<id, TerminalInstance>` outside React; panes survive re-renders / panel toggles / StrictMode double-mount
- `PaneResizeHandle.tsx` / `ResizeHandle.tsx` - pointer-capture + rAF drag handles, callbacks in refs to avoid tearing down mid-drag

### Provider bridge (`src/main/provider/`)

- `types.ts` re-exports from `src/shared/provider-events.ts` so renderer can type the IPC boundary
- `ProviderKind = 'claude' | 'codex' | 'opencode'`
- `ProviderAdapter` interface - required: `startSession(opts, onEvent)`, `sendTurn(threadId, message, runtimeMode?, images?)`, `interruptTurn`, `respondToRequest`, `stopSession`, `setRuntimeMode`, `isAvailable`. Optional: `setModel?`, `answerQuestion?`, `listSkills?`, `cancelQueuedTurn?`, `promoteQueuedTurn?`
- **`policy.ts` is the shared policy module** (2026-04/05 - was previously inlined in claude-adapter). All three adapters import from it:
  - `decidePermission(mode, toolName) → 'allow' | 'deny' | 'prompt'` - pure, unit-tested
  - `denialMessage(mode, toolName)` - human-readable denial reason
  - `PLAN_READ_ONLY_TOOLS` - Read/Glob/Grep/NotebookRead/WebFetch/WebSearch/TodoWrite (+ Codex equivalents `read_file`/`list_files`/`search_files`/`fetch`) allowed in plan mode, everything else denied
  - `CUSTOM_UI_TOOLS` - AskUserQuestion + ExitPlanMode (+ Codex `ask_user_question`/`exit_plan_mode`) skip `tool.started` emission so the custom cards render instead of raw JSON
- `event-bus.ts` - `RuntimeEventBus` (EventEmitter) decouples adapter event emission from the renderer, so N subscribers (renderer, future telemetry) can listen instead of 1:1 `webContents` coupling
- `env-overlay.ts` - merges a provider-instance env overlay into the spawn env (skips empty strings so partial configs don't blank defaults)
- `claude-session-migrate.ts` - copies Claude SDK session JSONL across `oauth_dir` when rotating provider instances mid-flight, so resume survives a credential switch

### Runtime events (wire format)

Defined in `src/shared/provider-events.ts`. Discriminated union:

- `content` · streaming text, `streamKind: 'assistant' | 'reasoning' | 'plan'`
- `tool.started` · tool call begun (skipped for custom-UI tools)
- `tool.completed` · tool finished
- `tool.denied` · **2026-04-20**: `canUseTool` hard-denied (e.g. Plan mode blocked Write) - UI renders denial pill
- `request.opened` / `request.closed` · approval prompt flow (`requestType: 'command' | 'file' | 'tool'`)
- `turn.completed` · turn ended, with `costUsd? / usedTokens? / maxTokens? / numTurns? / durationMs?`
- `turn.queued` / `turn.dequeued` · a `delivery: 'queue'` message is held until the running turn ends / left the queue (`started | promoted | cancelled | dropped | failed`), keyed by its chat row id (`echoMessageId(origin)`). The registry's `QueuedTurnLedger` fills in the text and serves list / promote / cancel (`turn_queue_controls_v1`); outstanding-turn accounting for a queued message is settled on `turn.dequeued` only, never in the IPC handlers
- `turn.queue-held` · after Stop (all three adapters, reason `Stopped.`), a failed or usage-limited turn, or a queued message that could not start (`turn.dequeued` `failed`, which stays listed as Not sent until Cancel), the adapter starts nothing more until the user resumes (`provider:resume-queued-turns`) or cancels. Claude takes held messages back out of the CLI queue (`cancelAsyncMessage`) and pushes them again, with a fresh uuid, on Resume. Clients keep queued rows on `status: error`; only `stopped` clears them
  - **Claude turn boundaries.** A queued message started at a `result` makes the status `running`, not `idle`. A steer sent mid-turn carries a uuid; when one was sent and a queued message waits, the next turn is undecided (`awaitingNextTurn`) until its first `message_start`, whose `user_message_uuid(s)` stamp names the queued message (it starts, with its mode) or the steer (a turn of its own). No stamp (an older CLI) means the queue head, as before. A turn nobody started (that late steer, or the agent's own follow-up) is announced as `status: running` with `newTurn: true`, which the registry counts until its `turn.completed`. A query that dies mid-turn ends the running turn itself (`endTurnWithoutResult`)
  - **Codex stale ends.** A `turn/completed` for another turn than the running one (the turn Stop interrupted, arriving after the next send started a turn) is ignored: no `turn.completed`, no idle status, no queue start
  - **Codex native queue: tried and rejected (spike 2026-09-29, Codex 0.158).** Its `thread/queue/*` methods are experimental, and they cannot carry our semantics: `queue/start` refuses while a turn runs, so Send now (promote into the running turn) has no equivalent; queue items carry no settings, so a queued message's own runtime mode cannot apply when it starts; and the server starts the next item itself, so a failed start cannot be reported back. Decision: Codex keeps going through our `QueuedTurnLedger`. Re-check only once the queue leaves experimental, can merge an item into a running turn, and stores per-item settings.
- `status` · session status change · `session` · sessionId recorded
- `context_window` · live token count (polled after each turn)
- `model.variants` · available model variants + current selection
- `plan.proposed` · ExitPlanMode intercept → PlanCard
- `question.asked` / `question.answered` · AskUserQuestion intercept → QuestionCard
- `file.edited` · **2026-06-02**: one event per changed file per turn, sourced from a git checkpoint diff (provider-agnostic) - drives the Cursor-style in-chat diff card with per-hunk accept/reject
- `request.expired` · the provider can no longer take an answer for an open approval or question (its session errored, stopped or restarted). Clients replace the card with a notice naming the reason, recovery closes cards the backend no longer lists, and `RESPOND_TO_REQUEST` / `ANSWER_QUESTION` refuse a request the registry no longer holds (`REQUEST_EXPIRED`) instead of returning silently
- `error` · adapter-level error surfaced to chat

### Image pipeline (2026-04-20)

1. User pastes/drags image in `ChatInput` → `ImageAttachment[]`
2. `ChatPanel.handleSend` shrinks each `File` to a data URL with `fitImageToBudget` (canvas). Every client resizes the same way, by `src/shared/image-resize.ts` (Android port `domain/composer/ImageResizePlan.kt`): at most 2048 px on the long side, JPEG 0.85 (a PNG stays PNG while under 1 MiB), stepping down to 1600 px and then 1280 px at 0.75 until the image fits what is left of the 3 MiB message limit, which is unchanged and still enforced by `validateUserMessageImages`. A GIF is sent as is or refused (re-encoding would drop its animation). The decoder applies EXIF orientation and the output carries no EXIF. Each refusal names the image (`imageRefusalMessage`). The Expo app does it with `expo-image-manipulator` (a native module: added 2026-10-03, so it needed a new binary, not an OTA); Android with `BitmapFactory` and `inSampleSize` (`BitmapImageShrinker`) on the composer worker, when the image is staged into the draft
3. `providerApi.sendTurn(..., messageImages)` passes through preload → `provider-registry` IPC → adapter
4. Claude adapter strips the `data:image/png;base64,` prefix and builds `{type:'image', source:{type:'base64', media_type, data}}` content blocks alongside text
5. Codex adapter encodes images into JSON-RPC content blocks (Phase B done - see `codex-adapter.ts` `sendTurn`)
6. On JSONL reload, `JsonlParser.extractImages` reconstructs data URLs from image blocks - historical images survive restart

### Question / Plan flow

1. Agent calls `AskUserQuestion` or `ExitPlanMode` (both in `CUSTOM_UI_TOOLS`) - raw `tool.started` is suppressed
2. SDK fires `canUseTool` → our handler intercepts, emits `question.asked` / `plan.proposed`
3. ChatPanel appends a message with `question` or `plan` attachment
4. `MessageBubble` routes to `QuestionCard` (T3-style, numbered shortcuts 1-9, auto-advance) or `PlanCard` (markdown + Implement/Iterate buttons)
5. User answers → `provider.answerQuestion(threadId, requestId, answers)` resolves the blocked Promise
6. `canUseTool` returns allow + `updatedInput` with the answer payload

### Cross-session messaging (`/send-to` + agent-initiated sends)

One session hands a self-contained summary to another on the SAME backend. Two entry points, ONE delivery method - `ProviderRegistry.deliverPeerMessage(input)`:

- **User-typed**: `/send-to <session>: <message>` (parsing + fuzzy target resolution in `renderer/components/chat/send-to-command.ts`) → `ProviderChannels.DELIVER_PEER_MESSAGE` → the registry with `initiator: 'user'`. The handler FORCES the initiator; a client claiming `'agent'` would take the agent path's budget while skipping the approval that path relies on.
- **Linked sessions**: `/link <session> [messages] [time]` / `/unlink [session]` (`renderer/components/chat/link-command.ts`, targets resolved like `/send-to`, and `/link` gets the same chat picker) let two sessions' agents message back and forth under the link's own budget (see the guard table). A trailing number is the budget and a trailing `Nm` / `Nh` the time (10 minutes to 24 hours; a unit is required, since a bare number is the budget), unless the text with them is exactly a chat's title ("Issue 172", "Sprint 2h"): options are peeled off only until an exact title matches. No time means the backend setting `chat.peerLinkDuration` (Settings > Chat & agents > Link duration, `30m` by default, stored in the `/link` form and read by the registry at link time; `peerLinkDurationChoice` turns anything that is not one of the row's choices into `30m`, for the row and the registry alike).
- **Agent-initiated (all three agents)**: `list_agent_sessions` and `send_agent_message` on the Switchboard MCP server (see the next section), so Claude sees `mcp__switchboard__*`, OpenCode `switchboard_*`. Names, descriptions and handler behaviour live in `provider/peer-tools.ts`; `mcp/peer-mcp-tools.ts` binds them to the server and applies the gate.

Delivery is an ordinary `sendTurn`, which is what makes a peer message structurally unable to answer an approval: nothing on the path reaches `respondToRequest`. The receiving body is `wrapPeerMessage`, which tells the peer the message is not from the user and carries no authority.

Guards, all pure in `shared/peer-messaging.ts` and held by the BACKEND so every client shares one budget:

| Guard | Value | Why |
|---|---|---|
| Body cap | 16 KiB | A peer message is a summary, not a transcript |
| Per-pair rate | 5 / 60s | Both initiators |
| Dedupe | identical (from, target, text) inside 10 min | Content-addressed id `pm_<16 hex>` |
| **Hop depth** | `PEER_MESSAGE_MAX_HOP_DEPTH = 1` | Agent sends only. Depth counts consecutive AGENT hops since the last human message, so a session acting on a peer message cannot pass one on: that is the A -> B -> A guard, and rate limits do not substitute for it |
| **Per-sender budget** | 6 / 10 min per SENDING session | Agent sends only. The per-pair limit is multiplied by fan-out otherwise (5 siblings = 25/min) |
| **Session link** (`shared/peer-links.ts`) | Per EDGE (both directions): the messages the user chose (`/link <session> [messages] [time]`, default 20, 1 to 200) or the edge's own window (the time given, else the Link duration setting, 30 min by default; 10 min to 24 h), whichever first. The edge stores its window: a message the user types in either session, or sends along the edge, renews both with it; Extend adds 20 (never past 200) and restarts that window, not the default | Agent sends along a link the USER made skip hop depth and the per-sender budget, so two agents can hold a back-and-forth and a hub can fan out to any number of linked workers (no cap on links per session). Only along that edge: the same session sending to an unlinked one meets both limits. Body cap, dedupe and per-pair rate still apply. 200 is ten default budgets. The window bounds time and the budget bounds volume: at the per-pair rate a busy pair spends 200 in about 20 minutes, so a long window keeps a sparse exchange alive but a chatty one still stops for the user. Kept at 200 when windows grew to 24 h for that reason |

Traps:

- **The gate is the server's, not the adapter's.** `peer-mcp-tools.ts` runs `decidePermission` on `mcp__switchboard__send_agent_message`: denied in plan (with a `tool.denied` pill), sent in full access, one ordinary approval card otherwise. The adapters let every `switchboard` tool through without a prompt of their own. `list_agent_sessions` runs unasked: it reads only titles the sidebar already shows, and prompting for a harmless read trains the user to click through the send that follows.
- **Hop depth is NOT cleared at turn end**, only by a user turn (set to 0 in `SEND_TURN`) or `STOP_SESSION`. Clearing it per turn would let an unattended chain continue by waiting. A Switchboard result turn (an approval card's answer, see the MCP server section) does not clear it either, and does not renew a link.
- **Refusals go back to the model as tool output with `isError`, never as a throw** - a thrown MCP error reaches it as an unreadable transport failure and it retries the same call.
- The per-pair limit (5) is LOWER than the per-sender budget (6), so any test of the budget must fan out over two targets or the pair limit fires first.
- **Links are edges, user-made, in memory.** `/link A`, `/link B` from a hub makes two edges; A and B are not linked with each other. Only `ProviderChannels.LINK_PEER` creates one (`PeerLinkBook.link` refuses an `'agent'` initiator, and no MCP tool reaches it). Keyed by `resolveRootThreadId`. Removed by `/unlink`, by `STOP_SESSION` on either side (not by a profile switch, which restarts the session) and by archiving either chat (`notifyConversationArchived`). Not persisted: a restart stops every session, which would remove them anyway. `list_agent_sessions` reports `linked`, and `provider:peer-links-changed` (`{ threadIds }`, root ids) drives the desktop banner (`PeerLinkBanner`).
- **A link skips the hop limit, it does not reset it.** The receiving turn's depth still grows with each linked hop, so a session deep in a linked exchange cannot send to an UNLINKED session until the user speaks to it, and unlinking mid-exchange can leave both ends unable to send. That is deliberate: the link is consent for that edge only.
- **A spent link never loses the message.** The refusal tells the model the message was NOT delivered, to keep working, and to put it in its final reply. The registry also stores it in the SENDER's chat as a `[[sb:peer-undelivered]] <json>` system row (`PEER_UNDELIVERED_MARKER_PREFIX`, `PeerUndeliveredRow`) with a Send button, which delivers it as a user send (renewing the edge) and rewrites the row as sent (`rewriteSystemMarker`, carried by `undeliveredId`). The first refusal after a run-out publishes `peer.undelivered` with `notify: true`, which the push notifier (`kind: 'link'`) and the desktop (`notifyPeerLinkSpent`) turn into one notification naming both sessions; later refusals are rows only, until the edge is renewed.
- **Every client renders every `[[sb:` system row, and an unknown kind never shows raw.** The phones read stored rows through `shared/system-markers.ts` (`systemRowView`; Android `SystemMarkers.kt`, both run `tests/fixtures/system-marker-cases.json`): Not delivered gets its own row with Send (`provider:deliver-peer-message` is open to a phone's `chat` scope), the other markers a notice in the desktop's words, an `Error:` row an error, and a kind they do not know a neutral "Switchboard notice" (the desktop's `MessageBubble` falls back the same way). Android stores both from history and from the live `peer.undelivered` / `approval.result` events as `RawNotice` rows of type `history.system` with id `h-<messageId>`, so a reload and a live event land on one row and a sent update replaces it. A NEW marker kind needs a case in that fixture and a row in both ports, or it shows as the neutral notice.
- **Each edge keeps its own window.** `PeerLinkBook` stores `windowMs` per edge, so renewals and Extend restart that edge's length, never the current Settings default; changing Link duration affects only links made after. `/link` on an already linked pair replaces its budget and window (no time means the setting's), and the expired refusal names the edge's own length ("This link's time (4 hours) is up."). The banner shows the time left per link (`Worker A · 7 of 20 · 3h 12m left`).
- **Phones may unlink, never link or extend.** `provider:link-peer` and `provider:extend-peer-link` are admin-scoped in `device-auth.ts`: a link is consent to card-less agent traffic in auto mode, like approving a host write. `provider:unlink-peer` and the list stay open, since they only take power away or read.
- **Card along a link**: auto mode sends without one (the user lets the agent settle routine calls there, and a card per message would undo the link); sandbox and accept-edits keep the card, plan still denies, full access already sends. A card-less send carries `requireLink`, so an unlink while it is in flight refuses it instead of delivering it uncarded.
- **The link is checked again after the checkpoint await**, the one await between the charge and `sendTurn` (`peerDeliveryProblem`). The edge is compared by id (`PeerLinkBook.edgeId`), so an unlink there, or an unlink and relink, withdraws the send: the per-pair slot and the link charge are given back (`release` only refunds the edge that was charged), a checkpoint taken for a turn that will not happen is dropped, and the message is kept as a `link-removed` Not delivered row. A target that stopped or switched profile meanwhile is refused the same way.
- Sender-side provenance is a marker prefix, not a field: `[[sb:peer-sent]]` vs `[[sb:peer-sent-agent]]` (`parseRotationMarker` kinds `peer` / `peer-agent`), because a reload reads the stored string and has nothing else to tell the two apart.

### Switchboard MCP server (`src/main/mcp/`, agent tools for all three agents)

One MCP server per backend process gives Claude, Codex and OpenCode the same tools, and is the ONLY gate for them. Verified live against the CLIs (2026-09-27): Claude routes an MCP tool through `canUseTool` and asks nothing else; Codex (sandbox) confirms a non-read-only tool with a yes/no `mcpServer/elicitation/request`, never in full access; OpenCode never asks for an MCP tool unless the user's own config says so, and its plan mode is the model obeying, not enforcement. So the server enforces plan mode, the approval card, the budget and the link check itself.

- **Transport.** `stdio-bridge.ts` holds a dependency-free CommonJS bridge that `ensureStdioBridge` writes to `<userData>/mcp/switchboard-mcp.cjs`; each agent spawns it (`process.execPath` with `ELECTRON_RUN_AS_NODE=1`, so the Electron binary or the headless server's node) as its `switchboard` MCP server. The bridge dials the backend's `127.0.0.1` listener (`switchboard-mcp-server.ts`), sends `{ switchboardMcpAuth: <token> }` first, then pipes. The token is read from a 0600 file under `<userData>/mcp/tokens/` named by `SWITCHBOARD_MCP_TOKEN_FILE`, never passed as a value: Codex's `-c` and Claude's `--mcp-config` put the server's env on a command line any local user can read with `ps`. Kept as source rather than a second bundle so a provisioned VM needs nothing extra. The protocol (initialize, ping, tools/list, tools/call, notifications/cancelled) is hand-rolled in `mcp-session.ts`; `@modelcontextprotocol/sdk` is only transitive here.
- **Token = identity.** `ProviderRegistry.openSwitchboardMcp` mints one per session start (`mcp-tokens.ts`, sha256 in memory), and the tools are built for THAT thread; `STOP_SESSION` revokes it, deletes its file and drops live connections. The mode the gate reads is the adapter's own (`ProviderAdapter.runtimeModeOf`), because a queued message's mode applies only when it starts. Links and the budget key on `resolveRootThreadId`. A registry built with injected adapters (tests) gets no server unless one is passed as the 5th constructor argument.
- **Registration** (`agent-registration.ts`, pure): Claude via the SDK's `mcpServers`; Codex via `-c mcp_servers.switchboard.{command,args,env,tool_timeout_sec}` on its per-chat `app-server` (raised to 180s: no call waits on a card any more, but a full-access create makes several host calls with no card, and Codex gives up after 60s by default); OpenCode via ACP `session/new` `mcpServers`. User MCP servers keep loading from their own config.
- **No second prompt, only when OUR server was registered**: Claude's `canUseTool` allows `mcp__switchboard__*`, Codex's confirm for `serverName: 'switchboard'` is accepted, OpenCode's permission for `switchboard_*` is allowed. Without a registered server those names get the ordinary policy, so a user server that calls itself `switchboard` is not trusted.
- **Tools.** Reads, no card: `get_pr_status`, `list_pr_conversations`, `get_pr_diff` (pages of at most 60 KiB, `mcp/pr-diff-page.ts`). Writes, one card each: `reply_to_conversation` (text, optional `resolve`), `resolve_conversation`, `rerun_check` (GitHub Actions only), `comment_on_line` (one inline comment, the line must be in the fresh diff), `draft_review` (summary plus up to 30 comments, 40 KiB; one write against the budget). Never merge. A verdict is never the agent's: `draft_review` has no verdict argument (one sent is refused, `shared/agent-pr-review.ts`), the card preselects none and offers only what `reviewEventsFor` allows (an author or a closed PR gets Comment only), and an answer without a verdict posts nothing. `create_pull_request` (one card: editable title and description, the repository and "source -> target"; rules in `shared/agent-pr-create.ts`) is the one write that needs no linked PR: it opens one on the repository the chat's `project_path` points at (any other `repository` is refused), from the session cwd's current branch (`pull-requests/branch-check.ts`, which also refuses a branch `git ls-remote` does not find on that repository's remote) into the host's default branch unless given. For a project folder that holds several repositories, optional `repoPath` (relative to the project folder or absolute) names one: `resolveRepoDir` (`pull-requests/project-repos.ts`) realpaths both sides and refuses anything not inside the folder (the folder itself allowed, so no `..` or symlink escape) or not a git work tree; its remote is the repository (a `repository` given too must match it exactly, `repoPathRepositoryProblem`) and must be one the project covers (see Chat ↔ PR links), and the branch checks run with it as the cwd. Without `repoPath`, a parent folder plus `repository` picks the ONE child work tree whose remote matches (`findChildRepo`), refusing zero or several with the candidates listed. The card shows that path (`create.localPath`), desktop and plain-text detail only: it is not in `hostWritePreview`, so the phone digest and its pinned vectors are unchanged (the repository is already in `target`). An OPEN PR for the source branch is linked and returned instead, before the card and again in `PullRequestService.createPullRequest`. Optional `reviewers` (at most 10 logins, display names or emails; GitHub teams as `team:<slug>`) are matched before the card against `PullRequestService.reviewerPool` (the Reviewers card's candidates plus the signed-in user) by `shared/agent-pr-reviewers.ts`: exact only, case and a leading `@` aside, on id, login, display name, a listed email or a team slug; a name matching nobody or several people, or the signed-in user, is refused with the close candidates, never guessed. The card lists them (`create.reviewers`), removable on the desktop; the approval sends the kept ids. Bitbucket sends them in the same POST (`reviewers: [{uuid}]`); GitHub creates the PR and then posts `requested_reviewers`, and when that second call fails the PR stays (`OpenedPr.reviewerFailure`): the agent gets the URL and the reviewers that failed, and the create is never re-sent. `draft` is GitHub only and refused on Bitbucket. After a create it links the PR to the ROOT conversation (source `created`, which relinks a tombstone) and emits `pull-requests:links-changed` with `created: true`, which marks the Reviews list stale (`review-store.markStale`). An `offline`/`unknown` failure is uncertain: it looks for the PR once, and otherwise tells the agent not to create again. The MCP server's instructions tell agents to use it instead of `gh pr create`, bbpr or a host API. Link tools, no card (`mcp/pr-link-tools.ts`: a link changes only what these tools may act on, nothing on a host): `link_pull_request` (a URL, or `repository` + `number`; the `pull-requests:link` repository rule; source `agent`) and `unlink_pull_request` (tombstones, like Reviews' Unlink), both denied in plan mode through `decidePermission`, and `list_thread_pull_requests` (each link's source and last known state, plus the chat's last automatic linking failure), which runs unasked. Plus the two session tools. Every other tool acts only on PRs linked to the calling chat (`pickLinkedPr`), through the same `PullRequestService` as the human writes (`setAgentPullRequestAccess`, set in `registerPullRequestHandlers`), so its re-reads and validation apply.
- **Modes.** Plan denies a host write without a card. Full access STILL shows the card: posting as the user on GitHub or Bitbucket is not a local edit (`hostWriteGate`). Sandbox, accept-edits and auto show it. The one exception is `create_pull_request` (`createPullRequestGate`): full access opens the PR without a card, because the user asked for it, it merges nothing and closing it undoes it. It still counts against the budget and still carries the via-Switchboard marker.
- **The card does not hold the turn** (`mcp/agent-approvals.ts`, rules in `shared/agent-approval-cards.ts`). It is a `request.opened` with a `hostWrite` payload (`shared/agent-host-writes.ts`) and a plain-text `detail` for clients that do not render it; ids start `sbmcp_` and `RESPOND_TO_REQUEST` routes them to the broker, with an optional 4th argument `{ text, resolve, quiet, ... }`. The tool returns AT ONCE, not as an error: "Queued for the user's approval (card <id>) ... Do not send it again." The card is stored with the write it would run as data (`plan`: `PrWritePlan` in `pr-tools.ts`, `PeerSendPlan` in `peer-mcp-tools.ts`) in `agent_approval_cards` (`db/agent-approval-cards.ts`, keyed by the ROOT conversation), so it has no time limit and survives the turn ending, a profile switch or relocation (the internal `stopSession` leaves it) and a backend restart (the broker loads the table, parsing each row on its own: a row it cannot read is deleted and its chat gets a failed result row, so one bad row never drops the rest; `getPendingRequests` serves the broker's cards, not the registry's per-turn record, so a `status: error|stopped` cannot drop them). It closes exactly once (`ApprovalCardBook.take`): approved, approved quietly, denied, dismissed (a quiet deny), withdrawn by the agent (`withdraw_approval`, its own chat's cards only), or closed by the user's `STOP_SESSION` or an archive (`closeAgentCards`). `notifications/cancelled` or a dropped connection no longer touch a card: the agent has already moved on. Only an approval runs the write (`runPrWritePlan` / `runPeerSendPlan`), with every check after the card that ran before: plan mode, the PR link, the project's repository, the edited text, a phone's `shown`, and for a peer send the whole `deliverPeerMessage` path (link rules, budget, refund, Not delivered row, the re-check after the checkpoint). `reply_to_conversation` with `resolve` stays ONE card that does both. The text the user leaves in the card is what is posted, ending with a `via Switchboard` line (`withViaMarker`). Then `reportAgentCard` stores a `[[sb:approval-result]]` system row under the root id (`ApprovalResultRow`, desktop `ApprovalResultRow.tsx`, both phones show `approval.result` and the stored row as a notice) and, unless quiet, delivers the result to the agent as a turn of its own (`approvalResultTurn`): a new turn when idle, `delivery: 'queue'` behind a running turn (the `QueuedTurnLedger` path), or held in `agent_approval_results` and sent when the chat's session next starts (a result answered during a profile switch or relocation is held too, and `flushHeldApprovalResults` sends it once that move commits or rolls back). That turn is wrapped in `<switchboard-approval-result>`, says it is from Switchboard and carries no authority, and every surface's synthetic split drops it (`synthetic-message.ts`, Android `SyntheticUserMessage.kt`), so the row is what the user reads. **It is not a user turn**: `sendApprovalResultTurn` sets no `turnDepth`, renews no link and clears no plan, so a result can neither restart a peer chain nor spend or refill a link's budget (`agent-approval-results-registry.test.ts`). A call still sends `notifications/progress` every 10s when the client gave a progress token, now only for slow host calls a full-access create makes without a card: OpenCode's MCP call timeout is 30s and not settable over ACP.
- **Phones** approve a host write card as drafted: a device with the `chat` scope (a phone) may approve, because it can already send the agent full-access turns, which is the larger power. The Reviews write channels (`PullRequestWriteChannels`: merge, the user's own comments and reviews) stay `admin`-scoped. The backend advertises `agent_host_write_phone_approval_v1` (`shared/host-write-phone.ts`); a phone without it offers Deny only, since an older backend refuses the approval. The phone card (`phoneHostWriteButtons`, ported to Android as `HostWriteCards.kt`) shows everything the approval posts, uncapped, from the card payload (`hostWritePreview`: title, description, reply, summary, every review comment under its `path:line`), never the capped plain-text detail; a long draft starts collapsed and no button approves until it is opened, and a payload the phone cannot show in full (null preview) is Deny only. A create's reviewers are a `Reviewers` section of that preview (one `Display (login)` line each), so the digest covers them and a phone approves all of them. It has an action-named button, and for `draft_review` one button per offered verdict with none primary. It never edits: the registry passes only `resolve` and `verdict` (`approvalChoiceOnly`) from a device without the `admin` scope, so a phone's approval posts the draft it showed. It must also carry `shown`, the `hostWriteShownDigest(requestId, card)` of the draft it rendered in full: FNV-1a 64 over the request id, the card's `target` (host, repository, PR number; for a create, the source and target branches), the action and exactly what `hostWritePreview` shows, so the same text on another card or PR does not match. Ported as `HostWriteCards.shownDigest`; two cross-implementation vectors are pinned in both test suites. The broker recomputes it from its card and refuses a missing or different one ("Update the Switchboard app..."), so a build that showed the capped detail cannot approve. The desktop needs none. Deny never needs it. **Editing an agent draft on the phone before approving is deferred** (the user, 2026-09-29: not a priority). The design when it comes: the phone sends its edited text (and kept reviewers), `approvalChoiceOnly` lets those fields through for a `chat` device, and `shown` is computed over the edited text rather than the card's, so the broker can check the phone approved exactly what it will post. The broker refuses a review approved without a verdict the card offered (`hostWriteApprovalProblem`) and keeps it open, and logs which device approved (`describeRequestClient`). Every other guard (the re-checks after the card, plan mode, budget, link rule) is unchanged. The peer-send card stays answerable from a phone, as before. Cards have no expiry on any client (none ever had one of its own), so an hours-old card recovered through `GET_PENDING_REQUESTS` renders and answers like a new one. On a backend advertising `agent_async_approval_v1` (`AGENT_ASYNC_APPROVAL_CAPABILITY`) both phones offer "Don't wake the agent" on a server card (`offersQuiet` / `quietly` in `apps/mobile/src/lib/approval-actions.ts`, `ThreadInteractionPolicy` on Android): it adds `quiet: true` to the same response (Approve becomes "... quietly", Deny becomes Dismiss), and `approvalChoiceOnly` keeps it for a `chat` device. An older phone simply never sends it.
- **Guards**: 10 writes per chat per 10 min, counted when a write reaches its card (the cap is checked first, so a refused card costs nothing); at most 20 OPEN cards per chat (`AGENT_OPEN_CARD_CAP`), past which a new ask is refused with `isError` and told to wait or withdraw one; reply text capped at 8,000 chars; every refusal is tool output with `isError`.
- **Known limit: a write in flight is not atomic with its checks.** Every write re-checks the link and the mode after the card and again before a second write (reply, then resolve), and a peer send re-checks the mode after its card. An unlink, cancel or stop that arrives after the last check cannot stop a host call that has already started. An uncertain result tells the agent not to post again; there is no host-side dedupe key. Since a card can now be answered hours later, the PR the card shows may have moved on (new commits, a resolved thread): the host call itself refuses a stale target where it can (the service re-reads before a write), but the card's quoted text and diff excerpt are as of when it opened. A result turn the adapter refuses is held and retried at the next session start, not retried in place.

### Archive system

- `archived INTEGER` column on `conversations` table
- `getArchivedConversationIds()` returns a **global** ID set (not per-project) - fixes pre-2026-04-20 bug where a session listed under two project views would reappear after archiving from only one
- Filter applies in `GET_PROJECTS`, `SCAN_SESSIONS`, and `OPEN_FOLDER` handlers

### Slash commands (2026-04-20)

- `SlashCommandMenu` popover wired into `ChatInput` textarea
- Trigger: `/` at start of line, matched by `^\/([^\s/]*)$` (mid-line slashes like paths don't fire)
- Registry in `src/renderer/components/chat/slash-commands.ts`
- v1 commands: `/plan`, `/sandbox`, `/edits`, `/full`, `/clear`, `/archive`, `/image`, `/stop`, `/help`; later `/send-to`, `/link`, `/unlink`, `/merge-back`
- `/help` opens an overlay listing everything

### Theme system

- CSS variables: `.theme-dark`, `.theme-light`, `.theme-translucent` in `global.css`
- Translucent uses macOS vibrancy (`setVibrancy('sidebar')`) + transparent BG
- Theme picker in Settings modal (`⌘,`)

### Provider instances (multi-account credentials)

- `provider_instances` table: `(id, agent_type, display_name, accent_color, auth_mode, env_encrypted BLOB, oauth_dir, config_json, enabled, created_at, updated_at)`. Multiple named instances per agent type (e.g. `codex-work` / `codex-personal`).
- `auth_mode`: `'env'` (safeStorage-encrypted env vars in `env_encrypted`) or `'oauth_dir'` (per-instance config dir set as `CLAUDE_CONFIG_DIR` / `CODEX_HOME`).
- IPC (`ProviderInstanceChannels`): `LIST` (secrets stripped), `UPSERT` (plaintext env in, encrypted at rest), `DELETE` (refuses last-of-kind), `TEST` (probes creds via `claude auth status` / `codex login status` / `opencode models`), `CREATE_OAUTH_DIR`.
- Registry resolves the instance at `startSession` (`resolveProviderInstance(agentType, instanceId)`), falling back requested → default → any enabled; applies the env overlay + oauth_dir at spawn.
- UI: `UnifiedProviderPicker` (drop-up: agent tabs → instance rail → model search) in the chat composer; `ProvidersTab` in Settings. Renderer cache in `provider-instance-store`.
- **Usage limits** (`ProviderInstanceChannels.USAGE` → `src/main/provider/usage/`): a per-row "Usage" button reads that instance's subscription quota. Claude via `GET /api/oauth/usage` with the instance's own keychain token; Codex via a short-lived `codex app-server` speaking `account/rateLimits/read`; OpenCode is not-applicable (own API keys). Normalised to `ProviderUsage` (`shared/provider-usage.ts`): `usedPercent` 0-100, `resetsAtMs` epoch ms. Traps:
  - Claude's per-model weekly limit is in `limits[]` as `kind: "weekly_scoped"`, **not** `seven_day_opus`/`seven_day_sonnet` (legacy, null). `is_active` marks which limit is *binding*, not whether it exists - never filter on it.
  - Codex's app-server wire is camelCase and `resetsAt` is unix **seconds**; the snake_case form belongs to `codex exec --json`. `account/read` needs an explicit `params`.
  - Keychain service = `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR)[0..8]>`, derived from the **effective env value**, which is what makes lookup per-instance.
  - Never reuse `runProbe` to read credentials: `security ... -w` prints the token on stdout, and `runProbe`'s callers surface stdout to the UI.
  - Tokens are never refreshed here - the CLI rotates and writes back, and racing it can log the user out. Expiry is checked locally.
  - Every `security` read of an item it has no lasting access to is a macOS password prompt, and Claude Code resets that access whenever it rewrites the item on a token refresh. So reads are shared per SERVICE, not per instance (`usage/keychain-read-cache.ts`: 45s window, concurrent reads joined, an item without a `claudeAiOauth` payload remembered for the process and never retried under the next account), only the user's Usage refresh or an instance edit reads past that, and nothing reads usage unasked: Settings prewarms the account list only, and Accounts reads once per visit.

### Embedded IDE (code-server) + file IPC

- **Right pane has two modes** (⌘⇧E toggles): the terminal strip, or the IDE pane. Both stay mounted (positioned overlay) so xterm/pty and workbench state survive toggling.
- `IdePane.tsx` renders the real VS Code workbench served by a per-app `code-server` process in ONE persistent `<webview partition="persist:ide">` - switching projects navigates the same webview to the new `?folder=` (RAM policy: never N workbench renderer processes). Prewarmed in the background once a session is active (server + hidden workbench; never downloads the binary uninvited), so the first ⌘⇧E is instant. Hidden 15 min → server killed + webview blanked; cold respawn ~0.35s.
- `src/main/ide/`: `code-server-manager.ts` (spawn args, release-asset table, extension seeding, lifecycle: EADDRINUSE retry-once, capped health poll, respawn after crash), `binary.ts` (download to `userData/code-server/<version>/`, PATH fallback for devs), `bridge-server.ts` (ws + token; routes open/selection by workspace folder).
- `resources/sb-bridge/`: zero-dependency extension seeded into code-server's extensions dir. `protocol.js` is pure (message build/parse/validate + reconnect backoff, unit-tested); `extension.js` is thin vscode glue (open-at-line, cmd+l selection capture, cmd+k quick edit, live config apply, the Switchboard Charcoal color theme (app palette), terminal-intent keybindings (ctrl+backtick / cmd+j / cmd+shift+e route to Switchboard's terminal pane; task/debug terminals untouched)). Ships via electron-builder `extraResources`.
- IPC (`IdeChannels`): `ENSURE` (boot + serve folder, TCC pre-flight per call) / `STATUS` (push: stopped | starting | downloading | ready | error) / `OPEN` (pill click → open-at-line in workbench) / `SELECTION` (cmd+l in workbench → chat draft pill) / `STOP` (idle shutdown).
- Security ADR: `--auth none` on `127.0.0.1` - same-user trust boundary as PTYs and the embedded SDK. Design doc: `docs/plans/2026-07-10-embedded-ide-design.md`.
- Surviving file IPC (`FilesChannels`): `list-dir` (lean name/isDir - remote add-project autocomplete), `list-all` (@-mentions, 10k cap), `write-file`/`delete-file` (FileDiffCard accept/reject - atomic temp-then-rename, mtime conflict detection, 8 MB cap), `resolve` (inline file pill existence). `resolveWithinRepo` rejects `..`-escapes.

### Git tooling + worktrees

- `ipc/git.ts` (`GitChannels`): `list-refs` (locals + remotes, annotated with current/sha/worktreePath), `switch-ref` (validated, rejects `-`/`..`/control chars), `current-branch`, `file-diff` (parses `git diff HEAD` into add/del/mod gutter hunks - `git/diffHunks.ts`).
- Worktree **creation** lives in one place, not in `worktree.ts`: `worktree-creation/git-adapter.ts` drives the transactional flow behind `KanbanChannels.CREATE_WORKTREE` (kanban card, `<repo>/.switchboard/worktrees/<slug>-<id>`, branch `kanban/<slug>-<id>`) and behind conversation forking (fork-to-worktree, `fork/<name>`). `worktree.ts` itself only lists, finds-stale, and removes worktrees now (`removeWorktree`, `listWorktrees`, `findStaleWorktrees`) - its own creation functions were dead code with no production caller and were deleted.
- **Worktree manager** (Settings > Archive & data > Worktrees, `WorktreeManagerChannels`): rules in `shared/worktree-manager.ts` (`classifyWorktree`, `removalVerdict`), backend in `main/worktree-manager.ts` + `main/worktree-inspect.ts`. Every removal goes through `removeManagedWorktree`, which re-reads ownership, protection and git state and refuses when the losses exceed what the client acknowledged. Owned worktrees (chat, card, catalog, in-flight creation) are never removed there. Protection is the backend settings row `worktrees.protection` (`{ projects, worktrees }`), honoured by `findStaleWorktrees` too.
- Worktrees live under `.switchboard/worktrees/` deliberately - avoids re-tripping the macOS TCC trap on `~/Desktop`-rooted repos and centralizes cleanup.
- **Agents needing another branch**: the main checkout is shared by many sessions and is often on someone else's branch, so don't switch it. Use `git worktree add .switchboard/worktrees/<name> -b <branch> origin/main`, never `/tmp` - each one is ~1.5GB after `npm install` and nothing reaps `/tmp` (leaked worktrees there have filled the disk). Once the PR merges, `git worktree remove .switchboard/worktrees/<name>`.

### Conversation forking (`conversations/fork.ts`, `shared/conversation-fork.ts`)

- IPC `app:fork-conversation` uses the versioned stable-anchor contract in `shared/conversation-fork.ts`: client request ID, source conversation ID, message ID + role/timestamp/full-message digest, and explicit shared-checkout or source-HEAD worktree policy. The backend owns IDs, canonical prefix resolution, provider artifacts, persistence, and worktree paths; `app:get-conversation-fork` reconciles response-loss retries.
- Claude resumes natively only when the anchor has compatible lineage in the source conversation's committed credential profile. Codex and OpenCode fork natively through their own CLIs where they can (`native-fork.ts` holds the rules, `native-fork-runners.ts` spawns the CLI with the source instance's env), and otherwise keep the durable exactly-once transcript handoff; neither ever writes fake resumable artifacts into provider discovery trees.
  - **Codex**: `thread/fork` with `lastTurnId`, the anchor's turn read from the source rollout under the instance's own `CODEX_HOME`. Native only when the anchor is an assistant reply that ends its turn and the thread holds exactly the displayed prefix. A CLI without `thread/fork` answers `-32600 "unknown variant \`thread/fork\`"`, not `-32601`, so `isUnsupportedMethodError` checks both; never gate on the version string. The forked rollout re-copies the parent prefix stamped with the fork time, so `loadConversationHistory` drops its first `nativeResume.copiedMessageCount` messages or the prefix shows twice.
  - **OpenCode**: ACP `session/fork` copies the WHOLE session (1.18.33 calls `session.fork` with no message id, and ACP has no message field), so it is native only for the latest assistant reply, in the same checkout, when `sessionCapabilities.fork` is advertised and one OpenCode segment recorded with the chat holds all of it.
  - A native fork commits its typed segment and `thread_sessions` row in the fork transaction; the adapters then resume it exactly as after a restart. The OpenCode adapter emits `session` and resumes its latest segment (same instance only) when `sessionCapabilities.resume` is advertised, else starts a new session with a visible notice.
- Fork conversation, rich messages, settings, handoff state, lineage, managed worktree projection, and operation result commit atomically. `project_path` remains the parent project; `worktree_path` is execution CWD. `thread_sessions` remains provider-session rotation lineage, separate from user-created fork lineage.
- **Merge-back** (`shared/merge-back.ts`, `conversations/merge-back.ts`, `db/merge-backs.ts`): a fork sends a summary of its work back to its parent chat as context, never a git merge. Desktop: "Send back to <parent>" in the fork banner, or `/merge-back`; the dialog shows the backend-built summary, editable. The summary covers the fork's turns after its cursor (the fork's `created_at` on the first send, then the end of the last DELIVERED send, `fork_merge_back_cursors`), the files its mirrored diff cards name (a diff too large to mirror is not listed), its worktree and its last reply, capped at 16 KiB with the newest whole turns kept. The preview's token pins the range, so a fork that runs on before Send still stores what the user saw. The parent gets a `[[sb:merge-back]]` card (`fork_merge_backs`, one pending per fork and parent: a new send replaces it; Edit; Discard removes it and moves no cursor). The parent's next non-queued user turn carries every pending card, each wrapped in `<switchboard-fork-merge-back>` after any handoff preamble (`withMergeBacks`); the registry's dispatch claims them in memory (Edit and Discard refuse while claimed) and the turn's commit transaction marks them delivered by revision (`AcceptedUserTurnRecord.commitInTransaction`), so each is delivered once; a failed or ambiguous dispatch leaves them pending. The stored user row keeps the wrapped text so it matches the provider transcript; every surface drops the block (`synthetic-message.ts`, Android `SyntheticUserMessage.kt`) and the card becomes a delivered row just above the message. Live changes go out as `merge-back.row` (`content: null` once discarded). Channels `provider:merge-back-*`, capability `fork_merge_back_v1`, open to a phone's `chat` scope. Both phones (Expo `MergeBackSheet` + `MergeBackItem`, Android `ThreadMergeBackState` in `ThreadSessionCoordinator`, `MergeBack.kt`) offer Send back in a fork's banner and Edit / Discard on a pending card, only when the backend advertises `fork_merge_back_v1`; the preview note line is `mergeBackPreviewNote` on every surface (`docs/feature-parity/fork-merge-back.json`).

### Reviews (read-only pull requests, third top-level view)

- `layout-store.appView: 'reviews'`; `ReviewsView` mounts only while shown, so nothing polls a host from a hidden view. Refresh cadence is `shared/pull-request-refresh.ts` (focus, at most once a minute; interval every 5 min; manual always).
- Contract in `shared/pull-requests.ts` (neutral types, `mergeBlockers`, `HOST_CAPABILITIES`); grouping rule in `shared/pull-request-groups.ts`; remote URL parsing in `shared/pull-request-remote.ts`.
- Backend in `main/pull-requests/`: one `PullRequestProvider` interface, `github.ts` (gh CLI, never asks gh for its token) and `bitbucket.ts` (REST 2.0, Basic auth, refuses a `next` link off api.bitbucket.org), pure `*-map.ts` mappers tested against `tests/fixtures/pull-requests/`. `service.ts` only reads repositories one of the projects covers (`projectRepos`, see Chat ↔ PR links), so a parent folder's child repositories show in Reviews under that project. Handlers in `main/ipc/pull-requests.ts` register on every host.
- **Human writes** (`shared/pull-request-writes.ts`, one `PullRequestWriteChannels` channel per action): reply, resolve/unresolve, line and PR comments, submit a review (GitHub: one pending review submitted at once; Bitbucket: comments, then approve / request-changes), merge, re-run a failed GitHub Actions run (Bitbucket's API cannot re-run; `HOST_CAPABILITIES.rerunUnavailable` says so), add / remove a reviewer (GitHub `requested_reviewers`, `team:<slug>` for a team; Bitbucket has no add-one call, so GET the PR then PUT title + the whole `reviewers` list, never the description, which the detail read strips) and decline (Bitbucket) / close (GitHub). Reviewer changes and decline need `PrDetail.viewerCanManage` (author, or write access: GitHub `viewerPermission`, Bitbucket `/user/workspaces/{ws}/permissions/repositories`; Atlassian removed `/user/permissions/repositories`, never call it). The service re-validates every input and re-reads what it targets (the thread, the diff line, head + blockers before a merge) before a provider sends anything. Merge defaults to a MERGE COMMIT, never squash or rebase; the menu lists only what the repo allows. The author gets no Approve. All write channels are admin-scoped (a phone calls none). Tests use fixtures, a fake gh and a fake fetch; never point a test at a real host write. Agents reach a subset (open a PR, reply, resolve, re-run, a line comment, a review whose verdict the user picks) through the Switchboard MCP server, behind its own card - see that section.
- **Chat ↔ PR links** (`shared/pull-request-links.ts`, `db/pull-request-links.ts`, table `conversation_pull_requests`): keyed by the ROOT conversation id; an unlinked row is a tombstone so the auto-link (`pull-requests/auto-link.ts`, attached to each registry's bus next to the push notifier) links a PR once. `source` is how a link was made: `manual` (Reviews), `auto` (a shell command that works on it, a bbpr command or the chat's branch), `agent` (`link_pull_request`) or `created` (`create_pull_request`); an explicit link upgrades an `auto` one, and rows from before 0.9.29 keep `manual`/`auto`. `state`/`state_at` hold the PR's last read state (`setPullRequestLinkState`), written by every Reviews list read, a Reviews merge or decline, and `pull-requests/link-sync.ts`, which on the same bus re-reads a chat's open links after a shell `gh pr merge|close` or `bbpr merge|decline` completes and at a turn end when older than 15 min; the chat header prefers it when newer than the list (`linkHeaderState`). The same sync links the open PR of the branch checked out in the chat's cwd at session start and turn end (`auto`, host answer cached 5 min per repository and branch, a failure not repeated for 60 s), so a second chat opened on a PR's branch links it. Auto-link, history scan and sync failures are kept per chat in memory for `list_thread_pull_requests`. Phones list a chat's links (state and source) and may unlink (Expo `PrLinksBanner`, Android port of `phoneLinkRowText`). Both the auto-link and `pull-requests:link` accept only a PR of a repository the chat's `project_path` covers. That rule lives in ONE place, `shared/project-repos.ts` (pure, the scan injected): a project covers every repository its own remotes point at (`reposFromRemotes`: upstream first, then origin, then the rest) and the repository its primary remote was forked from (`PullRequestProvider.forkParent`, read once per process), or, ONLY when its folder points at no GitHub or Bitbucket repository (a parent of several), the repositories of the git work trees at most two levels below it (`scanChildWorkTrees`: no hidden folders, `node_modules` or symlinks, never inside a work tree it found, at most 400 directories listed; a project at the home folder or a filesystem root is never scanned, which would raise TCC prompts for ~/Desktop and the like). `PullRequestService.projectRepos` caches it 60s per project (one shared scan per window), and the service, both scanners, `pull-requests:link` and the agent PR tools all read it. A bare `bbpr <n>` still binds to the project's own repository only; a child repository's PRs link by URL. Only a PR a chat works on links (`shared/pr-command-links.ts`): the PR URL a shell command hands to `gh pr create|checkout|merge|edit|comment|review|ready|close|reopen` or to bbpr (unquoted, so a PR body naming another PR does not count), the output of a `gh pr create` tool call (matched by tool id), and a bare `bbpr 605`. A PR only mentioned (assistant or user text, `gh pr view`/`diff`/`checks` output, a file read, a web fetch) is not linked; the agent links one on purpose with `link_pull_request`. A bare `bbpr <n>` counts only when it runs in the chat's repository (`shared/bbpr-command.ts` `bbprTargets` + `pull-requests/bbpr-targets.ts`, both scanners): no `cd` (the chat's worktree or project), or `cd`s that resolve, absolute or relative to that cwd, to a directory whose git remote is the chat's repository. `~`, variables, `cd -`, a bare `cd` or `popd` are skipped, never guessed. Chats older than linking are covered by `pull-requests/history-scan.ts`: once per chat after launch (`startPullRequestHistoryScan`, table `conversation_pr_history_scans`) it runs the same rule over tool inputs, and over a tool output that follows a `gh pr create` input, read by `history-source.ts` from the same sources as `loadConversationHistory` but streamed and stopped at 250,000 chars (the JSONL parser drops tool results and Codex tool calls, so that reader picks them off the line), plus a bare `bbpr 605` in a tool input for a Bitbucket project (`shared/bbpr-command.ts`); `pull-requests:history-scan` re-scans one chat (sidebar "Find linked PRs in this chat").
- **Review context** (`shared/review-context.ts`): "Ask the agent" becomes ONE draft pill of kind `review` whose `content` is the plain text expansion (12 KiB cap) and whose label is capped at 120 chars, the stored pill label limit (`pill-metadata.ts`, Android). The pill is added by `addPill` plus a `[[pill:id]]` token appended to the draft, which the composer hydrates whether or not it is mounted (`reviews/review-to-chat.ts`).
- **Conflicts** ride on `PrSummary.mergeConflicts` / `conflictedFiles`. GitHub's API never names the files; Bitbucket's `GET /pullrequests/{id}/conflicts` does (the diffstat no longer marks conflicts: its `merge conflict` status went with the merge preview Atlassian removed on 2026-09-04), and the list reads it with the other enrichment, cached against `updated_on` plus the destination commit (a moved main makes a conflict without the PR changing).
- **Who counts as involved** (`involvesViewer`): author, requested reviewer, reviewed (a verdict), or commented (`hasCommented`: a GitHub COMMENTED review, a Bitbucket participant entry with no verdict). Dropping commenters hid PRs the user reviews by commenting.
- **Hide from Reviews** is local: `db/pull-request-hidden.ts` (keyed by `prKey`), applied in the LIST handler by `applyHidden`, which clears a hide once `hiddenComesBack` (changed after the hide AND in Needs you). `pull-requests:hide`/`unhide` are open to a phone: nothing reaches a host.
- **Repositories an account cannot see** (`shared/pull-request-hidden-repos.ts`): a `not_found` / `forbidden` source (a Bitbucket workspace the token's account has no access to, a GitHub org refusing the token: GraphQL `FORBIDDEN`) gets ONE card per host and kind naming every repository by owner (`describeRepoFailures`), with "Hide these repositories" behind a confirm. Rate limits and offline errors are never offered. Hidden repositories live in `pull_request_hidden_repos` (keyed by `repoKey`, same file as the PR hides) and the service's `hiddenRepos` dep skips them BEFORE asking the host, so a hidden 404 costs nothing per refresh; the list returns them as `PrListData.hiddenRepos` for the "N repositories hidden · Show" row. `pull-requests:hide-repos`/`unhide-repos` are local and open to a phone. `SB_DEMO_REPO_ERRORS=1` adds a 404ing workspace to the demo (`e2e/review-hidden-repos.e2e.mjs`).
- **GitHub read retry**: a read (`GitHubProvider.read`: list, detail, threads, checks, files, reviewer candidates, the login) that gh fails with `HTTP 500/502/503/504` or GraphQL "Something went wrong while executing your query" on stderr (`isTransientGhFailure`) is tried ONCE more after 1 s. Writes (`rest`, `mutate`) call `run` directly and are never re-sent. The LIST is batched (4 repositories per query; merged rows use the light `MergedPr` fragment) and a batch that fails transiently, including a body cut short ("unexpected end of JSON input") or gh killed by its 30 s timeout, is split in half rather than retried whole, down to one repository, which gets the one retry and then its own error card. Only a host-wide failure (signed out, offline, rate limit) fails all of GitHub.
- Bitbucket credentials: `credentials.ts`, safeStorage-encrypted file `userData/source-control/bitbucket.bin`, never the settings table (so never settings.json or `settings:get`). No safeStorage (headless server) means `needs_desktop`, never plaintext. In `device-auth.ts`, `source-control:*` (by prefix) and every `PullRequestWriteChannels` channel (by name) are admin-scoped; every other `pull-requests:*` channel (`PullRequestChannels`: the reads, links, reviewer candidates, history scan, and `pull-requests:hide` / `unhide`) is open to a phone.
- `SB_DEMO_ADAPTER=1` swaps in `demo.ts` (the mock's data) for the visual harness screens `reviews` and `reviews-files`.

### Kanban board (⌘⇧K top-level view)

- Top-level view (not a right-pane mode) swapping the chat area for a workspace-scoped board; sidebar stays mounted. `layout-store.appView: 'chats' | 'kanban'`.
- `kanban_cards` table: `(id, project_path, title, description, tags JSON, status, cost_cap_usd, cost_used_usd, runtime_mode, conversation_id, worktree_path, worktree_branch, created_at, updated_at, completed_at)`. Statuses: `backlog | in_progress | needs_input | done`.
- IPC (`KanbanChannels`): `list / create / update / delete / create-worktree / remove-worktree / list-worktrees`. Moving a card to `done` auto-archives its linked conversation (`applyKanbanArchiveSideEffect`); moving back unarchives.
- `card-launch.ts` `launchCardChat`: reuses the linked conversation if live, else spins up a new session rooted at `worktree_path ?? project_path`, links card→conversation, seeds + auto-sends the first turn (title + description). `WorktreeManagerModal` is the Settings worktree manager (`settings/WorktreesPanel.tsx`) scoped to the card's project - one list, one removal path.

### Lexical chat input (pill chips + @-mentions)

- `RichChatTextarea.tsx` - Lexical `PlainTextPlugin` editor that serializes to a plain string with `[[pill:id]]` tokens (draft store stays string-shaped). Replaced the plain `<textarea>`.
- **Pill chips** (`PillNode` decorator + shared `PillChipVisual`): three kinds - `file` (blue), `terminal` (amber), `chat-message` (purple). Inserted by ⌘L context bridge; `×` removes (fires `sb-pill-remove` to prune metadata). Round-trip through `[[pill:id]]` on paste/reload. `renderPillBody` rebuilds chips in sent bubbles.
- **@-mentions**: `@` at a word boundary opens `AtMentionMenu`; `detectAtTrigger` + `filterAtMatches` rank with `services/fuzzy-score`; Enter inserts a file ref.
- `shared/rotation-marker.ts` - when the user swaps provider instance mid-chat, a `[[sb:instance-rotated]] <from> → <to>` system marker renders as a compact pill.
- `BranchPicker` (`main ▾` chip) switches the session's git ref via `git:switch-ref` (policy in `branch-picker-policy.ts`: current first, then locals, then remotes; substring filter).

### Project favicons (`sb-favicon://` protocol)

- `favicon-resolver.ts` probes static icon paths (root → public/ → app/ → src/ → assets/ → .idea/, each `.svg`/`.ico`/`.png`), cached by `(projectPath, parent mtime)`. Fallback `favicon-html-scan.ts` scans `index.html` / framework root files for `<link rel="icon">` (skips data:/http: hrefs, containment-checked).
- Served via the `sb-favicon://favicon?path=<encoded>` custom protocol (`protocol/sb-favicon.ts`) - path must match a known DB project. `ProjectFavicon.tsx` renders it in the sidebar, falling back to a folder glyph on error.

## What's currently working

- Claude Code SDK integration end-to-end: streaming text, tool calls, context window metrics, interrupt
- Codex app-server integration: basic chat + plan-mode + AskUserQuestion + image support (Phase B done)
- **OpenCode ACP adapter** (2026-04-28, only OpenCode adapter - legacy `opencode run --format json` shell-out retired 2026-05-02): speaks the Agent Client Protocol over a long-lived `opencode acp` child. Dynamic model list, shell-env probing for API keys, settings-DB key injection, placeholder + heartbeat + 3-min timeout (free-tier-aware error message) for cold-boot UX. Skill discovery via `available_commands_update` ACP push events. Helper: `adapters/opencode/env.ts` for shared env-probing.
  - **OpenCode 1.x only, for now** (2026-09-29). OpenCode 2.x is the same `opencode` binary (curl installs it to `~/.opencode/bin/opencode`, v1's path too; npm `@opencode/cli`; brew `opencode-v2`, which conflicts with `opencode`) and it breaks us: `acp` takes no options, so our `acp --cwd <dir>` is rejected before ACP starts; `session/set_model` is gone (the model is a `session/set_config_option` with `configId: "model"`, `"effort"` for the variant) and `session/new` returns `configOptions` instead of `models`; and `opencode models` attaches to a shared background service spawned with its first caller's env, so an instance's API keys may not apply. `adapters/opencode/version.ts` reads `opencode --version` once per binary (keyed by path, mtime and size) and `assertSupportedOpencode` throws `OpencodeUnsupportedVersionError` for major >= 2 before the adapter start, the native-fork runner, the catalog probe and the Settings Test spawn anything. `--version` runs in the spawn's cwd, and the cache is keyed by cwd and by `opencodeEnvFingerprint` (a hash of PATH, HOME, `OPENCODE_*`, `XDG_*` and version-manager keys, never logged), for shims and wrappers that pick an install per directory or env. A native fork that is refused falls back to the handoff with the refusal as its warning (`native-fork-unsupported-version`). When it fails or is unparseable, `opencodeV2InstallSignal` judges the files without running anything: an `opencode2` shim beside the binary (v2's curl installer and `@opencode/cli`'s second npm bin; v1 has neither) or a real path in `@opencode/cli` or brew's `opencode-v2` Cellar means 2.x. With no version and no signal the binary is let through (a 1.x must not be locked out), and that is the known hole: a renamed or hand-copied 2.x that cannot print its version would run and could migrate `opencode.db` one way. Unparseable output is logged as a byte count only. A v2 path needs, behind a flag: no `--cwd` (spawn `cwd` covers it), model and effort changes through `setSessionConfigOption` whenever `configOptions` comes back (that response shape can pick the branch, so one adapter serves both), `--standalone` on `opencode models`, and a live re-check of the permission injection, the question tool and the `switchboard_*` tool names. Also note v2 migrates `opencode.db` forward in place and moves `auth.json` credentials into it, so a downgrade is not guaranteed clean. Research, from the v2.0.19 source: `docs/notes/opencode-v2-research.md`.
- Plan mode with hard-deny + read-only allow-list
- AskUserQuestion → QuestionCard (numbered shortcuts, auto-advance)
- ExitPlanMode → PlanCard (markdown + Implement/Iterate)
- Image paste/drag/drop → SDK image blocks → persist across reload
- Archive conversations (global ID filter)
- Drag-to-reorder projects (`@dnd-kit`)
- Auto-title generation from first user message
- Runtime mode selector (Plan/Sandbox/Accept-Edits/Full-Access) per-session, live-updates mid-turn
- Tmux-style terminal windows + tabs + splits with proper cwd
- **Remote backend over SSH**: a standalone headless server (`src/server`, `WsHost`) runs agents/PTYs/git/fs on a remote VM; the desktop app connects over an `ssh -L` tunnel via a `Transport` seam and drives local + remote sessions in the same window (`HybridTransport`/`TransportRouter`). Remote chats survive reconnects. See Backend transport seam above. (No mobile client, no cloud relay yet.)
- Pre-commit hook + CI (GitHub Actions: typecheck + test + build)
- **Slash command menu in chat input** with agent-skill exposure (2026-04-26): Claude SDK `init.commands` + Codex `skills/list` + OpenCode `available_commands_update` surfaced alongside Switchboard's 9 built-ins. Source-grouped sections in the menu; agent-source selections insert `/<name> ` for the user to fill in args.
- **`⌘L` multi-source context bridge** (2026-04-29): single keybinding routes by the focused element's `data-context-source` attribute (`terminal | file-viewer | chat-message`). Terminal selection → fenced code block w/ pane label header (50k char cap). File-viewer selection → `@<path>:<start>-<end>` pill + fenced block. Chat-message selection (an assistant reply, or the user's own message as `you`, its chips read as their labels through `textWithPillLabels`) → `> from <agent | you>: "..."` quoted block. A pill inserted while the composer is unfocused skips Lexical's DOM selection write (`SKIP_DOM_SELECTION_TAG`) and saves its caret for the focus restore, or the restore puts the caret back before the chip. All three append to the active session's draft via `useDraftStore.appendDraft`. Pure formatters (`formatTerminalContext`, `formatFileViewerContext`, `formatChatMessageContext`) are unit-tested.
- **Per-turn duration badge** (2026-04-29): adapters stamp `turnStartedAt` on `sendTurn` and emit `durationMs` on `turn.completed`. MessageBubble renders "Worked for X.Xs" under the assistant message via `fmtDuration` from `src/shared/format.ts`. Wired across all 3 active adapters (claude, codex, opencode-acp).
- **Right-pane "IDE" mode** (⌘⇧E to toggle, 2026-07-10): the right column flips between the terminal strip and the embedded VS Code workbench. `layout-store.rightPaneMode` (persisted under `layout.rightPaneMode`). Both panes stay mounted so toggling preserves xterm/pty and workbench state.
- **Embedded IDE (code-server)** (2026-07-10): full workbench, one server + one webview per app, idle shutdown, cmd+l selection → chat pill, pill click → open-at-line - see Embedded IDE section
- **Inline file pills in agent messages** (2026-04-29): `MessageBubble` post-process walks rendered markdown DOM; inline `<code>` tokens that match `looksLikeRepoPath()` become clickable chips. Path heuristic in `src/shared/file-path-ref.ts` (must contain `/`, must end in `.<ext>` or have `:line[-line]` suffix; rejects URLs and absolute paths to avoid false positives). Click → `layout-store.openInViewer(path, lineRange)` flips the right pane to the IDE and routes an open-at-line through the sb-bridge. Existence verified via `files:resolve` IPC; non-existent paths revert to plain code.
- **`⌘L` context bridge** (legacy alias retained for the terminal flow inside the multi-source dispatch above)
- **`⌘K` quick prompt**: floating prompt bar that sends a one-shot turn to the active session. Pre-fills with the workbench selection (cmd+k inside the IDE, Cursor-style: instruction -> agent edits -> FileDiffCard review) or the current terminal selection
- **Side-by-side dual chat panels** (`⌘|` toggle, `dualChat`/`rightSessionId`/`chatSplitRatio` in layout-store)
- **"Send to other panel"** forward action on messages
- **System notifications** on `turn.completed` for non-active sessions (`src/renderer/services/notifications.ts`)
- **Export conversation as markdown** (`export-markdown.ts` + Sidebar right-click)
- **`⌘F` in-pane search** for terminals (xterm SearchAddon with decoration overlays - requires `allowProposedApi: true`) and individual chat panes (DOM TreeWalker wraps first match in `<mark.sb-search-mark>`); shared `InPaneSearchBar` component, document-level keydown listeners scoped to focused pane via `[data-terminal-pane]` / `[data-chat-panel]` attrs
- **Message search** (`⌘⇧F`, Android's search screen, channel `app:search-messages`): the query rule, result shape and order live in `shared/message-search.ts` (words as FTS prefixes, every word required, phrase then bm25 then recency), the archive rule in `shared/archive-intent.ts` (`parseArchiveIntent`: the word archive/archived includes archived chats; Go to chat should use the same function). New result fields are optional so older backends and clients keep working. The desktop searches this machine plus each connected remote (`services/message-search.ts`), opens a hit through `handleSessionSelect`, then `requestChatFind` opens that chat's `⌘F` bar prefilled and anchored on the hit (`useChatSearch`). `⌘F` matches the typed text or every word of it (`textMatchesSearch`).
- **Feature Tour modal** (`FeatureTourModal.tsx` + `feature-registry.ts` in `src/renderer/components/onboarding/`) - auto-opens on first launch and after `TOUR_VERSION` bumps; replayable from Settings → Tour. MP4 clips streamed via `sb-tour://<id>.mp4` custom protocol (resolves to `videos/dist/`, served via `net.fetch('file://...')` for byte-range support). **Every clip is recorded from the real app** by `videos/capture-tour.mjs`: Playwright drives the built bundle (`npm run build:fast` first) against an isolated seeded fixture with `SB_DEMO_ADAPTER=1`, which swaps every provider for the scripted `adapters/demo-adapter.ts` so agent-driven scenes (plan-mode denial, diff card) are deterministic and need no credentials. Scene ids in that script MUST match `FEATURE_TOUR_STEPS`. Re-record after any visible UI change: `node videos/capture-tour.mjs <id>` (or `all`), then look at the frames before committing. The `ide` scene symlinks this Mac's code-server install into the fixture so it never downloads. The README hero is the same script with `SB_SCREENSHOT=docs/images/hero.png node videos/capture-tour.mjs hero`. Do NOT hand-draw UI replicas again (the HyperFrames scenes were deleted 2026-09-15 after drifting from the app within four months; see `docs/notes/hyperframes-spike.md`).
- **Agent-aware UI labels**: `agentLabel()` / `agentShortLabel()` helpers in `shared/types.ts` so MessageBubble, notifications, etc. all reflect Claude Code / Codex / OpenCode correctly
- **Multi-instance provider picker** (shipped): named credentials per agent type (env or oauth_dir), `UnifiedProviderPicker` + Settings → Providers, env overlay + session migration at spawn - see Provider instances section above
- **Kanban board** (⌘⇧K) with worktree-backed cards - see Kanban section
- **Conversation forking** ("Fork from here" / "Fork to worktree") - see Conversation forking section
- **Lexical chat input** with pill chips + `@`-mention file autocomplete - see Lexical chat input section
- **Project favicons** in the sidebar via `sb-favicon://`
- **Bookmarks** (`bookmark-store` + `bookmarks` DB table) - bookmark messages/sessions
- **In-chat diff review** (2026-06-02): after each turn, changed files surface as Cursor-style diff cards in chat with per-hunk accept/reject. Git checkpoint at turn start (`src/main/git/checkpoint.ts` + `checkpoint-tracker.ts`); `file-diff-resolve.ts` applies/reverts hunks; `file.edited` events are provider-agnostic (git is the source of truth). `FileDiffCard.tsx` renders the cards. Reject is offered only for files this chat's own edit tools wrote (`agent-written-paths.ts`: `tool.started` inputs, plus `tool.completed.writtenPaths` from OpenCode, counted once the tool completes); every other changed file, a binary side, or a side git could not read carries `noRevert` and shows no Reject. Paths are relative to the session folder (`git diff --relative`). A steer or queued send keeps the running turn's baseline, a queued turn starts from the previous turn's end tree, and the baseline is stored in `turn_checkpoints` (keyed by root id) and replayed as cards when the chat starts after a restart.
- **Cross-session messaging**: `/send-to <session>: <message>`, plus two tools on the Switchboard MCP server (`list_agent_sessions` / `send_agent_message`) that let any of the three agents hand a finding to a sibling session itself, behind an approval card and two extra guards (hop depth, per-sender budget) - see Cross-session messaging above
- **Agent PR tools** (Reviews step 4): one Switchboard MCP server gives Claude, Codex and OpenCode `get_pr_status`, `list_pr_conversations`, `get_pr_diff`, `reply_to_conversation`, `resolve_conversation`, `rerun_check`, `comment_on_line` and `draft_review` for PRs linked to the chat, plus `create_pull_request`, which opens one on the chat's project repository and links it, each write behind one editable Switchboard approval card - see Switchboard MCP server above
- **Thinking effort** (2026-10-08): one "Effort: <level>" control right of the model chip for all three agents (`chat/EffortPicker.tsx`, rules in `shared/effort.ts`). Levels come per model from the catalog: Claude `ModelInfo.supportedEffortLevels` (mapped by `provider/claude-models.ts` for the live list and the probe) as `ModelOption.effortLevels`, Codex `model/list` `supportedReasoningEfforts` / `defaultReasoningEffort` (Low to High on Medium when absent), OpenCode the `model.variants` event (a pick rewrites the model id). Claude sends it as the query's `effort` and live through `applyFlagSettings({ effortLevel })`; Codex per turn, only a level offered for the model (`codexWireEffort`). `ReasoningEffort` is `low | medium | high | xhigh | max`, stored per chat (`conversations.reasoning_effort`) and filled in by `sessionDefaultsFor` when a client sends none. No status bar: the terminal count is in the terminal strip header, OpenCode's cost beside the context ring. Phones are staged (`docs/feature-parity/effort-control.json`)
- **Diagrams and charts in chat** (2026-10-08): a closed top-level ```mermaid or ```chart fence is drawn (`shared/chat-visuals.ts`: `splitVisualBlocks`, the versioned chart spec `parseChartSpec`, `renderChart`; Android port `ChatVisuals.kt`, both run `tests/fixtures/chart-spec-cases.json` and `visual-fence-cases.json`). Desktop: `components/chat/visuals/` (`MessageMarkdown` splits, `ChatVisual` draws lazily with a theme+source cache, `diagram-render.ts` runs Mermaid with securityLevel strict and HTML labels off, then DOMPurify; Open in pane is `layout-store.paneVisual`, an overlay over the right pane). Phones draw in a WebView that loads ONE bundled page, `apps/mobile/assets/visual-host/visual-host.html`, generated from `src/visual-host` by `node scripts/build-visual-host.mjs` and committed (Android reads the same folder as its assets); `tests/unit/visual-host-asset.test.ts` fails until it is rebuilt after a change to its inputs or a Mermaid/DOMPurify bump. The source goes in as a JSON message, never as markup. See `docs/feature-parity/chat-visuals.json`
- **Go to chat** (⌘P, 2026-10-08): `GoToChatDialog` lists every chat the sidebar lists (it reads `app:get-projects` on each open, plus the machine store's remote projects) and the local archived chats; Enter opens through `handleSessionSelect`, ⌘Enter through its `beside` placement. The rules (title tiers, then project name, newest first in each; Recent = newest 5; archived only with the word archive/archived) are `shared/chat-search.ts`, ported to Android as `ChatSearch.kt`; both run `tests/fixtures/chat-search-cases.json`, and both phones' chat-list search boxes use them. See `docs/feature-parity/go-to-chat.json`
- **Landing screen** (2026-10-02, design A the same day): the primary slot shows it when it holds no chat or a draft. cmd+shift+O, + New chat and the palette's New chat go there from any chat (`showLanding` replaces the primary slot only; the chat stays open), and cmd+shift+O on it opens the project chip. A centred 680 px composer card bound to the project's draft (`draftSessionId`), so the first send uses the ordinary draft materializer, the project chip first in its bar, the 3 latest chats under it (arrow keys from an empty composer), and a hint line from the live bindings. While it shows, its draft is the companion session (`companionWithLanding`, `selectCompanionSessionId`): terminals, cmd+J/L/K and the IDE act on that project, and cmd+K creates the chat through the materializer (`keepDraft`). Rules in `services/chat-landing.ts`; drafts never auto-fill an empty primary slot. See `docs/feature-parity/chat-landing-screen.json`
- **Queued messages you can act on** (2026-09-24): a held follow-up renders as a dashed Queued bubble with Send now / Cancel on desktop and phone (Held with Resume after Stop or a failed turn, Not sent for one that could not start, see `turn.queue-held`); the composer is two round icon buttons driven by the `chat.followUpDefault` setting (Steer / Queue), and the drift chip can be muted per conversation (`conversations.follow_suggestions`, auto-off past two worked worktrees). See `docs/feature-parity/composer-follow-ups.json`
- **Rate-limit event handling** (2026-06-10): Claude SDK `rate_limit_event` surfaced as a chat status message with window type + reset time; subprocess leak on `stopSession` fixed (6 new tests in `claude-adapter-stop-session.test.ts`)
- Single-instance lock
- Native app menu (`⌘,` for settings, standard Edit/View/Window)
- File-based logger at `~/Library/Application Support/switchboard/logs/`
- Launch-config YAML parser (runtime hydration on launch)
- **Cursor recovery import** (2026-08-24): read-only legacy/current SQLite discovery, exact project matching, explicit idempotent snapshot, durable Cursor provenance, and one-time bounded Claude continuation handoff
- **Credential-aware Desktop signing** (2026-08-24): complete macOS/Windows secrets select forced production signing (plus macOS notarization); absent secrets preserve unsigned packaging; partial sets fail closed
- **Launch-config hot reload + startup orchestration**: `.switchboard/launch-config.yaml` changes reconcile live layouts and per-pane `wait_for` gates commands
- **Provider/profile context preservation**: cross-provider changes inject one bounded handoff; same-provider OAuth rotations migrate and resume validated native transcripts. The BACKEND builds the handoff into the next accepted turn (`withPendingHandoff` in the registry, rules in `shared/handoff.ts`) and consumes `pending_handoff_from` in the acceptance transaction; `app:get-conversation-pending-handoff` answers `backendBuilds: true`, and only clients of an older backend build one themselves. An agent switch is one transaction (`switchConversationAgent`: selection, `[[sb:agent-switched]]` marker, pending flag; history is the client's flag OR a stored user/assistant message on any thread id), asked for by a 4th argument to `app:set-conversation-provider-selection`. A provider returning to a chat whose native session resumed (`ProviderAdapter.resumedNativeSession`) gets only the turns after the newest switch marker that left it; a failed native resume prefixes the next message with the visible conversation (`SessionStartOpts.portableHistory`). The handoff pins the first user message, carries tool calls and errors in compact form, keeps the tail of an oversized newest turn, and is budgeted against the pinned model's last reported context window, else 30,000 characters

## What's NOT working yet

- **Production signing credentials** - implementation is ready, but releases remain unsigned until repository secrets contain the actual Apple Developer ID/notarization and Windows Authenticode credentials.
- **Codex / OpenCode native fork limits** - Codex cannot fork natively at a user message or mid-turn (turns are atomic); OpenCode only forks natively at the latest reply and never into a new worktree, and chats older than OpenCode session recording (or whose session was replaced) keep the handoff. A fork that fails to commit leaves an unused OpenCode session behind (ACP cannot delete one); a forked Codex rollout is deleted

## Skill exposure (shipped 2026-04-26)

`ProviderAdapter.listSkills?(threadId)` is the seam:
- **Claude adapter** captures `system/init.{slash_commands|commands}` and prefers live `query.supportedCommands()`. Cached on the active session.
- **Codex adapter** sends JSON-RPC `skills/list`, caches result. Older builds get a graceful empty cache (logged, not retried).
- **OpenCode** receives skills via `available_commands_update` ACP push events; the adapter caches the list and `listSkills()` returns it directly. (The earlier `opencode debug skill` shell-out was replaced when the ACP adapter was finalised.)
- IPC: `ProviderChannels.LIST_SKILLS` → `provider:list-skills` (preload `window.api.provider.listSkills(threadId)`).
- UI: `ChatInput` fetches on session start with retry-while-empty (handles late `system/init`); `mergeWithAgentSkills` keeps built-ins first, name-collisions resolve in favor of built-ins so `/clear` always means "clear chat" not whatever a skill named `clear` does. `SlashCommandMenu` renders source-grouped sections + argument-hint suffix. Agent-source selections insert `/<name> ` into the textarea (no special wire path) - the SDK / CLI parses leading slash from the prompt itself.

Pure parsers exported and unit-tested: `parseClaudeSlashCommands` (claude-adapter), `parseCodexSkills` (codex-adapter), `mergeWithAgentSkills` + `skillsToSlashCommands` (slash-commands.ts).

## Test suite

Run the whole suite: `npm test`. Targeted runs: `npx vitest run tests/unit/<file>.test.ts`. Notable files:

- `message-list.test.ts` - `groupIntoTurns` keeper-list (regression for empty-content attachment drops)
- `slash-commands.test.ts` - slash trigger + registry
- `session-scanner.test.ts` - exact-match matching (parent/child bleed)
- `claude-adapter-plan-mode.test.ts` / `provider-policy.test.ts` - plan mode permission policy
- `provider-adapter-tool-filter.test.ts` - `CUSTOM_UI_TOOLS` set membership
- `jsonl-parser.test.ts` / `jsonl-truncate.test.ts` - Claude + Codex schemas, historical images, fork truncation
- `provider-instances-db.test.ts` / `*-instance-env.test.ts` - multi-instance credentials + env overlay
- `worktree.test.ts` / `worktree-paths.test.ts` - worktree list/find-stale/remove + deterministic session worktree paths
- `code-server-manager-*.test.ts` / `ide-bridge-server.test.ts` / `sb-bridge-protocol.test.ts` - embedded IDE: manager lifecycle, bridge routing, extension protocol
- `at-mention.test.ts` / `render-pill-body.test.ts` / `draft-pills.test.ts` - Lexical pills + @-mentions
- `kanban-store.test.ts` / `card-launch.test.ts` / `kanban-archive-side-effect.test.ts` - kanban
- `favicon-resolver.test.ts` / `favicon-html-scan.test.ts` / `favicon-protocol.test.ts` - favicons

better-sqlite3 loads under vitest. For a test of the `db/*` modules, import `createMigratedDb` from `tests/unit/helpers/test-db.ts` (it makes every connection `:memory:`, so `getDb()` runs the real open path and `migrate()`) rather than writing a fake SQL matcher.

`tests/fixtures/model-catalog.json` is `src/shared/models.ts`'s catalogs as data; `model-catalog-fixture.test.ts` keeps it equal (regenerate with `SB_UPDATE_FIXTURES=1`) and Android's `NewSessionDecisionsCatalogFixtureTest` checks its copy against it.

### Screenshot regression tests (every theme)

`npm run test:e2e:visual` (after `npm run build:fast`) has two phases. The
**screens** phase captures the key screens (chat after a finished turn, a long
list reply in a narrow chat, the running composer, sidebar, kanban, Settings, Settings' Accounts page, command palette, message search, provider picker, effort menu,
approval card, and an agent's pull request write card at the default and the narrow width, from the demo adapter's "reply to the review" script; the run fails if that card overflows sideways) in Dark, Light and Translucent against the tour's seeded
workspace (`e2e/fixtures/demo-workspace.mjs`) with `SB_DEMO_ADAPTER=1`, and
compares them with `e2e/snapshots/<screen>-<theme>-darwin.png`. The CI job
`Visual regressions (macOS)` runs it on every PR; on failure the actual and
diff PNGs are in the `visual-regressions` artifact (locally:
`e2e/artifacts/visual/`).

- Background windows (macOS): a Switchboard launched by an agent opens in the background with nothing to export: Claude Code sets `CLAUDECODE=1` in every tool subprocess, and Switchboard puts `SWITCHBOARD_AGENT=1` on every Claude, Codex and OpenCode process it starts (`provider/agent-spawn-env.ts`). Your own terminals carry neither, so a Switchboard you start by hand comes to the front. A background app is an accessory app (no Dock icon), and its window opens with `showInactive()`, fully transparent and click-through (`setOpacity(0)`, `setIgnoreMouseEvents`, with occluded-window backgrounding off so frames keep painting), so it never takes focus or covers the screen; tests read the renderer's own pixels, which opacity does not touch. Outside an agent, `export SB_E2E_BACKGROUND=1` gives the same. `SB_E2E_BACKGROUND=0` forces the foreground (to look at an agent's dev build); the visual behaviour phase sets it itself because it reads the real screen. Do not "fix" an invisible window by calling `focus()`/`show()`.
- A deliberate visual change: `SB_VISUAL_SCOPE=screens SB_UPDATE_SNAPSHOTS=1 npm run test:e2e:visual`, then Read every changed PNG before committing it. Never refresh baselines to make a red run green without looking.
- Everything that varies is pinned: renderer clock (`FROZEN_NOW`, UTC), 1x scale, sRGB, window size, animations and caret, the demo turn's duration (scripted, not wall-clock). Turn timestamps are masked because the main process stamps them. A new source of drift must be pinned the same way, not absorbed by raising the tolerance.
- Translucent is compared as the app's own pixels flattened over a fixed two-colour backdrop, because the real desktop behind the window is never the same twice.
- The **behaviour** phase (native glass transmission, fullscreen fallback) reads the real screen with `screencapture`: it needs Screen Recording permission for the terminal and does not work on the CI runner, so run it locally (`SB_VISUAL_SCOPE=behaviour`) before merging anything that touches translucency.

### E2E temp-dir cleanup (MANDATORY)

The e2e scripts (`e2e/ide.e2e.mjs`, `e2e/ide-workflow.e2e.mjs`, etc.) create ~600MB temp dirs per run via `mkdtempSync` (`sb-ide-e2e-*`, `sb-ide-wf-*`, `sb-ide-proj-*`, `sb-update*`, `sb-ide-probe*`) and do NOT clean up after themselves - this has filled the entire disk before (600+ leaked dirs, ~18GB). You are welcome to run e2e tests, but after every e2e run (pass, fail, or crash) you MUST delete the leftovers:

```sh
for p in sb-ide-e2e- sb-ide-wf- sb-ide-proj- sb-update sb-ide-probe; do rm -rf "$TMPDIR$p"* /tmp/"$p"*; done
```

Only these prefixes: never `rm -rf /tmp/sb-*`, which also deletes other sessions' live worktrees.

If you touch the e2e scripts themselves, prefer fixing the leak at the source: register a `process.on('exit')` handler that `rmSync`s every `mkdtempSync` dir the script created.

## File structure (condensed)

```
src/
├── server/index.ts                    # Standalone headless backend (WsHost) for remote VMs → out/server/index.cjs
├── main/
│   ├── index.ts                       # Electron main
│   ├── backend/                       # host.ts (BackendHost: ElectronIpcHost | WsHost) · ws-host.ts
│   ├── machines/                      # sshTunnel · connectionManager · provisioner · reconnectBackoff (remote-over-SSH)
│   ├── agent/
│   │   ├── jsonl-parser.ts            # Source-aware (claude-code | codex) + image extraction
│   │   └── jsonl-truncate.ts          # Pure fork truncation (assembleClaudeForkAtEvent)
│   ├── conversations/fork.ts          # Fork-from-message orchestration (per-provider resume)
│   ├── db/
│   │   ├── database.ts                # getDb + migrate(); re-exports the domain modules below, so import from here
│   │   ├── projects.ts · conversations.ts (+ thread ancestry, archive) · messages.ts · settings.ts (+ session layouts) · kanban.ts · bookmarks.ts
│   │   └── provider-instances.ts       # provider_instances CRUD (safeStorage-encrypted env)
│   ├── files/                         # listing (gitignore-annotated) · writing (atomic+conflict) · gitignore matcher
│   ├── git/                           # diffHunks (gutter) · refs · worktreePaths · checkpoint (diff review)
│   ├── ide/                           # code-server-manager · binary (download) · bridge-server (ws)
│   ├── worktree-creation/             # git-adapter.ts - transactional kanban/fork worktree creation
│   ├── worktree.ts                    # worktree list / find-stale / remove (creation lives elsewhere, see above)
│   ├── mcp/                           # Switchboard MCP server: stdio bridge · loopback server · tokens · approval cards · PR + peer tools
│   ├── ipc/
│   │   ├── terminal.ts · app.ts       # PTY · projects/sessions/archive/fork
│   │   ├── files.ts · git.ts · ide.ts · kanban.ts # files + git + IDE + kanban IPC
│   │   ├── provider-instances.ts       # instance LIST/UPSERT/DELETE/TEST/CREATE_OAUTH_DIR
│   │   └── enrich-display-body.ts       # pill/display-body enrichment for stored messages
│   ├── projects/
│   │   ├── session-scanner.ts         # exact-match Claude + Codex scanners (encodeClaudeProjectPath)
│   │   ├── favicon-resolver.ts         # static icon probe (cached by path+mtime)
│   │   └── favicon-html-scan.ts         # <link rel=icon> fallback scan
│   ├── protocol/sb-favicon.ts         # sb-favicon:// custom protocol handler
│   ├── provider/
│   │   ├── provider-registry.ts       # IPC handlers, instance resolution, event forwarding
│   │   ├── turn-submission-results.ts # pure turn-result helpers (legacyAcceptanceResult, rejectedAtomicTurn, ...)
│   │   ├── policy.ts                  # decidePermission/denialMessage/PLAN_READ_ONLY_TOOLS/CUSTOM_UI_TOOLS
│   │   ├── event-bus.ts               # RuntimeEventBus (decoupled fan-out)
│   │   ├── env-overlay.ts             # instance env merge · claude-session-migrate.ts # oauth_dir rotation
│   │   ├── instance-env.ts            # resolveInstanceEnv (shared by Test + usage probes)
│   │   ├── peer-tools.ts              # cross-session tool names/descriptions/handlers + PeerToolHost
│   │   ├── usage/                     # claude-keychain · claude-usage (HTTP) · codex-usage (app-server probe) · index (dispatch/cache)
│   │   ├── types.ts                   # ProviderAdapter + re-exports from shared/provider-events
│   │   └── adapters/
│   │       ├── claude-adapter.ts      # SDK integration, canUseTool, image blocks
│   │       ├── codex-adapter.ts       # JSON-RPC over stdio (images + plan + AskUserQuestion done)
│   │       ├── opencode-acp-adapter.ts # OpenCode (ACP / JSON-RPC over stdio) - only OpenCode adapter
│   │       ├── opencode/env.ts        # Shared env-probe helper
│   │       └── question-answers.ts    # Shape AskUserQuestion answers for SDK wire format
│   ├── terminal/pty-manager.ts · path-access.ts · updater.ts · logger.ts
│   └── launch-config/launch-config-store.ts   # launch-config.yaml hydration (+ legacy workspace.yaml read)
├── preload/index.ts                   # Typed window.api (SwitchboardAPI), strongly-typed provider.onEvent
├── renderer/
│   ├── App.tsx                        # Flat flex-row layout, all keybindings, view switching
│   ├── services/global-keybindings.ts  # resolveGlobalKeydown: pure keydown → app shortcut action (App dispatches)
│   ├── components/
│   │   ├── CommandPalette.tsx (⌘⇧P) · QuickPromptModal.tsx (⌘K) · SearchModal.tsx (⌘⇧F) · GoToChatDialog.tsx (⌘P)
│   │   ├── SettingsModal.tsx · settings/ProvidersTab.tsx · settings/ProviderUsagePanel.tsx · SessionPickerModal.tsx
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx · ChatInput.tsx · MessageList.tsx · MessageBubble.tsx
│   │   │   ├── provider-event-reducer.ts # desktop provider event → agent-store reducer (ChatPanel's listener)
│   │   │   ├── ChatWorkspacePanels.tsx # primary/secondary ChatPanel slots + ChatSplitHandle
│   │   │   ├── useChatSearch.ts (in-pane ⌘F) · SlashHelpOverlay.tsx · chat-session-settings.ts (mode/model/effort writes)
│   │   │   ├── picker-keydown.ts (send-to/@/slash picker keys) · EffortPicker.tsx (thinking effort, rules in shared/effort.ts)
│   │   │   ├── ApprovalCard · PlanCard · QuestionCard · FileDiffCard · SlashCommandMenu · slash-commands.ts
│   │   │   ├── UnifiedProviderPicker.tsx # agent tabs → instance rail → model search
│   │   │   ├── BranchPicker.tsx + branch-picker-policy.ts · SkillChip
│   │   │   ├── AtMentionMenu.tsx + at-mention.ts · render-pill-body.tsx
│   │   │   └── lexical/               # RichChatTextarea · PillNode · PillChipVisual
│   │   ├── layout/                    # ResizeHandle · ViewToggle (Chats/Board title-bar toggle)
│   │   ├── ide/                       # IdePane (code-server <webview>)
│   │   ├── kanban/                    # KanbanView (⌘⇧K) · CardModal · WorktreeManagerModal · card-launch.ts
│   │   ├── sidebar/                   # Sidebar · ProjectFavicon · WorkspaceManager · dragLogic
│   │   ├── onboarding/               # FeatureTourModal + featureRegistry
│   │   └── terminal/                  # TerminalStrip · TerminalWindow · TerminalPane · TerminalHeader · TemplatePicker
│   ├── hooks/                         # useTerminalLifecycle · useTerminal
│   ├── services/                      # terminal-registry · session-events · contextBridge · fuzzyScore · notifications
│   └── stores/                        # agent · terminal · layout · theme · draft · kanban · provider-instance · skill · bookmark
├── preload/                           # transport.ts (IpcTransport) · ws-transport (via shared) · hybrid-transport · transport-router · routing-table
├── shared/
│   ├── ipc-channels.ts · provider-events.ts · types.ts · auto-title.ts · models.ts · format.ts · file-path-ref.ts
│   ├── provider-usage.ts · claude-usage-parse.ts · codex-usage-parse.ts   # normalised subscription usage limits
│   ├── transport.ts · ws-protocol.ts · ws-transport.ts · machines.ts   # backend transport seam (local ↔ remote)
└── tests/unit/                        # vitest suite (see Test suite)
```

## Logging conventions

Every module that can produce observable side-effects **must** use the scoped logger, not bare `console.*`. This keeps logs filterable, readable in both DevTools and the on-disk log file, and noise-free.

### Performance timing

Use `perfSpan(name, fields?)` from `src/main/perf.ts` or `src/renderer/perf.ts`
and call `end(extraFields?)` once at the measured boundary. Spans use
`performance.now()` and the `perf` logger. Log only identifiers, counts, sizes,
outcomes and durations, never message text, credentials or extra file paths.
`src/shared/perf-timing.ts` owns thresholds: chat open/load 300 ms, switches
1000 ms, IPC 200 ms. Explicit spans use info above the threshold and debug
otherwise; generic IPC records only slow calls. Renderer perf lines reach the
main log through Electron's console forwarding. Run `node scripts/perf-summary.mjs`
to summarize the newest three log files across desktop and headless data
directories, or pass explicit log filenames. Discovery uses platform app-data
paths and honors `SB_USER_DATA` and `SWITCHBOARD_DATA_DIR`; absent log directories
are skipped. History responses carry optional `loadStatus` diagnostics so a
failed load is not counted as a rendered empty chat.
The script prints count, nearest-rank p50/p90, max and the worst five samples.
IPC excludes send-turn, submit-user-turn, respond-to-request, answer-question
and deliver-peer-message because they can wait for a turn or a human answer.

### Main process - `src/main/logger.ts`

```ts
import { createMainLogger } from '../logger'
const log = createMainLogger('domain:subsystem')   // e.g. 'ipc:files', 'ide:bridge'
log.debug('spawnArgs', args)
log.info('session started', { id })
log.warn('retry', err)
log.error('unrecoverable', err)
```

Writes to both the terminal (dev) and `~/Library/Application Support/switchboard/logs/switchboard-<date>-<pid>.log` (always). Log files rotate at 7 days.

### Renderer process - `src/renderer/logger.ts`

```ts
import { createRendererLogger } from '../../logger'   // adjust relative path
const log = createRendererLogger('domain:subsystem')  // e.g. 'store:agent', 'editor:host'
log.info('buffer opened', { path })
log.warn('save conflict detected', err)
```

Outputs to DevTools console with `[SB:scope]` prefix matching the main-process convention.

### Rules

- **Quit source**: any new code path that calls `app.quit()` must call `noteQuitSource(kind, detail)` from `src/main/quit-source.ts` first, so the `quit requested` log line names it. An untagged quit logs as `system`.

- **Module-level constant**: `const log = createXxxLogger('scope')` - never inside functions.
- **Scope format**: `'domain:subsystem'` - e.g. `'ipc:files'`, `'store:agent'`, `'ide:pane'`.
- **No silent swallowing**: every `catch` block that doesn't re-throw must `log.warn` or `log.error`. `catch { /* ignore */ }` is a bug.
- **No AI slop patterns**: don't log "successfully did X" on the happy path unless it's a slow/async operation worth tracking. Log state changes, errors, retries, and lifecycle events.

## Writing style

- **No em dashes (U+2014) anywhere** - not in code, comments, UI copy, log messages, commit messages, PR descriptions, or docs. Use a hyphen with surrounding spaces (` - `), a comma, or two sentences instead. This is enforced repo-wide; a stray em dash is a review-blocker. (Arrows and middots are fine.)
