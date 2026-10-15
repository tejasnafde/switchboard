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
phone ──wss─> tunnel.cloudproxy.app ──tcp──> VM:8766   (kind 'iap': no inbound
                                       port on the VM, no Mac in the loop)
```

The IAP lane speaks the same frames over a different pipe - see
`src/lib/iap-transport.ts` and "Adding an IAP connection" below.

## Run it (dev, Expo Go)

Expo Go works for everything except Google sign-in and voice input, which need
native modules (see the dev build notes below).

```sh
# 1. On the backend machine (Mac or VM), from the repo root:
SWITCHBOARD_TOKEN=<token> HOST=0.0.0.0 npm run server
#    (or generate the token + QR in desktop Settings -> Mobile)

# 2. Phone side:
cd apps/mobile
npm install
npx expo start          # scan the Metro QR with Expo Go
```

In the app: "+" -> the "WebSocket" tab -> scan the pairing QR from desktop
Settings -> Mobile (or type `ws://host:8765` + token manually).

## Adding an IAP connection

The "+" screen has two tabs: **WebSocket** and **Google IAP**. Pick Google IAP
for a work VM that exposes no inbound port at all - the tunnel runs out to
`tunnel.cloudproxy.app` over 443, so it works on any network with your laptop
closed and no `ssh -L` relay in the middle.

There is no QR for this kind (a pairing QR carries a `ws://` URL, which an IAP
target does not have), so all five fields are typed:

