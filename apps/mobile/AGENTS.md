# Mobile app (Expo)

Detail for this part of the code. The root `AGENTS.md` holds the rules that apply everywhere (shipping checklist, cross-surface policy, logging, writing style); they apply here too.

## Mobile app (`apps/mobile/`)

Expo SDK 57 React Native client for the same backends. Talks to a desktop app
or a headless server through `WsTransport`, or to an IAP-tunnelled VM through
`IapTransport` (NDJSON over the raw TCP stream IAP gives us - `TcpHost` serves
that side). Imports `@shared/*` and nothing else from the repo.

**Update lanes.** Android ships the native app in `apps/android` through
Google Play (`mobile-release.yml`, see `docs/releasing.md`); this Expo app is
the iOS client. `mobile-ota.yml` publishes JS-only changes over expo-updates
with `--platform ios`. There is no in-app binary updater: `UpdateBanner` shows only the OTA restart, and native updates come from the App Store. Native changes - a new module, a permission, an SDK
bump - need a new iOS build. `runtimeVersion` uses the **`fingerprint`**
policy (changed 2026-08-01, was `appVersion`), so the hash covers native deps,
config plugins and the native-affecting parts of app.json. An OTA can therefore
only reach a binary whose native side matches it, with nobody having to
remember anything. `appVersion` pinned to the version *string*, so adding a
native module without bumping `version` shipped a bundle to an APK that lacked
it. `.fingerprintignore` keeps generated (`/android`, `/ios`) and test-only
paths out of the hash. Switching policy re-targets every future update, so
APKs built before the switch need replacing once.

**Historical: Expo Android release builds.** This app no longer ships on
Android, so the notes on verifying an Expo Android release build (cleartext
traffic, `expo prebuild -p android`) no longer apply. Android release
maintainers: follow "Native Android mobile release" in `docs/releasing.md`.
`plugins/withAndroidCleartextTraffic.js` and the iOS `NSAllowsArbitraryLoads`
plus `NSLocalNetworkUsageDescription` keys in app.json remain; iOS needs the
latter for direct LAN connections. Cleartext remains available only where the transport gate permits it.

**Transport security** (`lib/transport-gate.ts`, rules in `src/main/backend/AGENTS.md`): App Store and TestFlight builds (read from the binary with `getIosApplicationReleaseTypeAsync`, never from the bundle, because store and internal builds share the `production` OTA channel) refuse plain `ws://` to a remote host before dialing; an unreadable build type fails closed. The local Expo module `modules/pinned-websocket` autolinks on Apple and uses one ephemeral URLSessionWebSocketTask per socket. A QR `fp` selects `wss://` on the same port, accepts only the leaf certificate's DER SHA-256, and never falls back to system trust or cleartext. A mismatch stops retries and asks to scan the QR again, with the same copy as Android. `lib/pinned-websocket.ts` adapts text and lifecycle events through WsTransport's optional socket factory. It removes listeners on close and filters late events by socket id. The native task matches WsHost's 64 MiB frame limit so image-bearing history can exceed URLSession's 1 MiB default. IAP is unchanged.

**Transport states on the Machines list** (`components/MachineRow.tsx`, `components/OldQrSheet.tsx`, rules and copy in `src/shared/connection-security.ts`): each row's state comes from `connectionSecurity` (IAP, certificate changed, refused, pinned, local, plain, in that order). Refused is `transportRefusal` returning a string, certificate changed is the row detail equal to `CERTIFICATE_CHANGED_MESSAGE`, pinned needs `canPinCertificates`. Refused, certificate-changed and error rows go under "Needs attention". Their Scan buttons open `Pair` with `{ editId, rescan: true }`, which scans into the saved machine and keeps its name. `PairScreen` opens `OldQrSheet` instead of saving an address the build refuses. Native Android copies the strings (`ConnectionSecurity.kt`), checked against `tests/fixtures/connection-security-copy.json`; change the copy in the shared file, regenerate the fixture with `SB_UPDATE_FIXTURES=1`, then update the Kotlin copy. On Android the Machines screen and the Home machine list draw the same `ConnectionRow`, `RefusedHint` and `CertificateChangedSheet` (`ui/connections/ConnectionsScreen.kt`), and both present rows with `requireEncryption = !BuildConfig.DEBUG`; do not give Home its own row. JS only.

