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
- **Epoch.** `WsHost` mints a random `epoch` per process. A restarted server resets `seq` to 0, so without this a client holding a high cursor would silently discard every later event. A changed epoch, or an evicted cursor, answers `ready { gap: true }` and the client re-seeds via `onResumeGap` rather than showing a transcript with a hole in it.
- **Liveness.** The host pings every 15s and terminates clients that stop answering; the client re-dials after 40s of silence and exposes `probe()`/`forceReconnect()`. A mobile socket dies with no FIN, so elapsed silence is the only signal a client that cannot send protocol pings has. Both sides require proof the peer speaks the heartbeat before acting on its silence, because a phone updates over OTA independently of the desktop it pairs with.
- **Auth in a frame, not the URL** (`src/shared/device-auth.ts`, `src/main/backend/device-sessions.ts`). The QR carries a one-time pairing code (5 min); a device redeems it once for its own session, stored as a sha256 hash and revocable on its own. Scopes deny only what is dangerous (`terminal:*` and `mobile-pairing:*` for a phone, so a stolen phone credential can neither open a shell nor revoke your other devices) rather than allowing only what is listed - deny-by-default needs a hand-maintained channel list whose failure mode is a feature breaking silently for paired devices. Legacy `?token=` still works; `?auth=frame` declares in-band auth, and an unauthenticated socket is closed after 10s.
- **Content is incremental.** `content` events carry a delta with `append`, folded by `applyContentText` (`src/shared/content-stream.ts`). Cumulative text cost O(n^2) bytes per reply. `mergeContentChunks` is associative, which is what lets the renderer's 30fps coalescer and the phone's 50ms batcher drop intermediate commits losslessly.

**Client transports** (`src/preload/`): `IpcTransport` (local), `WsTransport` (`src/shared/ws-transport.ts`, browser WebSocket + reconnect/outbox), `HybridTransport` (desktop-only channels → IPC, everything else → remote WS), `TransportRouter` + `routing-table.ts` (one transport per machine keyed by threadId/terminal id, so one window drives local + multiple remotes at once). `SWITCHBOARD_BACKEND_URL=ws://host:8765` flips the base transport to hybrid; unset = pure local.

`src/shared/*` is the transport-agnostic contract layer (channels, wire protocol, transport interface, events, types) - **no `electron`, no `react` imports**. Consumed by preload AND both backend hosts.

**Remote machines / SSH** (`src/main/machines/`): `ssh-tunnel.ts` builds `ssh -L localPort:127.0.0.1:remotePort … <bootstrap>` (uses the system `ssh` binary - no `ssh2`/native deps; `BatchMode`, `accept-new`), `connection-manager.ts` owns connect/provision/health-probe/auto-reconnect, plus `provisioner.ts`/`remote-exec.ts`/`reconnectBackoff.ts`/`ssh-config.ts`. The renderer then connects to `ws://127.0.0.1:<localPort>` as if local. Docs: `docs/notes/ssh-remote-plan.md`, `docs/notes/remote-machines-handoff.md`. No mobile client and no cloud relay - the "remote client" is the desktop app pointed at a tunneled remote backend.

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
- `turn.queued` / `turn.dequeued` · a `delivery: 'queue'` message is held until the running turn ends / left the queue (`started | promoted | cancelled | dropped`), keyed by its chat row id (`echoMessageId(origin)`). The registry's `QueuedTurnLedger` fills in the text and serves list / promote / cancel (`turn_queue_controls_v1`); outstanding-turn accounting for a queued message is settled on `turn.dequeued` only, never in the IPC handlers
- `status` · session status change · `session` · sessionId recorded
- `context_window` · live token count (polled after each turn)
- `model.variants` · available model variants + current selection
- `plan.proposed` · ExitPlanMode intercept → PlanCard
- `question.asked` / `question.answered` · AskUserQuestion intercept → QuestionCard
- `file.edited` · **2026-06-02**: one event per changed file per turn, sourced from a git checkpoint diff (provider-agnostic) - drives the Cursor-style in-chat diff card with per-hunk accept/reject
- `error` · adapter-level error surfaced to chat

