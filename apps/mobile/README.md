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

## Android OAuth client (one-time, console only)

There is NO gcloud/API path for this. `gcloud iap oauth-clients create` only
creates web clients locked to IAP usage; Android/iOS/Desktop client types are
Cloud Console only. So this is a manual step by necessity.

EAS account `tejasnafde`, project `switchboard-mobile`
(id `efbb89d9-210f-4584-bf62-8186cd5fb476`).

| Field | Value |
|---|---|
| Client type | Android |
| Package name | `app.switchboard.mobile` |
| SHA-1 (EAS-managed **development** keystore) | `4A:A2:A4:44:8C:80:9C:93:29:11:0D:52:6A:A5:23:F0:E3:EC:F3:46` |

A SHA-1 fingerprint is not a secret - it is extractable from any APK - so it is
recorded here deliberately. The client SECRET is the sensitive one and lives only
in Secret Manager.

Steps in GCP project `teejayproject`: APIs & Services -> Credentials -> Create
credentials -> OAuth client ID -> Android -> paste the package name and SHA-1.
Then put the client id into `app.json` -> `extra.googleClientId` and leave
`googleClientSecret` empty (Android clients have no secret).

Also add `tejas@geoiq.io` under OAuth consent screen -> Test users, or sign-in
fails with `access_denied` while the app is in External + Testing.

**When you later ship a production APK**, its keystore differs from the
development one, so its SHA-1 differs too. Add the production fingerprint to the
SAME OAuth client (Google allows several per client) or sign-in will work in the
dev build and fail in the released APK.

## Google sign-in (needed for IAP connections)

