# Google Play policy answers: Switchboard

Answers for Play Console > Policy > App content, for the native Android app
(`apps/android`, package `app.switchboard.mobile`) as built for release.
Every answer is traced to code below; Kotlin paths are under
`apps/android/app/src/main/java/app/switchboard/mobile/`. The privacy policy at
`https://tn07.dev/privacy` states the same facts. Listing text and graphics are
in [`listing.md`](listing.md).

Checked against `main` on 2026-10-17. Re-check this file when the app adds a
library, a permission or a network destination.

## What leaves the phone, and where it goes

| Destination | What | Code |
|---|---|---|
| The user's own Switchboard backend (their computer, or a cloud machine they run) | Prompts, replies, approvals, photo attachments, the push token | `platform/protocol`, `platform/outbox`, `platform/push` |
| Expo push service (`exp.host`) | The FCM token, the Firebase installation ID, the package name and the Firebase project ID, to get an Expo push token | `domain/push/ExpoPushTokenContract.kt` |
| Google Firebase Cloud Messaging | Its own registration (FCM token) | `platform/push/AndroidFirebaseTokenSource.kt`, `firebase-messaging` |
| Google ML Kit (bundled barcode model) | SDK diagnostics and a per-installation ID, while the QR scanner is open | `ui/pairing/PairingQrScreen.kt`, `com.google.mlkit:barcode-scanning` |
| Google OAuth and IAP (`oauth2.googleapis.com`, `tunnel.cloudproxy.app`) | Only when the user connects a Google account to reach a cloud machine: the refresh token, to mint access tokens | `platform/google/GoogleTokenHttpExchange.kt`, IAP tunnel |
| Android's speech recognizer (a system service) | Audio, when the user taps the microphone. The app gets back text only | `platform/voice/AndroidSpeechRecognizerGateway.kt` |

There is no developer server in this list. Switchboard has no cloud account,
no relay, no analytics, no crash reporting and no ads (verified: no analytics,
Crashlytics or Sentry dependency in `apps/android/app/build.gradle.kts`).

### ML Kit: bundled model, but it still reports to Google

The app uses `com.google.mlkit:barcode-scanning` 17.3.0, the **bundled** model
(the model ships inside the APK). It does not use
`play-services-mlkit-barcode-scanning`, the unbundled variant that downloads
its model through Google Play services. Camera frames are decoded on the device
and are never sent anywhere.

Google's ML Kit data disclosure
(<https://developers.google.com/ml-kit/android-data-disclosure>) says every
ML Kit feature, bundled ones included, sends Google device information, app
information (package name, version), performance metrics, API configuration
and error codes, plus a per-installation identifier "not intended to uniquely
identify a user or physical device", for diagnostics and usage analytics, over
HTTPS, not transferred to third parties. Auto zoom adds more data; the app does
not enable it (`BarcodeScannerOptions` sets only `FORMAT_QR_CODE`). There is no
switch to turn the baseline reporting off, so it is declared below. Play
requires SDK collection to be declared even when the developer never sees it.

## Data safety form

### Overview questions

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** |
| Which of the following methods of account creation does your app support? | **My app does not allow users to create an account.** The optional Google account connection signs in to the user's own Google Cloud project to reach their machines; it creates no account with us. |
| Do you provide a way for users to request that their data is deleted? | **No.** We hold no user data to delete. See "Deletion" below for what the user controls. |

Encryption in transit, why Yes is true for the release build:

- `src/main/res/xml/network_security_config.xml` (release) sets
  `cleartextTrafficPermitted="false"` for every host except `localhost`,
  `127.0.0.1` and `10.0.2.2`, and the app's own rule matches it
  (`domain/connection/TransportSecurity.kt`, `CLEARTEXT_HOSTS`). Loopback
  traffic never leaves the phone.
- **One exception to check before submitting:** `10.0.2.2` is the Android
  emulator's alias for its host computer, but on a physical phone it is an
  ordinary private network address. A user whose desktop has exactly that LAN
  address could pair with it over plain `ws://`. It is an edge case (the
  address must be typed by hand and match exactly), but it makes "all data
  encrypted in transit" not strictly true. Recommended: remove `10.0.2.2`
  from the release config and `CLEARTEXT_HOSTS` (emulators can use
  `adb reverse` to `localhost` instead) before the first production release.
  Answer Yes once the uploaded AAB no longer has the exception; until then,
  the developer decides whether to accept the edge case.
- A paired backend is dialled over `wss://` with its certificate pinned from
  the pairing QR (`platform/protocol/PinnedTls.kt`), or through the Google IAP tunnel (TLS).
  Remote `ws://` is refused. See
  `docs/feature-parity/encrypted-phone-transport.json`.
- Expo, Firebase, ML Kit and Google OAuth are all HTTPS.
- The plain `ws://` path exists only in debug builds (`src/debug`), which are
  never uploaded to Play.

### Data types

"Collected" in Play's sense means sent off the device. Data sent only to the
user's own backend is still collected in that sense, so it is declared, even
though it never reaches us. None of it is **shared** (no transfer to a third
party; Expo and Google act as service providers for push and ML Kit, which
Play does not count as sharing). Nothing is processed ephemerally unless
stated.

| Category | Data type | Collected | Shared | Optional | Purpose | Why |
|---|---|---|---|---|---|---|
| Location | Approximate, Precise | No | No | - | - | No location permission or API. |
| Personal info | Name, Email address, User IDs, Address, Phone number, Race and ethnicity, Political or religious beliefs, Sexual orientation, Other info | No | No | - | - | The Google account email is read on the device from the ID token, shown in Settings and never sent anywhere. |
| Financial info | All types | No | No | - | - | No payments. |
| Health and fitness | All types | No | No | - | - | - |
| Messages | Emails, SMS or MMS | No | No | - | - | - |
| Messages | **Other in-app messages** | **Yes** | No | No (core function) | App functionality | Prompts, follow-ups, answers and approvals go to the user's own backend; replies come back from it. Dictated text joins the prompt as text. |
| Photos and videos | **Photos** | **Yes** | No | Yes (user attaches) | App functionality | A photo the user picks (system picker, `image/*`, no photo permission) is sent to their own backend with the prompt. |
| Photos and videos | Videos | No | No | - | - | The picker accepts images only. |
| Audio | Voice or sound recordings, Music files, Other audio files | No | No | - | - | The app never records or uploads audio. Dictation hands the microphone to Android's system `SpeechRecognizer` (Google's recognizer, on device or Google's server by the phone's settings) and receives text. `RECORD_AUDIO` is declared because that API requires it of the caller. |
| Files and docs | Files and docs | No | No | - | - | The only picker is `OpenMultipleDocuments` limited to `image/*`. |
| Calendar | Calendar events | No | No | - | - | - |
| Contacts | Contacts | No | No | - | - | - |
| App activity | App interactions, In-app search history, Installed apps, Other user-generated content, Other actions | No | No | - | - | Chat content is declared under Messages. Search runs on the device. |
| Web browsing | Web browsing history | No | No | - | - | - |
| App info and performance | Crash logs | No | No | - | - | No crash reporter. |
| App info and performance | **Diagnostics** | **Yes** | No | Yes (only while the QR scanner is open; manual address entry avoids it) | Analytics | ML Kit SDK baseline diagnostics and performance metrics, sent to Google. |
| App info and performance | Other app performance data | No | No | - | - | ML Kit's performance metrics are declared as Diagnostics. |
| Device or other IDs | **Device or other IDs** | **Yes** | No | No | App functionality, Analytics | (1) The Firebase installation ID and FCM token, sent to Expo's push service and then to the user's own backend, so the backend can push approvals and questions. (2) ML Kit's per-installation ID (Analytics), while the scanner is open. |

