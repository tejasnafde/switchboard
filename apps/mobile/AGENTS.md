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
latter because the whole transport is `ws://`.

**Push** (`src/main/push/`, `src/shared/push-policy.ts`): the BACKEND sends,
because the phone is asleep when it matters. `attachPushNotifier` subscribes to
the provider registry's bus and posts to Expo for approvals, questions, turn
end and errors only. Devices report which thread they have open so they are not
notified about the screen in the user's hand, and registration carries the
client's connection id, echoed back so a tap knows which backend to open.
Historical: while this Expo app also shipped on Android, its push needed FCM
credentials on the EAS project (Android > FCM V1). That lane is retired. A new registry is created when a closed window is reopened, so
the notifier must be re-attached there.

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
