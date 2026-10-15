# Store publishing and desktop signing plan

Status: planned, not started. The orchestrator work goes first (user, 2026-10-12).
Procedure reference: the `app-store-publish` skill in `tejas-skills`.

## Decisions (made by the user on 2026-10-12)

| Topic | Decision |
|---|---|
| Store name | **Switchboard: Run Your Agents** (28 characters) |
| Apple subtitle | Run coding agents from anywhere |
| Play short description | Watch, steer and approve your desktop coding agents from your phone. |
| Category | Developer Tools (Apple), Tools (Play) |
| Countries and price | All countries, free |
| Audience | 18+, no ads, no advertising ID. Under-13 audiences bring the Families policy and COPPA; a coding-agent tool is for adults. |
| Reviewer access | An in-app demo mode with sample chats. No public demo backend: it would run real agents. |
| GitHub APK channel | Removed. Play is the only Android channel; nobody but the user sideloads today. |
| Play signing | Play-managed app signing key plus our upload key. The user uninstalls the sideloaded APK once and pairs again. |
| Developer name | The stores and the signed desktop app show the team **JAYASHREE AYURCULTURE & CONSULTANCY** (team `4GHRM59326`). Accepted. |
| Privacy policy | Edit the shared page `tejasnafde.github.io/public/privacy/index.html` (served at `tn07.dev/privacy`). |

## What ships

- **Google Play:** the native Kotlin app in `apps/android`, package `app.switchboard.mobile`, from versionName 0.5.17 / versionCode 19. minSdk 24, targetSdk 36.
- **Apple App Store:** the Expo app in `apps/mobile`, bundle ID `app.switchboard.mobile`, from version 0.4.1. JS-only changes keep shipping over EAS Update; native changes need a build and a review.
- **macOS desktop:** the Electron app, signed with a Developer ID Application certificate and notarized. The signing code exists ("Credential-aware Desktop signing"); it needs the secrets.

## Work, in order

1. **Android PR.** Remove the in-app APK updater (`platform/update/*`, its UI) and `REQUEST_INSTALL_PACKAGES`. Play forbids apps that update themselves outside Play. Change `mobile-release.yml` to build an AAB and upload it to a Play test track with the per-app service account. Check the AAB with `aapt2 dump permissions`. Update the Android section of `docs/releasing.md` in the same PR, so nobody follows the retired APK lane.
2. **iOS PR.** In `app.json`: `ITSAppUsesNonExemptEncryption: false` (TLS only, exempt), `supportsTablet: false` (no native iPad support, so no iPad screenshots; Apple can still run the iPhone app on iPad in compatibility mode and may test that), on-device speech recognition where the phone supports it (`requiresOnDeviceRecognition` in `apps/mobile/src/lib/voice.ts`). In `eas.json`: a store build profile (`distribution: store`, remote versioning) and a submit profile using `APPLE_ASC_API_KEY`. Check the Android speech path at the same time.
3. **Privacy policy PR (site repo).** Add the Switchboard phone app: camera (pairing QR), microphone and speech (on device where supported, otherwise Apple's or Google's speech service), photo attachments, push tokens and push text through Expo and FCM, and that chats travel only between the phone and the user's own backend, except notification text: a push carries a short excerpt (an agent's question, an error, an approval's detail) through Expo and FCM. Then redeploy the site (`npx wrangler pages deploy dist --project-name tn07 --branch main`).
4. **Demo mode (mock first).** Sample chats, an approval card and a running turn, reachable from the connection screen without a backend, on both phones. The review notes point to it.
5. **Encrypted transport for the store builds.** Production pairing uses pinned TLS (`wss://`) or the already encrypted IAP tunnel. Store builds refuse remote cleartext; internal/debug builds and loopback retain the compatibility paths documented in the parity manifest. Verify these release rules before submission and describe the released behavior in Data safety.
   Done (2026-10-15): a self-signed certificate per install, served as `wss://` on the same port and pinned through the QR's `fp`; Android pins it and its release build drops cleartext except loopback. iOS pinning is implemented through a local native module and requires a new iOS binary; device verification is still pending. Store builds continue to refuse remote `ws://` without a usable pin (`docs/feature-parity/encrypted-phone-transport.json`). For the Data safety form, Android traffic to the user's backend is now encrypted in transit.
6. **Account Holder guide.** A short checklist for the web UI steps below, so they can be done in one sitting: [`docs/store/account-holder-guide.md`](../store/account-holder-guide.md).

## Web UI steps (Account Holder)

- **Play Console:** create the app record; Play App Signing setup; App access (demo mode instructions); Ads (none); Content rating; Target audience (18+); Data safety (release traffic to remote backends uses pinned `wss://` or the encrypted IAP tunnel; remote cleartext is refused); then internal testing (the FIRST internal release is reviewed before it is available; later internal updates generally are not), then production and Send for review.
- **Apple:** app record (SKU `switchboard-ios`); App Privacy; an APNs key uploaded to EAS for push; the **Developer ID Application** certificate (Account Holder only) exported as `.p12` for desktop signing.

## API and EAS steps

- Play: listing text, graphics and screenshots, AAB upload, tracks.
- Apple: register the bundle ID and the push capability; `eas build -p ios` (first build interactive), `eas submit`; listing, age rating, price, screenshots, review notes (demo mode steps; why `NSAllowsArbitraryLoads` is set: custom trust for the user's pinned self-signed backend certificate and the permitted internal/loopback cleartext paths; store builds still refuse remote unpinned `ws://`. Local-network permission covers direct LAN `wss://` too); attach the build and submit.
- Desktop: store the certificate, its password, the team ID and the notarization API key as GitHub Actions secrets; the next release signs and notarizes (`docs/releasing.md`).

## Updates after approval

Only the first review is slow. Later updates are reviewed in hours to a day or two. iOS JS changes ship over EAS Update without review only when they stay within the functionality Apple reviewed (fixes and small adjustments); a new feature or a change in behaviour goes through App Review as a new build. Android builds go to the internal testing track first (no review after the first internal release) and are promoted when ready; iOS internal testers use TestFlight.