### Image pipeline (2026-04-20)

1. User pastes/drags image in `ChatInput` → `ImageAttachment[]`
2. `ChatPanel.handleSend` converts each `File` to data URL via `FileReader.readAsDataURL`
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
- **Agent-initiated (CLAUDE ONLY)**: two in-process SDK MCP tools (`createSdkMcpServer`, server name `switchboard`, built per query in `claude-adapter.ts`'s `startDraining`), so the model sees `mcp__switchboard__list_agent_sessions` and `mcp__switchboard__send_agent_message`. Names, descriptions and handler behaviour live in `provider/peer-tools.ts` (SDK-free); `adapters/claude-peer-tools.ts` is the zod + `sdk.tool()` binding. **Codex and OpenCode stay valid TARGETS and cannot SEND** - the seam is `ProviderAdapter.setPeerToolHost?`, which only Claude implements, so an equivalent for them is adapter work only.

Delivery is an ordinary `sendTurn`, which is what makes a peer message structurally unable to answer an approval: nothing on the path reaches `respondToRequest`. The receiving body is `wrapPeerMessage`, which tells the peer the message is not from the user and carries no authority.

Guards, all pure in `shared/peer-messaging.ts` and held by the BACKEND so every client shares one budget:

| Guard | Value | Why |
|---|---|---|
| Body cap | 16 KiB | A peer message is a summary, not a transcript |
| Per-pair rate | 5 / 60s | Both initiators |
| Dedupe | identical (from, target, text) inside 10 min | Content-addressed id `pm_<16 hex>` |
| **Hop depth** | `PEER_MESSAGE_MAX_HOP_DEPTH = 1` | Agent sends only. Depth counts consecutive AGENT hops since the last human message, so a session acting on a peer message cannot pass one on: that is the A -> B -> A guard, and rate limits do not substitute for it |
| **Per-sender budget** | 6 / 10 min per SENDING session | Agent sends only. The per-pair limit is multiplied by fan-out otherwise (5 siblings = 25/min) |

Traps:

- **The approval gate is the EXISTING one.** SDK MCP tools route through `canUseTool`, so `decidePermission` already prompts in sandbox / accept-edits, denies in plan and allows in full-access. Do NOT add a parallel prompt. That routing was confirmed by reading the SDK bundle (`processControlRequest` handles `can_use_tool` generically on `tool_name`), NOT against a live Claude session - if an agent send ever runs in sandbox with no approval card, this is the first thing to check. `list_agent_sessions` is auto-allowed early in `canUseTool` next to `ExitPlanMode`: it reads only titles the sidebar already shows, and prompting for a harmless read trains the user to click through the send that follows.
- **Hop depth is NOT cleared at turn end**, only by a user turn (set to 0 in `SEND_TURN`) or `STOP_SESSION`. Clearing it per turn would let an unattended chain continue by waiting.
- **Refusals go back to the model as tool output with `isError`, never as a throw** - a thrown MCP error reaches it as an unreadable transport failure and it retries the same call.
- The per-pair limit (5) is LOWER than the per-sender budget (6), so any test of the budget must fan out over two targets or the pair limit fires first.
- Sender-side provenance is a marker prefix, not a field: `[[sb:peer-sent]]` vs `[[sb:peer-sent-agent]]` (`parseRotationMarker` kinds `peer` / `peer-agent`), because a reload reads the stored string and has nothing else to tell the two apart.

### Archive system

- `archived INTEGER` column on `conversations` table
- `getArchivedConversationIds()` returns a **global** ID set (not per-project) - fixes pre-2026-04-20 bug where a session listed under two project views would reappear after archiving from only one
- Filter applies in `GET_PROJECTS`, `SCAN_SESSIONS`, and `OPEN_FOLDER` handlers

### Slash commands (2026-04-20)

- `SlashCommandMenu` popover wired into `ChatInput` textarea
- Trigger: `/` at start of line, matched by `^\/([^\s/]*)$` (mid-line slashes like paths don't fire)
- Registry in `src/renderer/components/chat/slash-commands.ts`
- v1 commands: `/plan`, `/sandbox`, `/edits`, `/full`, `/clear`, `/archive`, `/image`, `/stop`, `/help`
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

### Embedded IDE (code-server) + file IPC

- **Right pane has two modes** (⌘⇧E toggles): the terminal strip, or the IDE pane. Both stay mounted (positioned overlay) so xterm/pty and workbench state survive toggling.
- `IdePane.tsx` renders the real VS Code workbench served by a per-app `code-server` process in ONE persistent `<webview partition="persist:ide">` - switching projects navigates the same webview to the new `?folder=` (RAM policy: never N workbench renderer processes). Prewarmed in the background once a session is active (server + hidden workbench; never downloads the binary uninvited), so the first ⌘⇧E is instant. Hidden 15 min → server killed + webview blanked; cold respawn ~0.35s.
- `src/main/ide/`: `code-server-manager.ts` (spawn args, release-asset table, extension seeding, lifecycle: EADDRINUSE retry-once, capped health poll, respawn after crash), `binary.ts` (download to `userData/code-server/<version>/`, PATH fallback for devs), `bridge-server.ts` (ws + token; routes open/selection by workspace folder).
- `resources/sb-bridge/`: zero-dependency extension seeded into code-server's extensions dir. `protocol.js` is pure (message build/parse/validate + reconnect backoff, unit-tested); `extension.js` is thin vscode glue (open-at-line, cmd+l selection capture, cmd+k quick edit, live config apply, the Switchboard Charcoal color theme (app palette), terminal-intent keybindings (ctrl+backtick / cmd+j / cmd+shift+e route to Switchboard's terminal pane; task/debug terminals untouched)). Ships via electron-builder `extraResources`.
- IPC (`IdeChannels`): `ENSURE` (boot + serve folder, TCC pre-flight per call) / `STATUS` (push: stopped | starting | downloading | ready | error) / `OPEN` (pill click → open-at-line in workbench) / `SELECTION` (cmd+l in workbench → chat draft pill) / `STOP` (idle shutdown).
- Security ADR: `--auth none` on `127.0.0.1` - same-user trust boundary as PTYs and the embedded SDK. Design doc: `docs/plans/2026-07-10-embedded-ide-design.md`.
- Surviving file IPC (`FilesChannels`): `list-dir` (lean name/isDir - remote add-project autocomplete), `list-all` (@-mentions, 10k cap), `write-file`/`delete-file` (FileDiffCard accept/reject - atomic temp-then-rename, mtime conflict detection, 8 MB cap), `resolve` (FileChip pill existence). `resolveWithinRepo` rejects `..`-escapes.

