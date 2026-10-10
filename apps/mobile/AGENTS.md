# Mobile app (Expo)

Detail for this part of the code. The root `AGENTS.md` holds the rules that apply everywhere (shipping checklist, cross-surface policy, logging, writing style); they apply here too.

## Mobile app (`apps/mobile/`)

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
Android needs FCM credentials on the EAS project: a JSON key for a service
account with `roles/firebasecloudmessaging.admin`, uploaded to EAS under
Android > FCM V1 (never committed). Without it `getExpoPushTokenAsync` throws and
the app never gets a token. The owner's setup notes are in the Firebase section
of `~/Desktop/projects/CLAUDE.local.md`. A new registry is created when a closed window is reopened, so
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