An `iap` connection reaches a work VM through `tunnel.cloudproxy.app`, and the
relay only forwards for a signed-in Google identity. `src/lib/google-auth.ts`
runs a PKCE authorization-code flow against **accounts.google.com directly** (no
broker: a broker's session JWT cannot call googleapis.com) and stores the refresh
token in the device keychain via `expo-secure-store`.

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
- The client TYPE matters. The Desktop-type client works for the loopback probe
  in `scripts/iap-probe.mjs` only; on device Google rejects custom-scheme
  redirects, so an Android-type client (package `app.switchboard.mobile` + the
  signing SHA-1) is required.
- Because of that, sign-in needs a development build, not Expo Go: Expo Go's
  redirect is `exp://…`, which Google will not accept. Everything else in the app
  still runs in Expo Go.

## Voice input

The composer mic (dictation via `expo-speech-recognition`) needs the dev build
or APK; in Expo Go the native module is absent, so the mic is hidden and
everything else works.

## Layout

- `src/lib/api.ts` - SwitchboardClient: typed invoke/event wrapper over
  `src/shared/ws-transport` (imported from the repo root via `@shared`)
- `src/lib/selfUpdate.ts` - APK self-update off GitHub Releases; `selfCheck()`
  asserts the version comparison and release picking offline
- `src/lib/otaUpdate.ts` - expo-updates OTA check on mount and on foreground
- `src/components/UpdateBanner.tsx` - bottom banner for both update lanes,
  mounted once in `App.tsx` over the navigator
- `src/lib/google-auth.ts` - direct Google PKCE sign-in, keychain-backed token
  cache with single-flight silent refresh; `selfCheck()` asserts the
  expiry/refresh decisions offline
- `src/lib/voice.ts` - dictation wrapper over expo-speech-recognition; the
  require is guarded so Expo Go (no native module) reports "unavailable"
  instead of crashing, and `src/components/MicButton.tsx` hides itself
- `src/stores/connections.ts` - saved backends (AsyncStorage) + live client pool
- `src/stores/chat.ts` - RuntimeEvent -> feed-item reducer, unread counts
- `src/screens/` - Connections, SignIn, Pair (QR), Projects, Conversations,
  Thread, NewSession

## Releasing

Two lanes. Pick by asking one question: **does the native binary change?**

| Change | Lane | Workflow | User experience |
|---|---|---|---|
| JS, TSX, assets, `src/shared` | OTA | `mobile-ota.yml` | Banner on next foreground, tap Restart |
| New native module, new Android permission, Expo SDK bump, `app.json` native keys | APK | `mobile-release.yml` | Banner, tap Install, Android install prompt |

Both workflows trigger on push to `main` under `apps/mobile/**` and can be run
by hand from the Actions tab.

### Bumping the version

`expo.version` in `app.json` is the single source of truth. The release tag, the
APK filename, and the OTA `runtimeVersion` all derive from it.

```sh
# apps/mobile/app.json -> expo.version: "0.1.0" becomes "0.2.0"
```

Then push to `main`. `mobile-release.yml` builds `mobile-v0.2.0` and attaches
`switchboard-0.2.0.apk`. It is idempotent: if a release for that tag already
exists it logs a notice and skips before spending any EAS build minutes, so a
re-run on an unchanged version is free. **An APK only goes out when you bump the
version.**

Do NOT bump the version for a JS-only change. `runtimeVersion` is pinned to
`appVersion`, so bumping it parks the OTA lane until the matching APK is
published, and installed phones see nothing in the meantime.

### Tag namespace

Mobile releases are tagged `mobile-v<version>`, not `v<version>`. The Electron
desktop app already owns `v*` (see `.github/workflows/release.yml`, currently at
`v0.7.x`); sharing that namespace would collide on tag names and fire the
desktop release workflow. Because desktop releases far outnumber mobile ones,
`selfUpdate.ts` reads the releases *list* and picks the newest release carrying
an `.apk` rather than calling `/releases/latest`, which would nearly always
return a desktop release with no APK attached.

### EAS build profiles

`eas.json` is schema-validated, so it cannot carry comments. What the profiles mean:

| Profile | Purpose |
|---|---|
| `development` | `developmentClient: true`. **This is the profile that can test Google sign-in.** Sign-in cannot work in Expo Go at all: it needs an Android-type OAuth client bound to the package (`app.switchboard.mobile`) AND the build's signing SHA-1, and Expo Go's redirect is `exp://`, which Google rejects. Install this build, then register its SHA-1 (`eas credentials`) on the Android OAuth client. |
| `preview` | Release-mode build for testing off-CI. Same artifact shape as production, so it also exercises the self-update path. |
| `production` | What `mobile-release.yml` builds and attaches to the GitHub Release. `autoIncrement` is off on purpose: `expo.version` in `app.json` is the single source of truth, and both the tag and the OTA `runtimeVersion` derive from it. Auto-incrementing would desync the tag from the binary. |

All three produce an **APK, never an AAB**: Switchboard self-distributes via GitHub
Releases and updates itself in-app, so there is no Play Store upload needing an AAB.
There are no `submit` profiles for the same reason.

### One-time setup

1. **EAS account.** Someone with the Expo account runs this once from
   `apps/mobile`:

   ```sh
   npx eas login
   npx eas init                # writes extra.eas.projectId into app.json
   npx eas update:configure    # writes updates.url into app.json
   ```

   Until `eas update:configure` has run, `Updates.isEnabled` is false and the
   OTA lane is completely inert (the app no-ops and logs nothing noisy). The APK
   lane works without it. These values are account-specific and are deliberately
   not hardcoded here; a wrong `projectId` fails the build with a confusing
   ownership error. See `extra["//updates"]` in `app.json`.

2. **`EXPO_TOKEN` repo secret.** Create an access token at
   <https://expo.dev/settings/access-tokens> and add it under Settings ->
   Secrets and variables -> Actions. Both workflows need it. `GITHUB_TOKEN` is
   automatic and needs no setup.

3. **Android OAuth client** if you want Google sign-in in the build: register
   the build's signing SHA-1 (`npx eas credentials`) against an Android-type
   OAuth client for package `app.switchboard.mobile`. See the sign-in section
   above.

### The first install is manual

Self-update cannot bootstrap itself. For the very first install, download the
APK from the GitHub Release onto the phone and open it. Android will block it
until you grant "install unknown apps" to whatever opened it (Chrome, Files,
Drive) under Settings -> Apps -> Special app access -> Install unknown apps.

After that, Switchboard updates itself: `REQUEST_INSTALL_PACKAGES` in `app.json`
lets it hand a downloaded APK to the package installer, and the install prompt
comes from Switchboard itself rather than a browser. Sideloaded APKs also do not
auto-update in the background; the user always taps Install.

`eas.json` builds an APK in every profile, never an AAB, because we
self-distribute rather than upload to the Play Store. Use the `development`
profile for a device build that can exercise Google sign-in, which cannot work
in Expo Go at all.

## Not yet

- Terminals, embedded IDE, image attachments, pill chips
- Mac desktop-app sessions (it runs ElectronIpcHost; run `npm run server` on
  the Mac for a phone-visible session pool)