### Git tooling + worktrees

- `ipc/git.ts` (`GitChannels`): `list-refs` (locals + remotes, annotated with current/sha/worktreePath), `switch-ref` (validated, rejects `-`/`..`/control chars), `current-branch`, `file-diff` (parses `git diff HEAD` into add/del/mod gutter hunks - `git/diffHunks.ts`), `create-session-worktree`.
- Worktree **creation** lives in two places, not in `worktree.ts`: `worktree-creation/git-adapter.ts` drives the transactional flow behind `KanbanChannels.CREATE_WORKTREE` (kanban card, `<repo>/.switchboard/worktrees/<slug>-<id>`, branch `kanban/<slug>-<id>`) and behind conversation forking (fork-to-worktree, `fork/<name>`); `git/legacy-session-worktree-lease.ts` drives `GitChannels.CREATE_SESSION_WORKTREE` (session worktrees, `$userData/worktrees/<repoSlug>-<hash>/<branchSlug>`, branch `sb/<slug>`). `worktree.ts` itself only lists, finds-stale, and removes worktrees now (`removeWorktree`, `listWorktrees`, `findStaleWorktrees`) - its own creation functions were dead code with no production caller and were deleted.
- **Worktree manager** (Settings > Archive & data > Worktrees, `WorktreeManagerChannels`): rules in `shared/worktree-manager.ts` (`classifyWorktree`, `removalVerdict`), backend in `main/worktree-manager.ts` + `main/worktree-inspect.ts`. Every removal, including the legacy `kanban:remove-stale-worktree`, goes through `removeManagedWorktree`, which re-reads ownership, protection and git state and refuses when the losses exceed what the client acknowledged. Owned worktrees (chat, card, catalog, in-flight creation) are never removed there. Protection is the backend settings row `worktrees.protection` (`{ projects, worktrees }`), honoured by `findStaleWorktrees` too.
- Worktrees live under `.switchboard/worktrees/` deliberately - avoids re-tripping the macOS TCC trap on `~/Desktop`-rooted repos and centralizes cleanup.