| Field | Example |
|---|---|
| Label | `Dev VM` |
| GCP project | `prj-geoiq-decisioniq-in-prod` |
| Zone | `asia-south1-b` |
| Instance name | `geoiq-ssg-dev-in` |
| Port | `8766` (the server's `TCP_PORT`) |
| Backend token | the VM's `SWITCHBOARD_TOKEN` |

Three prerequisites, each of which fails in its own way if missed:

1. **Google sign-in.** Connections -> "Account" in the header. Without a token
   the store refuses to dial and the row goes red (see the sign-in section
   below).
2. **The VM runs the server with `TCP_PORT` set**, plus `SWITCHBOARD_TOKEN`
   matching the token you typed:

   ```sh
   SWITCHBOARD_TOKEN=<token> TCP_PORT=8766 npm run server
   ```

3. **A firewall rule allowing `35.235.240.0/20` to that port.** That is IAP's
   forwarding range. Without it the tunnel completes its handshake and then
   sends nothing at all, which looks like a hang rather than a refusal.

The connection kind is fixed once saved. Editing a saved backend shows the kind
as text instead of the tab control; to switch kinds, remove the backend and add
it again.

## Google sign-in (needed for IAP connections)

An `iap` connection reaches a work VM through `tunnel.cloudproxy.app`, and the
relay only forwards for a signed-in Google identity. `src/lib/google-auth.ts`
imports a refresh token minted on the desktop, refreshes it against Google's
token endpoint directly (no broker: a broker's session JWT cannot call
googleapis.com) and stores it in the device keychain via `expo-secure-store`.

- Screen: Connections -> "Account" in the header.
- Getting credentials onto the phone: run `node scripts/google-mint-token.mjs`
  from the repo root, consent as the account that reaches your VMs, then SCAN the
  QR it prints in the terminal. Pasting the blob also works but it is ~260
  characters. The QR keeps a live credential off your clipboard and out of any
  messaging app.
- Consent happens on the DESKTOP, not in the app: Google no longer allows custom
  URI scheme redirects on Android, so the phone cannot run its own
  authorization-code flow. It inherits the refresh token and renews access tokens
  itself from then on, so the Mac is needed once rather than per session.
- Scope: `https://www.googleapis.com/auth/cloud-platform` plus `openid email`.
- Client id/secret come from `app.json` -> `extra.googleClientId` /
  `extra.googleClientSecret`. Real values live in Secret Manager secret
  `switchboard-oauth-client` (project `teejayproject`, needs
  `--configuration=personal`) and must never be committed here.
- The blob carries the client id and secret it was minted with, and the app
  refreshes with those. `extra.googleClientId` / `googleClientSecret` are only
  the fallback for a bare pasted refresh token, so they must be the same
  Desktop-type client the desktop mint used: a refresh token renews only against
  the client that issued it.

## Voice input

The composer mic (dictation via `expo-speech-recognition`) needs the dev build
or a store build; in Expo Go the native module is absent, so the mic is hidden and
everything else works.

## Layout

- `src/lib/api.ts` - SwitchboardClient: typed invoke/event wrapper over
  `src/shared/ws-transport` (imported from the repo root via `@shared`)
- `src/lib/ota-update.ts` - expo-updates OTA check on mount and on foreground
- `src/components/UpdateBanner.tsx` - bottom banner for the OTA lane,
  mounted once in `App.tsx` over the navigator
- `src/lib/google-auth.ts` - imported Google credentials, keychain-backed token
  cache with single-flight silent refresh
- `src/lib/voice.ts` - dictation wrapper over expo-speech-recognition; the
  require is guarded so Expo Go (no native module) reports "unavailable"
  instead of crashing, and `src/components/MicButton.tsx` hides itself
- `src/stores/connections.ts` - saved backends (AsyncStorage) + live client pool
- `src/stores/chat.ts` - RuntimeEvent -> feed-item reducer, unread counts
- `src/screens/` - Connections, SignIn, Pair (QR), Projects, Conversations,
  Thread, NewSession

## Releasing

Two separate apps ship through two different stores. This Expo app (`apps/mobile`) ships to iOS only, through the App Store. The native Android app (`apps/android`) ships only through Google Play. See `docs/releasing.md` for the Play steps.

### iOS: pick a lane

Ask one question: **does the native binary change?**

| Change | Lane | How it ships | User experience |
|---|---|---|---|
| JS, TSX, assets, `src/shared` | OTA | `mobile-ota.yml` (push to `main` under `apps/mobile/**`, or run by hand) | Banner on next foreground, tap Restart |
| New native module, new permission, Expo SDK bump, native `app.json` keys | App Store build | EAS `store` profile, then submit (see `docs/plans/2026-10-12-store-publishing.md`) | App Store update |

OTA updates need no version bump. `runtimeVersion` uses the `fingerprint` policy
(`app.json`), which derives the value from the native project, so an OTA only
reaches a binary whose native side matches it.

### Android: Google Play

`mobile-release.yml` is manual. It builds a signed AAB and uploads it to a Play
test track. Nothing in this lane builds or attaches an APK. Details and the
promotion steps are in `docs/releasing.md`.

### EAS profiles

`eas.json` cannot carry comments. The profiles that matter:

- `development`: dev client for device testing. Google sign-in and the mic need it, and Expo Go cannot run them.
- `store`: the App Store build (`autoIncrement` on). Its `submit.store` block holds the App Store Connect settings.

Do not release from the internal profiles (`preview`, `production`).

### One-time setup

1. **EAS account.** Someone with the Expo account runs this once from
   `apps/mobile`:

   ```sh
   npx eas login
   npx eas init                # writes extra.eas.projectId into app.json
   npx eas update:configure    # writes updates.url into app.json
   ```

   Until `eas update:configure` has run, `Updates.isEnabled` is false and the
   OTA lane is inert (the app no-ops and logs nothing noisy). These values are
   account-specific and are deliberately not hardcoded here; a wrong `projectId`
   fails the build with a confusing ownership error. See `extra["//updates"]` in
   `app.json`.

2. **`EXPO_TOKEN` repo secret.** Create an access token at
   <https://expo.dev/settings/access-tokens> and add it under Settings ->
   Secrets and variables -> Actions. The OTA workflow needs it. `GITHUB_TOKEN` is
   automatic and needs no setup.

## Not yet

- Terminals, embedded IDE, image attachments, pill chips
- Mac desktop-app sessions (it runs ElectronIpcHost; run `npm run server` on
  the Mac for a phone-visible session pool)
