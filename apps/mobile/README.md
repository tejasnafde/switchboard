# Switchboard Mobile

React Native (Expo) client for Switchboard backends. Chat with Claude Code /
Codex / OpenCode sessions running on any machine that runs the headless
server - a VM over Tailscale, or your Mac on LAN. No terminals or IDE on
mobile v1; chat, approvals, questions, plans, and diff summaries all work.

## How it connects

The phone speaks the same `ws-protocol` frames the desktop uses, over a plain
WebSocket to `src/server` (WsHost). One saved connection per backend.

```
phone ──ws──> VM:8765            (VM runs tailscale, direct)
phone ──ws──> mac:8765           (Mac on LAN/tailnet, npm run server)
phone ──ws──> mac:<fwd> ──ssh──> VM   (VM without tailscale: Mac relays via
                                       its existing ssh -L tunnel)
```

## Run it (dev, Expo Go)

No native modules - Expo Go works.

```sh
# 1. On the backend machine (Mac or VM), from the repo root:
SWITCHBOARD_TOKEN=<token> HOST=0.0.0.0 npm run server
#    (or generate the token + QR in desktop Settings -> Mobile)

# 2. Phone side:
cd apps/mobile
npm install
npx expo start          # scan the Metro QR with Expo Go
```

In the app: "+" -> scan the pairing QR from desktop Settings -> Mobile (or type
`ws://host:8765` + token manually).

## Google sign-in (needed for IAP connections)

An `iap` connection reaches a work VM through `tunnel.cloudproxy.app`, and the
relay only forwards for a signed-in Google identity. `src/lib/google-auth.ts`
runs a PKCE authorization-code flow against **accounts.google.com directly** (no
broker: a broker's session JWT cannot call googleapis.com) and stores the refresh
token in the device keychain via `expo-secure-store`.

- Screen: Connections -> "Account" in the header.
- Scope: `https://www.googleapis.com/auth/cloud-platform` plus `openid email`.
- Client id/secret come from `app.json` -> `extra.googleClientId` /
  `extra.googleClientSecret`. Real values live in Secret Manager secret
  `switchboard-oauth-client` (project `teejayproject`, needs
  `--configuration=personal`) and must never be committed here.
- The client TYPE matters. The Desktop-type client works for the loopback probe
  in `scripts/iap-probe.mjs` only; on device Google rejects custom-scheme
  redirects, so an Android-type client (package `app.switchboard.mobile` + the
  signing SHA-1) is required.
- Because of that, sign-in needs a development build, not Expo Go: Expo Go's
  redirect is `exp://…`, which Google will not accept. Everything else in the app
  still runs in Expo Go.

## Layout

- `src/lib/api.ts` - SwitchboardClient: typed invoke/event wrapper over
  `src/shared/ws-transport` (imported from the repo root via `@shared`)
- `src/lib/google-auth.ts` - direct Google PKCE sign-in, keychain-backed token
  cache with single-flight silent refresh; `selfCheck()` asserts the
  expiry/refresh decisions offline
- `src/stores/connections.ts` - saved backends (AsyncStorage) + live client pool
- `src/stores/chat.ts` - RuntimeEvent -> feed-item reducer, unread counts
- `src/screens/` - Connections, SignIn, Pair (QR), Projects, Conversations,
  Thread, NewSession

## Not yet

- Self-update APK channel (someday-style GitHub Releases flow) - packaging step
- Terminals, embedded IDE, image attachments, pill chips
- Mac desktop-app sessions (it runs ElectronIpcHost; run `npm run server` on
  the Mac for a phone-visible session pool)