### Conversation forking (`conversations/fork.ts`, `shared/conversation-fork.ts`)

- IPC `app:fork-conversation` uses the versioned stable-anchor contract in `shared/conversation-fork.ts`: client request ID, source conversation ID, message ID + role/timestamp/full-message digest, and explicit shared-checkout or source-HEAD worktree policy. The backend owns IDs, canonical prefix resolution, provider artifacts, persistence, and worktree paths; `app:get-conversation-fork` reconciles response-loss retries.
- Claude resumes natively only when the anchor has compatible lineage in the source conversation's committed credential profile. Codex and OpenCode use a durable exactly-once transcript handoff and never write fake resumable artifacts into provider discovery trees.
- Fork conversation, rich messages, settings, handoff state, lineage, managed worktree projection, and operation result commit atomically. `project_path` remains the parent project; `worktree_path` is execution CWD. `thread_sessions` remains provider-session rotation lineage, separate from user-created fork lineage.

### Kanban board (⌘⇧K top-level view)

- Top-level view (not a right-pane mode) swapping the chat area for a workspace-scoped board; sidebar stays mounted. `layout-store.appView: 'chats' | 'kanban'`.
- `kanban_cards` table: `(id, project_path, title, description, tags JSON, status, cost_cap_usd, cost_used_usd, runtime_mode, conversation_id, worktree_path, worktree_branch, created_at, updated_at, completed_at)`. Statuses: `backlog | in_progress | needs_input | done`.
- IPC (`KanbanChannels`): `list / create / update / delete / create-worktree / remove-worktree / list-worktrees / list-stale-worktrees / remove-stale-worktree`. Moving a card to `done` auto-archives its linked conversation (`applyKanbanArchiveSideEffect`); moving back unarchives.
- `card-launch.ts` `launchCardChat`: reuses the linked conversation if live, else spins up a new session rooted at `worktree_path ?? project_path`, links card→conversation, seeds + auto-sends the first turn (title + description). `WorktreeManagerModal` is the Settings worktree manager (`settings/WorktreesPanel.tsx`) scoped to the card's project - one list, one removal path.

### Lexical chat input (pill chips + @-mentions)

- `RichChatTextarea.tsx` - Lexical `PlainTextPlugin` editor that serializes to a plain string with `[[pill:id]]` tokens (draft store stays string-shaped). Replaced the plain `<textarea>`.
- **Pill chips** (`PillNode` decorator + shared `PillChipVisual`): three kinds - `file` (blue), `terminal` (amber), `chat-message` (purple). Inserted by ⌘L context bridge; `×` removes (fires `sb-pill-remove` to prune metadata). Round-trip through `[[pill:id]]` on paste/reload. `renderPillBody` rebuilds chips in sent bubbles.
- **@-mentions**: `@` at a word boundary opens `AtMentionMenu`; `detectAtTrigger` + `filterAtMatches` rank with `services/fuzzy-score`; Enter inserts a file ref.
- `rotation-marker.ts` - when the user swaps provider instance mid-chat, a `[[sb:instance-rotated]] <from> → <to>` system marker renders as a compact pill.
- `BranchPicker` (`main ▾` chip) switches the session's git ref via `git:switch-ref` (policy in `branch-picker-policy.ts`: current first, then locals, then remotes; substring filter).

