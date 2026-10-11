# Store publishing and desktop signing plan

Status: planned, not started. The orchestrator work goes first (user, 2026-10-12).
Procedure reference: the `app-store-publish` skill in `tejas-skills`.

## Decisions (user, 2026-10-12)

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

1. **Android PR.** Remove the in-app APK updater (`platform/update/*`, its UI) and `REQUEST_INSTALL_PACKAGES`. Play forbids apps that update themselves outside Play. Change `mobile-release.yml` to build an AAB and upload it to a Play test track with the per-app service account. Check the AAB with `aapt2 dump permissions`.
2. **iOS PR.** In `app.json`: `ITSAppUsesNonExemptEncryption: false` (TLS only, exempt), `supportsTablet: false` (no iPad screenshots or iPad review), on-device speech recognition where the phone supports it (`requiresOnDeviceRecognition` in `apps/mobile/src/lib/voice.ts`). In `eas.json`: a store build profile (`distribution: store`, remote versioning) and a submit profile using `APPLE_ASC_API_KEY`. Check the Android speech path at the same time.
3. **Privacy policy PR (site repo).** Add the Switchboard phone app: camera (pairing QR), microphone and speech (on device where supported, otherwise Apple's or Google's speech service), photo attachments, push tokens and push text through Expo and FCM, and that chats travel only between the phone and the user's own backend. Then redeploy the site (`npx wrangler pages deploy dist --project-name tn07 --branch main`).
4. **Demo mode (mock first).** Sample chats, an approval card and a running turn, reachable from the connection screen without a backend, on both phones. The review notes point to it.
5. **Account Holder guide.** A short checklist for the web UI steps below, so they can be done in one sitting.

## Web UI steps (Account Holder)

- **Play Console:** create the app record; Play App Signing setup; App access (demo mode instructions); Ads (none); Content rating; Target audience (18+); Data safety (cleartext `ws://` to the user's own backend affects "encrypted in transit"); then internal testing, then production and Send for review.
- **Apple:** app record (SKU `switchboard-ios`); App Privacy; an APNs key uploaded to EAS for push; the **Developer ID Application** certificate (Account Holder only) exported as `.p12` for desktop signing.

## API and EAS steps

- Play: listing text, graphics and screenshots, AAB upload, tracks.
- Apple: register the bundle ID and the push capability; `eas build -p ios` (first build interactive), `eas submit`; listing, age rating, price, screenshots, review notes (demo mode steps; why `NSAllowsArbitraryLoads` is set: the app talks to the user's own backend on the local network over `ws://`); attach the build and submit.
- Desktop: store the certificate, its password, the team ID and the notarization API key as GitHub Actions secrets; the next release signs and notarizes (`docs/releasing.md`).

## Updates after approval

Only the first review is slow. Later updates are reviewed in hours to a day or two. iOS JS changes ship over EAS Update without review when they do not change what the app is for. Android builds go to the internal testing track first (no full review) and are promoted when ready; iOS internal testers use TestFlight.
