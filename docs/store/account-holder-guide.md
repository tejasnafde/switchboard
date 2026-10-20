# Account Holder guide: store web steps in one sitting

For the Account Holder of the GlycoCare Play account and the Apple team
`4GHRM59326`. Every step below happens in a web browser. The full plan is in
`docs/plans/2026-10-12-store-publishing.md`; this is only the clicking part.

Allow about 90 minutes. Do the steps in order. Do not paste any password, key
or certificate into a chat or an email. Send those through the secure channel
we agree before you start.

## Before you start

Get these from Tejas:

- The upload key certificate fingerprint, if Play asks for it.
- The store listing text, the graphics and the screenshots (`docs/store/play/`).

## Google Play Console

Use the GlycoCare organization account. Touch only the Switchboard app.

The package is `app.tn07.switchboard` (the same id as the iOS app). Before
the steps below:

- Create the app `Switchboard: Run Your Agents` for package
  `app.tn07.switchboard` if Tejas has not created it yet.
- Invite the per-app publisher service account to the new app with release
  rights, so CI can upload the first AAB to the internal testing track.
- Do not use the older record `4974044929379750357` (package
  `app.switchboard.mobile`, created 2026-10-19). It stays unpublished. Leave
  it as it is.

1. **App access.** Policy > App content > App access. Select "All or some
   functionality is restricted". Add the instructions from "Store review
   notes (demo mode)" in `docs/releasing.md`.
2. **Ads.** App content > Ads. Select "No, my app does not contain ads".
3. **Content rating.** App content > Content rating > Start questionnaire.
   Category: Utility, productivity, communication or other. Answer No to every
   content question. One exception: if it asks whether the app displays
   AI-generated content, answer Yes (details in
   `docs/store/play/data-safety.md`). Submit.
4. **Target audience.** App content > Target audience. Select 18 and over
   only.
5. **Data safety.** App content > Data safety. Use the answers in
   `docs/store/play/data-safety.md`. For "encrypted in transit", select Yes
   only after Tejas confirms that the AAB on the track no longer allows plain
   `ws://` to `10.0.2.2` (the one exception that file describes). If it still
   does, ask him before you answer.
6. **The other three declarations.** App content > Government apps: No.
   Financial features: No. Health: No.
7. **Store listing.** Grow > Store presence > Main store listing. Paste the
   name, the short description ("Watch, steer and approve your desktop coding
   agents from your phone."), the full description, the icon, the feature
   graphic and the screenshots, all from `docs/store/play/listing.md` and the
   files beside it. Category: Tools. Save.
8. **Play App Signing and the first internal release.** Test and release >
   Testing > Internal testing. Open the release that CI uploaded. Accept Play
   App Signing when Play asks (Google holds the app signing key). Click Review
   release, then Start rollout. Google reviews the first internal release
   before testers can install it.

Send back: a screenshot of the Dashboard checklist, and any warning that the
release review page shows.

## Apple (App Store Connect and Developer portal)

Before these steps, the App ID `app.tn07.switchboard` must exist in Certificates, Identifiers & Profiles. The first EAS store build (`sb-tools/eas-ios-build.sh`, run by Tejas) registers it. If it is missing, register it there first: Identifiers > + > App IDs > App, explicit bundle ID `app.tn07.switchboard`, capability Push Notifications.

Use the Account Holder Apple ID. Touch only Switchboard and the keys named
here. Never change the GlycoCare apps or their keys.

1. **Create the app record.** App Store Connect > Apps > + > New App.
   Platform: iOS. Name: `Switchboard: Run Your Agents`. Primary language:
   English (U.S.). Bundle ID: `app.tn07.switchboard`. SKU:
   `switchboard-ios`. User access: Full access. Click Create.
2. **App Privacy.** In the new app, App Privacy > Get Started. Use the answers
   Tejas sends (the same facts as the Play Data safety form). Add the privacy
   policy URL `https://tn07.dev/privacy`. Publish.
3. **Push key.** Developer portal > Certificates, Identifiers & Profiles >
   Keys > +. Name: `Switchboard push (tn07)`. Enable Apple Push Notifications
   service (APNs). Continue, then Register. Download the `.p8` file. It
   downloads only once. Note the Key ID. Send the file and the Key ID through
   the agreed secure channel. Tejas uploads it to EAS with
   `eas credentials -p ios`, or stores it in Secret Manager as
   `SWITCHBOARD_APNS_KEY`.
4. **Developer ID Application certificate (desktop signing).** Only the
   Account Holder can create this. On a Mac: Keychain Access > Certificate
   Assistant > Request a Certificate From a Certificate Authority. Save the
   request to disk. Then Developer portal > Certificates > + > Developer ID
   Application > Continue. Upload the request. Download the certificate and
   double-click it to add it to the login keychain. In Keychain Access, find
   "Developer ID Application: JAYASHREE AYURCULTURE & CONSULTANCY", expand it,
   select the certificate and its private key, right-click > Export 2 items.
   Format: Personal Information Exchange (`.p12`). Set a strong password.

Send back, through the secure channel only:

- The push key `.p8` file and its Key ID.
- The `.p12` file and its password. These become the GitHub secrets
  `MAC_CSC_LINK` and `MAC_CSC_KEY_PASSWORD` (see "Signing modes" in
  `docs/releasing.md`).
- A screenshot of the app record page that shows the SKU and the Apple ID of
  the app.