### Project favicons (`sb-favicon://` protocol)

- `favicon-resolver.ts` probes static icon paths (root → public/ → app/ → src/ → assets/ → .idea/, each `.svg`/`.ico`/`.png`), cached by `(projectPath, parent mtime)`. Fallback `favicon-html-scan.ts` scans `index.html` / framework root files for `<link rel="icon">` (skips data:/http: hrefs, containment-checked).
- Served via the `sb-favicon://favicon?path=<encoded>` custom protocol (`protocol/sb-favicon.ts`) - path must match a known DB project. `ProjectFavicon.tsx` renders it in the sidebar, falling back to a folder glyph on error.

## What's currently working

- Claude Code SDK integration end-to-end: streaming text, tool calls, context window metrics, interrupt
- Codex app-server integration: basic chat + plan-mode + AskUserQuestion + image support (Phase B done)
- **OpenCode ACP adapter** (2026-04-28, only OpenCode adapter - legacy `opencode run --format json` shell-out retired 2026-05-02): speaks the Agent Client Protocol over a long-lived `opencode acp` child. Dynamic model list, shell-env probing for API keys, settings-DB key injection, placeholder + heartbeat + 3-min timeout (free-tier-aware error message) for cold-boot UX. Skill discovery via `available_commands_update` ACP push events. Helper: `adapters/opencode/env.ts` for shared env-probing.
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
- **`⌘L` multi-source context bridge** (2026-04-29): single keybinding routes by the focused element's `data-context-source` attribute (`terminal | file-viewer | chat-message`). Terminal selection → fenced code block w/ pane label header (50k char cap). File-viewer selection → `@<path>:<start>-<end>` pill + fenced block. Chat-message selection → `> from <agent>: "..."` quoted block. All three append to the active session's draft via `useDraftStore.appendDraft`. Pure formatters (`formatTerminalContext`, `formatFileViewerContext`, `formatChatMessageContext`) are unit-tested.
- **Per-turn duration badge** (2026-04-29): adapters stamp `turnStartedAt` on `sendTurn` and emit `durationMs` on `turn.completed`. MessageBubble renders "Worked for X.Xs" under the assistant message via `fmtDuration` from `src/shared/format.ts`. Wired across all 3 active adapters (claude, codex, opencode-acp).
- **Right-pane "IDE" mode** (⌘⇧E to toggle, 2026-07-10): the right column flips between the terminal strip and the embedded VS Code workbench. `layout-store.rightPaneMode` (persisted under `layout.rightPaneMode`). Both panes stay mounted so toggling preserves xterm/pty and workbench state.
- **Embedded IDE (code-server)** (2026-07-10): full workbench, one server + one webview per app, idle shutdown, cmd+l selection → chat pill, pill click → open-at-line - see Embedded IDE section
- **Inline file pills in agent messages** (2026-04-29): `MessageBubble` post-process walks rendered markdown DOM; inline `<code>` tokens that match `looksLikeRepoPath()` become clickable chips. Path heuristic in `src/shared/file-path-ref.ts` (must contain `/`, must end in `.<ext>` or have `:line[-line]` suffix; rejects URLs and absolute paths to avoid false positives). Click → `layout-store.openInViewer(path, lineRange)` flips the right pane to the IDE and routes an open-at-line through the sb-bridge. Existence verified via `files:resolve` IPC; non-existent paths revert to plain code.
- **`⌘L` context bridge** (legacy alias retained for the terminal flow inside the multi-source dispatch above)
- **`⌘K` quick prompt**: floating prompt bar that sends a one-shot turn to the active session. Pre-fills with the workbench selection (cmd+k inside the IDE, Cursor-style: instruction -> agent edits -> FileDiffCard review) or the current terminal selection
- **Side-by-side dual chat panels** (`⌘|` toggle, `dualChat`/`rightSessionId`/`chatSplitRatio` in layout-store)
- **"Send to other panel"** forward action on messages
- **Status bar** at bottom showing project, agent, status, terminal count
- **System notifications** on `turn.completed` for non-active sessions (`src/renderer/services/notifications.ts`)
- **Export conversation as markdown** (`export-markdown.ts` + Sidebar right-click)
- **`⌘F` in-pane search** for terminals (xterm SearchAddon with decoration overlays - requires `allowProposedApi: true`) and individual chat panes (DOM TreeWalker wraps first match in `<mark.sb-search-mark>`); shared `InPaneSearchBar` component, document-level keydown listeners scoped to focused pane via `[data-terminal-pane]` / `[data-chat-panel]` attrs
- **Feature Tour modal** (`FeatureTourModal.tsx` + `feature-registry.ts` in `src/renderer/components/onboarding/`) - auto-opens on first launch and after `TOUR_VERSION` bumps; replayable from Settings → Tour. MP4 clips streamed via `sb-tour://<id>.mp4` custom protocol (resolves to `videos/dist/`, served via `net.fetch('file://...')` for byte-range support). **Every clip is recorded from the real app** by `videos/capture-tour.mjs`: Playwright drives the built bundle (`npm run build:fast` first) against an isolated seeded fixture with `SB_DEMO_ADAPTER=1`, which swaps every provider for the scripted `adapters/demo-adapter.ts` so agent-driven scenes (plan-mode denial, diff card) are deterministic and need no credentials. Scene ids in that script MUST match `FEATURE_TOUR_STEPS`. Re-record after any visible UI change: `node videos/capture-tour.mjs <id>` (or `all`), then look at the frames before committing. The `ide` scene symlinks this Mac's code-server install into the fixture so it never downloads. The README hero is the same script with `SB_SCREENSHOT=docs/images/hero.png node videos/capture-tour.mjs hero`. Do NOT hand-draw UI replicas again (the HyperFrames scenes were deleted 2026-09-15 after drifting from the app within four months; see `docs/notes/hyperframes-spike.md`).
- **Agent-aware UI labels**: `agentLabel()` / `agentShortLabel()` helpers in `shared/types.ts` so StatusBar / MessageBubble / etc. all reflect Claude Code / Codex / OpenCode correctly
- **Multi-instance provider picker** (shipped): named credentials per agent type (env or oauth_dir), `UnifiedProviderPicker` + Settings → Providers, env overlay + session migration at spawn - see Provider instances section above
- **Kanban board** (⌘⇧K) with worktree-backed cards - see Kanban section
- **Conversation forking** ("Fork from here" / "Fork to worktree") - see Conversation forking section
- **Lexical chat input** with pill chips + `@`-mention file autocomplete - see Lexical chat input section
- **Project favicons** in the sidebar via `sb-favicon://`
- **Bookmarks** (`bookmark-store` + `bookmarks` DB table) - bookmark messages/sessions
- **In-chat diff review** (2026-06-02): after each turn, changed files surface as Cursor-style diff cards in chat with per-hunk accept/reject. Git checkpoint at turn start (`src/main/git/checkpoint.ts` + `checkpoint-tracker.ts`); `file-diff-resolve.ts` applies/reverts hunks; `file.edited` events are provider-agnostic (git is the source of truth). `FileDiffCard.tsx` renders the cards.
- **Cross-session messaging**: `/send-to <session>: <message>`, plus two Claude-only SDK MCP tools (`list_agent_sessions` / `send_agent_message`) that let the model hand a finding to a sibling session itself, behind the ordinary approval gate and two extra guards (hop depth, per-sender budget) - see Cross-session messaging above
- **Queued messages you can act on** (2026-09-24): a held follow-up renders as a dashed Queued bubble with Send now / Cancel on desktop and phone; the composer is two round icon buttons driven by the `chat.followUpDefault` setting (Steer / Queue), and the drift chip can be muted per conversation (`conversations.follow_suggestions`, auto-off past two worked worktrees). See `docs/feature-parity/composer-follow-ups.json`
- **Rate-limit event handling** (2026-06-10): Claude SDK `rate_limit_event` surfaced as a chat status message with window type + reset time; subprocess leak on `stopSession` fixed (6 new tests in `claude-adapter-stop-session.test.ts`)
- Single-instance lock
- Native app menu (`⌘,` for settings, standard Edit/View/Window)
- File-based logger at `~/Library/Application Support/switchboard/logs/`
- Launch-config YAML parser (runtime hydration on launch)
- **Cursor recovery import** (2026-08-24): read-only legacy/current SQLite discovery, exact project matching, explicit idempotent snapshot, durable Cursor provenance, and one-time bounded Claude continuation handoff
- **Credential-aware Desktop signing** (2026-08-24): complete macOS/Windows secrets select forced production signing (plus macOS notarization); absent secrets preserve unsigned packaging; partial sets fail closed
- **Launch-config hot reload + startup orchestration**: `.switchboard/launch-config.yaml` changes reconcile live layouts and per-pane `wait_for` gates commands
- **Provider/profile context preservation**: cross-provider changes inject one bounded handoff; same-provider OAuth rotations migrate and resume validated native transcripts

