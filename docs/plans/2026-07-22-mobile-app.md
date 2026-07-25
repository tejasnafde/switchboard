# Switchboard Mobile App + SidebarV2 - feasibility & plan

Date: 2026-07-22. Status: **IN PROGRESS on branch `feat/mobile-app`** (user
approved full build 2026-07-25, "beyond MVP in one day", Expo Go dev target).

## Resume state (update as work lands - survives OAuth profile switches)

- [x] Phase 0: WsHost token auth (`SWITCHBOARD_TOKEN`, ?token= query,
      timingSafeEqual, refuses non-loopback bind without token) +
      tests/unit/ws-host-auth.test.ts (5 green)
- [x] Desktop fix: remote unread badges (UnreadBadge.tsx lifted, rendered in
      MachineLayer session rows + group badge on remote project headers) -
      diagnosis in docs/notes/unread-remote-diagnosis.md
- [x] Mobile core: apps/mobile scaffold (Expo 57, @shared alias via metro
      watchFolders + babel module-resolver), SwitchboardClient (lib/api.ts),
      connections store (AsyncStorage persist + client pool), chat store
      (RuntimeEvent -> FeedItem reducer, unread)
- [x] ConnectionsScreen + PairScreen (QR scan via expo-camera)
- [x] ProjectsScreen + ConversationsScreen (unread badges, verified handler
      shapes: GET_PROJECTS -> Project[], GET_CONVERSATIONS -> ConversationRow[]
      newest-first, timestamps ms)
- [x] ThreadScreen + NewSessionScreen (desktop-parity resume/plan/approval
      flows, verified against ChatPanel/App.tsx; startedThreads remount guard)
- [x] Desktop Settings -> Mobile pairing QR tab (`qrcode` dep,
      app:lan-addresses IPC, token generator, copyable server command;
      persists via settings DB)
- [x] apps/mobile npm install + typecheck green
- [x] Full gate: repo typecheck + 1360/1360 tests green
- [ ] Shipping checklist before merge: /deslop done -> /review done (15
      confirmed findings being fixed) -> /deslop again -> gate

## Review deferrals (explicit, per shipping checklist)

- **exit(1) on non-loopback bind without token** (src/server/index.ts):
  can crash-loop under a supervisor if misconfigured. Deliberate - refusing
  to serve unauthenticated beyond loopback is the point; the log line names
  the fix.
- **Resume with unknown session silently cold-starts** (claude adapter
  resolveClaudeResumeId falls back to fresh when no JSONL matches): matches
  existing desktop semantics. Later nicety: surface a "started fresh, no
  prior context on this backend" notice in chat.
- **app:lan-addresses reachable by any token-holding WS client**: leaks the
  server's interface list. Accepted for the v1 trust model (token = trusted
  device); gate to desktop-only if multi-user tokens ever exist.
- **Token check runs post-handshake (accepted-then-close 4001), not
  upgrade-level 401**: deliberate - the client-visible 4001 close code is
  load-bearing (WsTransport treats it as terminal auth failure instead of
  re-dialing forever). Cost: one accepted-then-torn-down socket per bad dial,
  trivial at this scale.
- **Screen fetch-scaffold duplication** (Projects/Conversations loading/retry
  states): cosmetic refactor to a useBackendResource hook, deferred.
- **reversedItems O(n) copy per streamed token** (ThreadScreen): acceptable
  under ~500 feed items; upgrade path is a newest-first store layout if long
  threads jank.
- [ ] LATER: someday-style self-update APK (GitHub Releases + expo-updates),
      Mac-relay tunnel bind 0.0.0.0 option, desktop-app dual-host (phone sees
      Electron sessions), SidebarV2 settled lifecycle (separate track)

Connectivity decision (updated 2026-07-25 after work-policy clarification -
Switchboard/someday are personal projects, the target VMs are WORK VMs):
1. WORK VMs: phone -> Termux ssh -L tunnel -> VM (`ssh -N -L
   8765:127.0.0.1:8765 user@vm` + termux-wake-lock), app pairs with
   ws://127.0.0.1:8765?token=... . Rides already-authorized SSH, no Mac
   needed, no new infra, works from home wifi. Fallback: phone -> Mac
   (LAN/tailnet) -> existing desktop ssh -L tunnel -> VM (Mac must be awake).