If Play asks whether the "Device or other IDs" collection is optional: push
registration runs for every paired phone, so answer **required**.

### Push notification content

A push carries a short excerpt (an approval's detail, "Asked: ...", "Error:
...") plus the chat title and project path in its data field. That text is
sent by the user's own backend through Expo and FCM to the phone. It is data
the app **receives**, not data the app collects or sends, so it is not a row in
the form. The privacy policy names it.

### Deletion

There is no developer-held data, so there is no deletion request flow and the
form answer is No. What the user controls:

- **Uninstall** removes everything the app stores on the phone (Room database,
  cached chats, drafts, outbox, the paired backend list and its pins, the
  Google refresh token).
- **Remove machine** on the phone's Connections screen, or revoking the device
  in the desktop app's Settings > Mobile pairing, ends the pairing. Chats live on the user's own computer, and the
  user deletes them there.
- The backend removes a dead push token only after a send to it fails
  (`dropDeadTokens` in `src/main/push/registry.ts`). After an uninstall the
  token stays registered on the backend until the next send attempt.
  Removing a machine on the phone does not currently unregister the token.

## Content rating (IARC questionnaire)

- Email for the rating certificate: `review@tn07.dev`.
- Category: **All Other App Types** (shown as "Utility, Productivity,
  Communication, or Other").
- Answer **No** to every content question: violence, fear, sexuality,
  nudity, crude humour, language, controlled substances (drugs, alcohol,
  tobacco), gambling or simulated gambling, and discrimination.
- Does the app let users interact or exchange content with other users?
  **No.** The phone talks only to the user's own computer and their own
  agents. There is no chat between people.
- Does the app share the user's current location with other users? **No.**
- Does the app allow users to purchase digital goods? **No.**
- Is the app a web browser or search engine? **No.**
- Is the app primarily a news or educational product? **No.**
- If the questionnaire asks about generative AI content: the app shows text
  that the user's own coding agents produce on the user's own computer. The
  app has no model and generates nothing itself. If the question is "does the
  app display AI-generated content", answer **Yes** with that explanation; it
  is code and technical text, not images or people.

Expected result: Everyone / PEGI 3 / USK 0 or similar. The 18+ choice lives in
Target audience, not here.

## Other App content sections

| Section | Answer |
|---|---|
| Privacy policy | `https://tn07.dev/privacy` |
| Ads | **No, my app does not contain ads.** |
| Advertising ID | **No.** The app does not use the advertising ID. Check that the release AAB has no `com.google.android.gms.permission.AD_ID` (`aapt2 dump permissions`); `firebase-messaging` does not add it. |
| Target audience and content | **18 and over** only. Not designed for children. |
| News app | No |
| Government app | No |
| Financial features | My app does not provide any financial features |
| Health | My app does not have any health features |

## App access

Select **All or some functionality is restricted**, add one set of
instructions, and paste this (from `docs/releasing.md`, "Store review notes
(demo mode)"):

```text
No account needed. On first launch, tap Try the demo. Open the chat marked Approval needed and tap Approve. Open the Reviews tab. Real use needs the user's own desktop backend.
```

Username and password: leave empty (no login). If a field for extra notes is
offered:

```text
The demo plays bundled sample data offline: no account, no network, nothing stored. It hides the notification, microphone and camera prompts, because those need a paired desktop backend that we cannot provide publicly (it would run real coding agents).
```