## What's NOT working yet

- **Production signing credentials** - implementation is ready, but releases remain unsigned until repository secrets contain the actual Apple Developer ID/notarization and Windows Authenticode credentials.
- **Codex / OpenCode native fork resume** - both use the explicit durable transcript-handoff mode until their protocols expose and Switchboard verifies a compatible native resume primitive

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

### Screenshot regression tests (every theme)

`npm run test:e2e:visual` (after `npm run build:fast`) has two phases. The
**screens** phase captures the key screens (chat after a finished turn, a long
list reply in a narrow chat, the running composer, sidebar, kanban, Settings, Settings' Accounts page, command palette, provider picker,
approval card) in Dark, Light and Translucent against the tour's seeded
workspace (`e2e/fixtures/demo-workspace.mjs`) with `SB_DEMO_ADAPTER=1`, and
compares them with `e2e/snapshots/<screen>-<theme>-darwin.png`. The CI job
`Visual regressions (macOS)` runs it on every PR; on failure the actual and
diff PNGs are in the `visual-regressions` artifact (locally:
`e2e/artifacts/visual/`).

- Running e2e on a machine someone is using: `export SB_E2E_BACKGROUND=1` first. On macOS the test app then runs as an accessory app and its windows open with `showInactive()`, so they never take focus; every launcher passes `process.env` through. Leave it unset for the behaviour phase, which reads the real screen.
- A deliberate visual change: `SB_VISUAL_SCOPE=screens SB_UPDATE_SNAPSHOTS=1 npm run test:e2e:visual`, then Read every changed PNG before committing it. Never refresh baselines to make a red run green without looking.
- Everything that varies is pinned: renderer clock (`FROZEN_NOW`, UTC), 1x scale, sRGB, window size, animations and caret, the demo turn's duration (scripted, not wall-clock). Turn timestamps are masked because the main process stamps them. A new source of drift must be pinned the same way, not absorbed by raising the tolerance.
- Translucent is compared as the app's own pixels flattened over a fixed two-colour backdrop, because the real desktop behind the window is never the same twice.
- The **behaviour** phase (native glass transmission, fullscreen fallback) reads the real screen with `screencapture`: it needs Screen Recording permission for the terminal and does not work on the CI runner, so run it locally (`SB_VISUAL_SCOPE=behaviour`) before merging anything that touches translucency.