2. Personal backends: direct over LAN/Tailscale; a personal-GCP outbound
   cloud relay (VM dials out wss, phone dials out, relay pipes by token) is
   the polished later option - PERSONAL BACKENDS ONLY. Do not route work VM
   traffic through personal GCP; a work-use relay would need work infra +
   approval.
Token auth end-to-end in all paths.

Reference exploration (t3code `pingdotgg/t3code`, and local `someday` / `scout`
self-updating APKs) lives in `/Users/tejas/Desktop/projects/.repo-explore-t3code/`.

---

## TL;DR

- **Mobile app is feasible and cheaper than t3code's**, because the expensive
  part (a headless server serving agents/PTYs/git/fs over a WebSocket, with a
  transport-agnostic contract layer) is *already shipped* in Switchboard
  (`WsHost`, `src/shared/ws-*`, `WsTransport`). The new work is an RN UI, a
  pairing-token auth layer, and self-update.
- **SidebarV2 "settled" lifecycle** is a self-contained desktop frontend + DB
  feature, independent of the mobile work. Do it after mobile (lower priority).
- **Self-update: copy `someday`, not `scout`.** GitHub Releases + `expo-updates`
  OTA + `expo-intent-launcher` install; automated EAS-webhook publish loop.

---

## What Switchboard already has (why this is cheap)

| Mobile app needs | Switchboard already ships |
|---|---|
| Headless backend running agents/PTYs/git/fs | `src/server/index.ts` -> `out/server/index.cjs` (`npm run server`), wraps the same `registerX` handlers under `WsHost` |
| WebSocket wire protocol | `src/shared/ws-protocol.ts` (29 lines: `req/res/snd/evt`, `encodeFrame`/`decodeFrame`) |
| Browser-WebSocket client transport w/ reconnect + outbox | `src/shared/ws-transport.ts` (`WsTransport`, 267 lines) |
| Transport-agnostic contracts, **no electron/react imports** | all of `src/shared/*` (types, provider-events, ws-*, models, format) |
| Multi-backend routing | `TransportRouter` + `routing-table.ts` |

The desktop already talks to a remote backend this exact way (`HybridTransport`
over an `ssh -L` tunnel). The phone is just another `WsTransport` client.

`src/shared` has zero electron/react deps, so an RN app can consume the same
types and `ws-protocol`/`ws-transport` verbatim (shared via workspace path).

## The one real backend gap: auth

`WsHost` (`src/main/backend/ws-host.ts`) processes any connected client's frames
with **no token check**. The server header (`src/server/index.ts:4`) already
*names* an intended `SWITCHBOARD_SECRET` env var and a `HOST` bind override, but
nothing enforces the secret yet. Remote today is protected only by the SSH
tunnel (localhost trust). A phone on LAN needs in-band auth.

---

## Plan

### Phase 0 - Pairing token on the server (small, unblocks everything)

Enforce a shared secret on WS connect. Laziest version that holds:

1. In `src/server/index.ts`, read `SWITCHBOARD_SECRET` (already declared). If
   set, pass to `WsHost`; if unset, log a warning and stay open (preserves
   current localhost/SSH behavior).
2. In `WsHost`, on `wss.on('connection', (socket, req) => ...)`, check a token
   from the upgrade request (`?token=` query, or `Sec-WebSocket-Protocol`
   header) against the secret. Mismatch -> `socket.close(4001)`. No token store,
   no rotation service.
3. Bind `HOST=0.0.0.0` for LAN (already supported via env).
4. Pairing payload = the string `ws://<lan-ip>:<port>?token=<secret>`, rendered
   as a QR in Settings (desktop) for the phone to scan. Reuse the existing
   remote-machines UI surface if convenient.