**Native pinning rollout.** This needs a new App Store/TestFlight binary. `runtimeVersion.policy: fingerprint` includes `modules/pinned-websocket/ios` via Expo autolinking, so old binaries do not receive this native-changing OTA. `requireOptionalNativeModule` still returns null safely in Expo Go or an older binary: those runtimes keep the previous gate and original URL scheme, including refusing remote ws:// in store builds. Pairing URLs and SecureStore credentials are unchanged; no migration or identity/signing change. Local prebuild succeeds and the socket Swift compiles for arm64 iPhoneOS without signing; a full native app/bridge build still needs CocoaPods and device verification. Native callback tests run without a simulator: from `modules/pinned-websocket`, compile `swiftc ios/PinnedSocket.swift tests/main.swift -o /tmp/sb-pin-test` and run that executable. They cover challenge routing, not a TLS handshake.

**Push** (`src/main/push/`, `src/shared/push-policy.ts`): the BACKEND sends,
because the phone is asleep when it matters. `attachPushNotifier` subscribes to
the provider registry's bus and posts to Expo for approvals, questions, turn
end and errors only. Devices report which thread they have open so they are not
notified about the screen in the user's hand, and registration carries the
client's connection id, echoed back so a tap knows which backend to open.
Historical: while this Expo app also shipped on Android, its push needed FCM
credentials on the EAS project (Android > FCM V1). That lane is retired, and this app's `android.package` and `google-services.json` belong to it. Native Android still swaps its FCM token for an Expo token at exp.host, under package `app.tn07.switchboard` (the iOS bundle id; `app.switchboard.mobile` until 2026-10-21), so EAS needs an FCM V1 key assigned to that id. Its Firebase config is `apps/android/app/google-services.json`. A new registry is created when a closed window is reopened, so
the notifier must be re-attached there.

**Unpair push cleanup:** `connections.removeConnection` removes the saved config,
then awaits `push.unregisterWith` before closing the captured client. It uses the
existing `push:unregister` RPC once, waits at most two seconds, and forgets its
registration even offline. Demo connections never register or unregister.
Registration and pairing callbacks must not change state or save credentials
for a removed or replaced client. Credential writes are serialized per connection,
so unpair deletes keys after any session or legacy-token save already in flight.
Android also waits for unregister completion or the same two-second limit before
removing its fleet connection. Repeated Android removals share the same pending
unregister result, including its timeout.

**Saved projects, Settings, local Done notice** (Android's `BrowseModels.kt`, `SettingsScreen.kt`, `SwitchboardDeepLinkContract.kt`, `BackgroundTurnNotificationCoordinator.kt`): `stores/saved-projects.ts` keeps each machine's last project list (demo filtered, forgotten on unpair) and `ProjectsScreen` shows it with `savedProjectsStatus` until the machine answers. `SettingsScreen` opens from the Machines footer and from `switchboard://settings` (`lib/deep-link.ts` accepts only that path; the app.json scheme is `switchboard`). `lib/completion-notice.ts` posts a local "Done" for a background `turn.completed` only when the backend push does not cover it: iOS cannot replace a local notice with the remote one by id, as Android does. JS only, OTA lane.

**Reviews tab** (`ConnectionTabBar` under `ProjectsScreen` and `ReviewsScreen`, switched with `navigation.replace`, no tab library): the list lives in `stores/reviews.ts` per connection, filters in `prefs.prFilters`, a pending review pill in `prefs.threads[key].reviewPill` until the next send (`QueuedMessage.reviewPill`, `queuedTurnBody`). `PullRequestScreen` + `WorkOnPrSheet` are read-only; a "Work on PR" chat goes through `NewSessionScreen` with `pullRequest` (no first-message launch prompt: `lib/pr-chat.ts` links the PR and sends the first turn with the pill once the chat exists). JS only, so it ships on the OTA lane. Rules: `src/main/pull-requests/AGENTS.md`.

**Demo mode** (`@shared/phone-demo`, `lib/demo.ts`, `components/DemoStrip.tsx`): "Try the demo" on the empty Connections screen starts a runtime-only connection (`DEMO_CONNECTION_ID`, never in `configs`) whose `DemoTransport` answers from `src/shared/phone-demo/fixture/phone-demo.json` and plays its scripts on timers; it holds no socket. Native Android packs the same file as an asset (`build.gradle.kts`) and plays it with `PhoneDemoRpc.kt` (a `RemoteRpc`) inside `PhoneDemoRuntime.kt`, an in-memory runtime that replaces the real one while the demo is open and never touches Room, the outbox or the connection list; change the fixture's conventions in both players. Every screen under a connection is wrapped in `withDemoStrip` (strip + Leave demo; `NewSession` shows "not in the demo"). Nothing from the demo is stored: the chat cache and prefs `partialize` with `withoutDemo`, `saveQueued` skips it, a fork refuses before writing its intent, and `leaveDemo` drops the demo's state from every store. A new per-connection persisted store must filter it too. The push prompt waits for a paired machine (`initPushWhenPaired`), and voice says "Not in the demo" (`useDictation`'s `unavailableNote`). JS only, OTA lane.

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