### E2E temp-dir cleanup (MANDATORY)

The e2e scripts (`e2e/ide.e2e.mjs`, `e2e/ide-workflow.e2e.mjs`, etc.) create ~600MB temp dirs per run via `mkdtempSync` (`sb-ide-e2e-*`, `sb-ide-wf-*`, `sb-ide-proj-*`, `sb-update*`, `sb-ide-probe*`) and do NOT clean up after themselves - this has filled the entire disk before (600+ leaked dirs, ~18GB). You are welcome to run e2e tests, but after every e2e run (pass, fail, or crash) you MUST delete the leftovers:

```sh
rm -rf "$TMPDIR"sb-* /tmp/sb-*
```

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
│   │   └── jsonl-truncate.ts          # Pure fork truncation (assembleClaudeFork, truncate*Jsonl)
│   ├── conversations/fork.ts          # Fork-from-message orchestration (per-provider resume)
│   ├── db/
│   │   ├── database.ts                # getDb + migrate(); re-exports the domain modules below, so import from here
│   │   ├── projects.ts · conversations.ts (+ thread ancestry, archive) · messages.ts · settings.ts (+ session layouts) · kanban.ts · bookmarks.ts
│   │   └── provider-instances.ts       # provider_instances CRUD (safeStorage-encrypted env)
│   ├── files/                         # listing (gitignore-annotated) · writing (atomic+conflict) · gitignore matcher
│   ├── git/                           # diffHunks (gutter) · refs · worktreePaths · checkpoint (diff review) · legacy-session-worktree-lease (session worktree creation)
│   ├── ide/                           # code-server-manager · binary (download) · bridge-server (ws)
│   ├── worktree-creation/             # git-adapter.ts - transactional kanban/fork worktree creation
│   ├── worktree.ts                    # worktree list / find-stale / remove (creation lives elsewhere, see above)
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
│   │       ├── claude-peer-tools.ts   # binds peer-tools.ts into an SDK MCP server (zod schemas)
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
│   │   ├── CommandPalette.tsx (⌘⇧P) · QuickPromptModal.tsx (⌘K) · SearchModal.tsx (⌘⇧F)
│   │   ├── SettingsModal.tsx · settings/ProvidersTab.tsx · settings/ProviderUsagePanel.tsx · SessionPickerModal.tsx
│   │   ├── chat/
│   │   │   ├── ChatPanel.tsx · ChatInput.tsx · MessageList.tsx · MessageBubble.tsx
│   │   │   ├── provider-event-reducer.ts # desktop provider event → agent-store reducer (ChatPanel's listener)
│   │   │   ├── ChatWorkspacePanels.tsx # primary/secondary ChatPanel slots + ChatSplitHandle
│   │   │   ├── useChatSearch.ts (in-pane ⌘F) · SlashHelpOverlay.tsx · chat-session-settings.ts (mode/model/effort writes)
│   │   │   ├── picker-keydown.ts (send-to/@/slash picker keys) · model-variants.tsx (VariantChips, model id helpers)
│   │   │   ├── ApprovalCard · PlanCard · QuestionCard · FileDiffCard · SlashCommandMenu · slash-commands.ts
│   │   │   ├── UnifiedProviderPicker.tsx # agent tabs → instance rail → model search
│   │   │   ├── BranchPicker.tsx + branch-picker-policy.ts · SkillChip · FileChip
│   │   │   ├── AtMentionMenu.tsx + at-mention.ts · render-pill-body.tsx · rotation-marker.ts
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

- **Module-level constant**: `const log = createXxxLogger('scope')` - never inside functions.
- **Scope format**: `'domain:subsystem'` - e.g. `'ipc:files'`, `'store:agent'`, `'ide:pane'`.
- **No silent swallowing**: every `catch` block that doesn't re-throw must `log.warn` or `log.error`. `catch { /* ignore */ }` is a bug.
- **No AI slop patterns**: don't log "successfully did X" on the happy path unless it's a slow/async operation worth tracking. Log state changes, errors, retries, and lifecycle events.

## Writing style

- **No em dashes (U+2014) anywhere** - not in code, comments, UI copy, log messages, commit messages, PR descriptions, or docs. Use a hyphen with surrounding spaces (` - `), a comma, or two sentences instead. This is enforced repo-wide; a stray em dash is a review-blocker. (Arrows and middots are fine.)