`// ponytail: one shared secret + QR. Per-device tokens / revocation only if
you ever pair more than a couple trusted devices.`

Tests: one unit test that `WsHost` rejects a bad/absent token and accepts a good
one.

### Phase 1 - RN chat client (`apps/mobile`, in-repo)

Expo **managed** app (no custom native modules for v1 - that's what makes
t3code's mobile "high" difficulty; we skip it). Chat-first.

- Workspace: add `apps/mobile` to the pnpm/npm workspace so it imports
  `@shared/*` directly (same alias the app uses).
- Transport: instantiate `WsTransport` against the paired URL. If RN's global
  `WebSocket` + reconnect/outbox in `ws-transport.ts` needs a shim, isolate it
  in one adapter file. This is the spike to de-risk first if we want proof.
- Screens (React Navigation static stack): (1) Pair/connect, (2) Conversation
  list, (3) Thread view streaming `content` / `tool.started|completed|denied` /
  `plan.proposed` / `question.asked` / `file.edited` events into simple cards,
  plus a composer that calls `provider.sendTurn`.
- **Explicitly out of scope for v1:** terminals (would need a native terminal a
  la t3code's Ghostty bridge), the embedded IDE, Lexical pills, dual-chat.
- State: reuse the event shapes from `src/shared/provider-events.ts`; a thin
  Zustand store mirroring the desktop `agent-store` subset.

### Phase 2 - Self-update (copy `someday`)

- `expo-updates` OTA for JS changes (`runtimeVersion.policy: appVersion`).
- Native changes: `selfUpdate.ts` (~30 lines) polls GitHub Releases `latest` on
  the switchboard repo, semver-compares vs `Application.nativeApplicationVersion`,
  downloads the APK via `expo-file-system`, installs via
  `expo-intent-launcher` `INSTALL_PACKAGE` (needs `REQUEST_INSTALL_PACKAGES`).
- `UpdateBanner.tsx` (~60 lines): bottom banner, tap to install, busy/error.
- Publish loop: GH Action on push touching `apps/mobile/**` -> `eas build` ->
  EAS webhook -> a tiny endpoint cuts a GitHub Release + uploads the APK.
  (No public bucket, no `min_supported` force-update kill-switch - those are the
  `scout` mistakes we're avoiding.)

### Later, independent track - SidebarV2 "settled" lifecycle (desktop)

`settled` = not archived; thread stays live but collapses to a slim row.
Auto-settles when its linked PR merges/closes or after N idle days; any real
activity (pending approval, running session, new user message) un-settles it.
Flat list in fixed creation order; only moves at lifecycle transitions.

- DB: add `settled_at` (+ optional `settled_override` = `'settled'|'active'|null`)
  to `conversations`, parallel to the existing `archived INTEGER`.
- Pure `effectiveSettled(conversation, {now, autoSettleAfterDays, prState})` in
  the renderer (unit-tested; mirror t3code's `threadSettled.ts` logic).
- Sidebar partition render (active cards + collapsed settled tail) + a settings
  toggle, behind a flag until stable.
- Server-authoritative settle state is only needed if the mobile app also shows
  the sidebar. Skip until then; keep it renderer-local.

---

## Difficulty summary

| Item | Effort | Note |
|---|---|---|
| Phase 0 pairing | Low | wiring an already-intended secret |
| Phase 1 chat MVP | Medium | new RN UI; transport reused wholesale |
| Phase 2 self-update | Low-Med | port ~90 lines from `someday` + one CI webhook |
| SidebarV2 settled | Low-Med | isolated DB + renderer feature |

## Open questions to settle before/while building

- iOS too, or Android-only v1? (Self-update APK path is Android-only; iOS needs
  TestFlight/store. `someday`/`scout` are Android-first.)
- Reuse the existing remote-machines pairing UI, or a dedicated mobile-pair
  screen in Settings?
- Does `WsTransport`'s reconnect/outbox work unmodified on RN's WebSocket, or is
  a shim needed? (Answer with the Phase-1 transport spike.)
