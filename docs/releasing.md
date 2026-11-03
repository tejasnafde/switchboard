# Releasing Switchboard

This is the operator's guide for cutting a release. The user-facing
install instructions live in `README.md`.

## Native Android mobile release

Google Play is the main channel for the native Android app
(`apps/android`, package `app.tn07.switchboard`, the same id as the iOS
bundle). The in-app APK updater is retired: Play forbids apps that update
themselves outside Play. The app requests no `REQUEST_INSTALL_PACKAGES`, and at
each start it deletes what the updater stored (state and staged APKs).

A sideload APK is still available on request, without any in-app update path.
Dispatch `mobile-release.yml` with `apk` on (and `play` off to skip the Play
upload). bundletool builds a universal APK from the verified AAB and signs it
with the upload key. The verifier checks it, and the `publish-apk` job
publishes it as the GitHub release `mobile-v<version>`, never marked latest,
so desktop auto-update is not affected. The job refuses a version that already
has a release. `https://switchboard.tn07.dev/apk` (Worker `switchboard-apk` in
`tn07-site`) redirects to the newest release that has an `.apk` asset, so it
needs no change.

Prerequisites, done once by hand before the workflow can upload (both done
on 2026-10-21):

1. Create the app record for `app.tn07.switchboard` in the Play Console. The
   Publishing API cannot create an app. The record is `4972923558077941387`.
   Until 0.5.20 the package was `app.switchboard.mobile` (record
   `4974044929379750357`, created 2026-10-19, internal track only, never
   published). It moved on 2026-10-21 to match iOS; that record stays
   unpublished and gets no more uploads.
2. Invite the per-app publisher service account to the `app.tn07.switchboard`
   record with release rights for this app only. The invite on the old record
   does not carry over. Its key is `PLAY_SERVICE_ACCOUNT_JSON` below.

Once the record exists, the workflow uploads every AAB, the first one
included. No Console upload comes first, whatever older Play docs say: the
old record was empty too when the first 0.5.18 bundle went to its internal
track as a draft through the API on 2026-10-19. Play App Signing is then on
with a Google-generated app signing key; the workflow's key is the upload
key. Check the current track before dispatching; local source cannot establish
which builds a store has accepted.

To release, run **Android release dispatch** (`android-release.yml`) on main,
enter the human-chosen versionName and leave `dry_run=true` first. It pins main,
reads all current bundles, APKs and tracks from Play, and chooses one above both
Play's maximum and the repository's versionCode. The temporary inventory edit
is deleted. Inventory reads, uploads and promotions share the `mobile-release`
concurrency group while they own an edit; do not run a separate local or Console
edit at the same time, because Play invalidates an existing edit for that user.
Dry runs build and verify signed AAB and universal APK artifacts,
without changing main, creating tags, uploading to Play or publishing a release.

With `dry_run=false`, the workflow opens a version-only PR with the Gradle bump,
CHANGELOG entry and feature-parity manifest, waits for CI and a current-head CodeRabbit review, refuses
unresolved review threads or requested changes, merges it, and passes that merge SHA to the existing
`mobile-release.yml`. That lane uploads to internal and publishes the verified
sideload APK. The automation needs a **RELEASE_PR_TOKEN** repository secret with
contents and pull-request write and Actions read permissions. This secret is
not currently configured; the user must add it before an actual release. A bot
PAT is needed because PRs and pushes made with the default GITHUB_TOKEN do not
start CI. It needs access only to this repository. The workflow never bypasses
branch protection. A failed bump is left for inspection, and no upload follows.

Allocation does not reserve a code in Play. A separate upload during the bump
PR can consume it; Play then rejects the collision. Inspect and close stale
bump PRs before retrying with a fresh version. The workflow does not choose a
different code automatically after an upload fails. A collided bump that already
merged stays on main; recovery needs another bump above both inventories.

GitHub keeps only one pending run per concurrency group, even with
`cancel-in-progress: false`. A later manual dispatch can replace packaging
that is waiting after its bump merged. Inspect Play and the GitHub APK release
before recovery: if neither upload happened, dispatch `mobile-release.yml`
on main with `ref` set to that exact merge commit, `dry_run=false`, `play=true`
and `apk=true`, plus its expected `version_name` and `version_code`.
Recovery accepts only an immutable SHA on main and verifies that version pair.
If Play already accepted the AAB, use `play=false` for APK-only recovery.
Never retry an upload whose outcome is unknown until Play's state is checked.

After testing that exact versionCode on internal, dispatch
**Promote tested Android build** (`android-promote.yml`). Its `dry_run` defaults
to true: it reads internal and production, reports the selected build and
reuses the internal notes, without a track update or edit commit. Production
promotion requires main, `dry_run=false` and the explicit `tested` checkbox.
It accepts only a completed internal build above production's versionCodes and
performs a full rollout. Store review remains governed by Play.

`mobile-release.yml` remains available for manual packaging. Its new
`dry_run=true` default disables both Play and GitHub publishing; set it false
deliberately for a real upload. A dry-run `version_name` allocates above Play
inventory so the branch can exercise the complete signed build without a bump
PR. New dispatch workflows can be validated on main after merge; they do not
run on pull requests.

The job runs the Android unit, lint and androidTest compile gate, builds a
signed AAB (`bundleRelease`), and checks it with
`scripts/verify-android-apk.mjs --aab` (pinned bundletool and `keytool`). It
refuses the AAB unless the package is `app.tn07.switchboard`, the versionName
matches Gradle, the versions are above the native floor, the sole signer has
SHA-256 fingerprint
`BC:81:1E:37:12:C2:D5:7F:2B:6E:BD:A5:43:92:E6:2E:BD:2A:77:34:53:E5:0F:B3:75:E1:10:2D:B9:01:A8:F6`,
and the manifest does not request `REQUEST_INSTALL_PACKAGES`. The log lists
every permission of the AAB. The AAB is kept as a workflow artifact for 90
days, then uploaded to Play. Play refuses a `versionCode` it has already seen,
so it enforces monotonic versions.

For crash reports, the release build type sets `ndk.debugSymbolLevel =
"SYMBOL_TABLE"`, so Gradle writes the symbol table of each bundled native
library into the AAB's `BUNDLE-METADATA`, where Play reads them. Writing them
needs the NDK, which the runner image does not have: both Android workflows
install the version that `android.ndkVersion` pins with `sdkmanager`. Today
every bundled library (ML Kit, CameraX, AndroidX) ships already stripped, so
there is nothing to extract and Play's native symbols warning stays. The job
fails when a library in the AAB has a `.symtab` but no matching `.sym` file.
R8 is off (`isMinifyEnabled = false`), so there is no
`mapping.txt` and Play's deobfuscation warning stays: it is informational
while the code is not obfuscated. Once R8 is turned on, the job uploads
`mapping.txt` with the AAB.

The release build allows plain `ws://` only to loopback (`localhost`,
`127.0.0.1`, `::1`), in `res/xml/network_security_config.xml` and in
`CleartextPolicy`. Every other host, the emulator's `10.0.2.2` included, needs
the pinned `wss://` path or the IAP tunnel, so the Play Data safety form can
answer "data is encrypted in transit". To reach a desktop from an emulator,
use the debug build, which allows any host.

Signing uses Play App Signing. Play holds the app signing key; the key above is
the upload key, so register it as the upload key when Play App Signing is set
up. If a different upload key is ever used, change `CANONICAL_SIGNER_SHA256`
in the verifier in the same PR. Because Play re-signs with its own key, a
sideloaded APK cannot upgrade to the Play build: uninstall it once, install
from Play, and pair again.

Repository secrets (the job fails with a named error when one is missing):

- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD`: the upload keystore.
- `PLAY_SERVICE_ACCOUNT_JSON`: the JSON key of a per-app service account,
  invited in the Play Console with release rights for `app.tn07.switchboard`
  only. The service account invited for the old record has no rights on the
  new one until it is invited there too.

React Native remains the iOS client. `mobile-ota.yml` publishes EAS updates
with `--platform ios` only.

## iOS App Store build

The Expo app in `apps/mobile` ships to the App Store through the `store`
profiles in `eas.json`. JS-only changes keep shipping over `mobile-ota.yml`;
anything in the native project (a module, a permission, an Info.plist key in
`app.json`) needs a new store build and a review.

- **Build:** `eas build -p ios --profile store` (`distribution: store`,
  channel `production`, so OTA updates reach it). Build numbers are remote
  (`cli.appVersionSource: remote`) and `autoIncrement` bumps one per build;
  the marketing version is still `expo.version` in `app.json`.
- **Submit:** use the dispatch below. A local `eas submit -p ios --profile store`
  needs the submit profile's `ascApiKeyPath`, `ascApiKeyId` and
  `ascApiKeyIssuerId` bound to actual values first. Shell variables in `eas.json`
  are not expanded. The local key comes from Secret Manager `APPLE_ASC_API_KEY`
  in `teejayproject` (JSON `{key_id, issuer_id, team_id, p8}`); the workflow uses
  the existing GitHub Apple API secrets listed below.
- `ITSAppUsesNonExemptEncryption` is `false` (system TLS only), so no build
  asks the export compliance question. `supportsTablet` is `false`: iPads run
  the iPhone app in compatibility mode and need no iPad screenshots.

### TestFlight dispatch

Run **iOS TestFlight dispatch** (`ios-testflight.yml`) on main with a full main
SHA whose main push CI passed. The workflow verifies ancestry and CI, checks
App Store Connect access read-only, and builds with the existing EAS `store`
profile and frozen credentials. No certificate or provisioning profile is
created or rotated. EAS CLI is pinned. Main's native fingerprint report helps
operators decide when this binary lane is needed.

`dry_run=true` is the default: it builds a signed store IPA but never submits
it. It consumes EAS build quota and a remote build number. Inspect the EAS build
ID in the run summary. New workflow registration requires main, so the first
validation dispatch can run after merge. A branch dry run identifies both the
workflow revision and the selected main source; repeat on main before submission.

With `dry_run=false`, the workflow must be dispatched on main. It submits only
that successful build's ID to TestFlight after checking its commit, iOS/store
profile, project and bundle identity. App Store review remains a separate
manual action. Do not rerun a build or submission with an unknown outcome until
its EAS dashboard state is checked; the workflow does not retry either command.
GitHub may replace a pending dispatch in the concurrency group.

Secrets: existing `EXPO_TOKEN`, `APPLE_API_KEY_P8`, `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER` and `APPLE_TEAM_ID`. No new secret is required. The private
`.p8` file lives outside the source archive and is deleted on exit. The script
binds the submit profile's environment placeholders only around the read-only
status check and submission and
restores the file afterwards, so build archives and fingerprints remain those
of the chosen commit. EAS Submit does not expand shell variables in `eas.json`.
The same binding is validated in a dry run, without invoking submit.

### PR native compatibility report

The **iOS native fingerprint** workflow compares a PR's merge result with its
exact base using Expo's fingerprint tooling and each revision's own lockfile
installation. Open the **iOS compatibility (advisory)** check summary for
“OTA-compatible with this base” or “new iOS binary required” and the changed
native input names. The check is informational and needs no secrets. A failed
report draws no compatibility conclusion. A base comparison does not prove
compatibility with a shipped binary; Expo's existing runtime matching remains
the delivery gate. No last-shipped fingerprint is recorded yet.

### Store review notes (demo mode)

Reviewers have no Switchboard backend, so both phones ship an offline demo:
"Try the demo" on the empty Connections screen plays bundled sample data
(`src/shared/phone-demo/`) with no account, no network and nothing stored.
Paste this into App Store Connect (App Review Information > Notes) and into
Play Console (App content > App access, "All or some functionality is
restricted", with these instructions):

> No account needed. On first launch, tap Try the demo. Open the chat marked
> Approval needed and tap Approve. Open the Reviews tab. Real use needs the
> user's own desktop backend.

The demo hides the push, microphone and camera prompts, so a reviewer who
wants to see them needs a paired backend; say so if a review asks.

The Play listing text, the policy form answers (Data safety, Content rating,
App access) and the graphics are in `docs/store/play/` (`listing.md` says how
to regenerate the images).

## Desktop release

A desktop release is a tag on `main`. There is no version-bump pull request:
`release-build.yml` sets `package.json` to the tag's version on the runner
before it builds, so the artifacts, the update manifests and `app.getVersion()`
all carry the tag's version while `main` keeps whatever it had.

Run **Release** in GitHub Actions (`release.yml`), choose the workflow ref
`main`, enter the version as `X.Y.Z` without `v`, and leave `dry_run` enabled
first. The dry run packages both platforms with that version, but creates no
tag, draft release, assets or update feed.

```sh
gh workflow run release.yml --ref main -f version=0.9.128 -F dry_run=true
```

After reviewing that run, dispatch again on `main` with `dry_run=false` and
`expected_sha` set to the SHA in its summary. A changed main requires a new dry run.
The operator supplies the reviewed SHA; the workflow validates that it matches current main, but does not attest that a human reviewed a dry run.
The workflow resolves main once to an immutable SHA, requires successful
push CI on that SHA, and refuses an existing `v<version>` tag or a version no newer than the latest desktop release. If CI is still
running it fails closed; retry after CI passes. It never follows a newer merge
partway through a release. Tag creation is atomic, and all desktop release runs are
serialized without cancelling an active release. GitHub can replace a pending run when another is queued; check the run conclusion. No version-bump PR is needed.

A branch dry run reports both the workflow revision and the packaged main SHA.
Repeat it on main after merge before using that SHA for a real release.

The default GitHub token creates the tag and the same run directly invokes
the existing release jobs. It does not depend on a token-created tag triggering
another workflow. For a failure after tag creation, re-run only the failed jobs: the tag must
still point at the validated SHA. A fresh dispatch refuses that tag.
Direct tag pushes remain supported for recovery; cancel an accidental run
before deleting its draft release, then deleting or replacing its tag. Never
reuse a draft containing assets from another commit. Direct tag pushes
use the existing CI fallback gate; use the dispatch for normal releases.

Secrets: only the automatic `GITHUB_TOKEN` is needed for unsigned desktop
builds. The optional signing secrets listed below keep their existing behavior.

Write the CHANGELOG entry on the FEATURE branch, with the change itself.

Everything the operator used to verify by hand is a job in `release.yml`, so a
green run means it was checked:

| Job | Enforces |
|---|---|
| `ci_status` | Resolves and pins main for dispatch, rejects an existing tag, and requires successful main push CI. Tag pushes look up CI on the tagged commit. |
| `gate` | Calls `ci.yml` only when `ci_status` found none (a tag on a commit whose CI never ran or failed). Main CI already passed on a normal release commit, and running it again proves nothing. |
| `prepare_release` | A real dispatch creates the tag on the verified SHA, then creates one hidden draft for both builds to upload into. Dry runs create neither. |
| `build_mac`, `build_win` | `release-build.yml` once per OS, in parallel. Each sets the chosen dispatch or tag version, runs `build:ci` (build plus the packaged-app smoke test; typecheck and tests already passed on this commit) and publishes into the draft only for a real release. Dry runs retain Actions artifacts. |
| `publish` | As soon as the macOS build ends: asserts the macOS assets and `latest-mac.yml` (`scripts/verify-release-assets.sh mac`), then publishes the release. It does not wait for Windows. |
| `verify_windows` | When the slower Windows build ends: asserts its assets and `latest.yml` on the already published release. Until `latest.yml` lands, Windows clients see no update yet. |

The only judgment left to a human is the version: **a patch bump for iterative
work including feature batches**; reserve a minor bump for headline surface
changes (0.7.0 = the embedded IDE replaced the editor).

If `prepare_release`, `publish` or `verify_windows` fails, re-run the failed job from the
Actions UI. It is safe: electron-builder dedups uploads by name.

### Pull request sizing

CodeRabbit gives this repository one review per hour, and every pull request it
sees, a release one included, spends that slot. So:

- **Batch small related fixes** into one pull request (one review, one release).
- **Keep each large feature in its own pull request**, so a finding on one does
  not hold the others.
- Self-review against the review checklist and run
  `coderabbit review --agent --committed --base origin/main` locally before
  pushing. The local CLI has its own limit (3 reviews per window on the free
  plan), separate from the hosted one.

**When a pull request may merge without waiting for the hosted review:** a small
or medium change merges once the local CodeRabbit review is clean (every finding
fixed or declined in the PR body with a reason), the full gate passed and CI is
green. The hosted review still runs afterwards; a real finding gets a follow-up
pull request. A change that can lose data, changes the wire protocol, or changes
stored data or a migration also waits for a clean hosted review. An explicit
task requirement to wait for hosted review also applies. Every batch, including
docs, follows the root shipping checklist;
high-risk changes also require the installed-build check and explicit approval.

### Signing modes

Release CI selects signing independently for each platform. With no signing
secrets, it deliberately produces the existing unsigned artifacts. With every
secret for a platform, it uses `electron-builder.signed.yml`, refuses unsigned
fallbacks, and verifies the resulting signature before packaging finishes.
Providing only part of a credential set fails the job before electron-builder
runs; secret values are never printed.

macOS signed releases require these repository secrets:

- `MAC_CSC_LINK`: base64 of the Developer ID Application `.p12`
- `MAC_CSC_KEY_PASSWORD`: the `.p12` password
- `APPLE_TEAM_ID`: the team that owns the certificate
- `APPLE_API_KEY_P8`: the text of the App Store Connect API key (`.p8`)
- `APPLE_API_KEY_ID`: that key's id
- `APPLE_API_ISSUER`: the issuer id of the App Store Connect team

Notarization uses the App Store Connect API key, not an Apple ID with an
app-specific password. `release-build.yml` writes `APPLE_API_KEY_P8` to a
mode-600 file under `$RUNNER_TEMP` and passes only its path to
electron-builder as `APPLE_API_KEY`, then deletes the file when the job ends.
The key needs the Developer role (or higher) in App Store Connect to submit to
the notary service. Do not set `APPLE_ID` or `APPLE_APP_SPECIFIC_PASSWORD`:
electron-builder prefers them over the API key when both are present.

Windows signed releases require:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

The macOS lane enables hardened runtime and Developer ID signing. Then
`build/afterSign.js` submits the app with `xcrun notarytool submit --wait`
(it fails unless Apple returns Accepted) and staples the ticket with
`xcrun stapler staple -v`, up to five attempts 30, 60, 90 and 120 seconds
apart. electron-builder's own notarize step is off in the signed overlay
because it staples once: on 2026-11-03 the ticket lookup at
`api.apple-cloudkit.com` dropped the connection on the runner (stapler exit 68)
twice in a row after Apple had accepted the submission. Then the hook checks:

- `codesign --verify --deep --strict` with the extra requirement
  `identifier "com.tejasnafde.switchboard"` (see "From ad-hoc to Developer ID"
  below),
- `spctl --assess --type exec` (Gatekeeper accepts the app),
- `xcrun stapler validate` (the notarization ticket is stapled).

The Windows lane enables Authenticode and validates the packed executable.

A dry-run dispatch of `release.yml` (see "Desktop release" above) exercises
the same selection, signing, notarization and verification on the main tree
without publishing. It keeps the packages as the run artifact
`desktop-dry-run-macos-15` (kept 7 days), so you can check the app locally:

```bash
gh run download <run-id> -R tejasnafde/switchboard -n desktop-dry-run-macos-15 -D /tmp/sb-devid
ditto -x -k /tmp/sb-devid/Switchboard-*-mac.zip /tmp/sb-devid/app
codesign -dv --verbose=4 /tmp/sb-devid/app/Switchboard.app
spctl -a -vv /tmp/sb-devid/app/Switchboard.app
```

### From ad-hoc to Developer ID (checked 2026-11-03)

Squirrel.Mac (ShipIt) installs an update only if the new bundle passes
`SecStaticCodeCheckValidityWithErrors` (nested code, strict, all
architectures) against the designated requirement of the app that is running
(`SQRLCodeSignature -verifyBundleAtURL:`). Ad-hoc builds from
`build/afterPack.js` carry the requirement `identifier "com.tejasnafde.switchboard"`
and nothing else, and a Developer ID build keeps that identifier. So the first
signed release installs over an ad-hoc install by auto-update, and
`afterSign.js` checks that requirement on every signed build.

An ad-hoc install older than the identifier-only requirement (it has a cdhash
requirement, `codesign -d -r- /Applications/Switchboard.app` shows it) cannot
auto-update. Download the zip from the release once and replace the app by
hand. Today the only real install is the owner's, so a one-time manual install
is acceptable if the auto-update fails for any reason.

After the switch, macOS can ask once more for the keychain item
"Switchboard Safe Storage" (choose Always Allow) and for folder access, because
both are bound to the code signature.

The Developer ID requirement includes the team (`certificate leaf[subject.OU] = "4GHRM59326"`).
From then on, an unsigned or ad-hoc build can never auto-update a signed
install. Keep the six macOS secrets set; removing them makes the next release
unsigned and strands every signed install. A renewed certificate from the same
team still satisfies the requirement.

macOS ships as a `.zip` (not `.dmg`), as configured in `electron-builder.yml`.
CI and the macOS release build run on `macos-15` (PR #492). The screenshot job
hides the Dock so the capture window fits; native glass checks still run locally.
Users drag `Switchboard.app` from the zip to `/Applications` on first install.
Auto-update uses the zip directly and works without the DMG.

---

## How auto-update works

Both platforms use [`electron-updater`](https://www.electron.build/auto-update).
On launch, hourly, on resume and on demand from **Settings → General → Check for updates**,
the renderer talks to a small main-process module
(`src/main/updater.ts`) that:

1. Fetches `latest-mac.yml` / `latest.yml` from the most recent
   GitHub Release for `tejasnafde/switchboard`.
2. Compares the version in that file against `app.getVersion()`.
3. If newer, downloads the update in the background and emits
   `update-downloaded`. The Settings UI surfaces a "Restart and
   install" button at that point.

The updater is **a no-op in `npm run dev`** - `app.isPackaged` is
false, so there's no version baseline to compare against. Test against
a real `.zip` / `.exe`.

---

## What the pipeline enforces, and why

Each of these was once a bullet an operator was asked to remember. They are
listed here as rationale, not as steps to perform.

- **Deliberate release.** `release.yml` accepts a manual dispatch with a human-chosen
  version and also supports direct `v*` tag pushes for recovery.
- **The version must match the tag** (sans `v`). `release-build.yml` sets it
  from the tag on the runner (`npm version <tag> --no-git-tag-version`), so the
  two cannot differ and `main` needs no bump commit.
- **CI must pass the tagged tree.** `ci_status` finds a successful `ci.yml` run
  on the exact commit, or the `gate` job runs `ci.yml` itself. A tag pushed from
  a branch whose CI never ran cannot publish.
- **No screen changed by accident.** `ci.yml`'s `visual` job compares the
  screen fixtures across the supported themes with committed baselines, and the `gate` job
  runs `ci.yml` (or `ci_status` found it passed), so a release cannot ship a
  tree whose screens drifted. The
  native translucency check is not in it (it cannot run on the runner): run
  `SB_VISUAL_SCOPE=behaviour npm run test:e2e:visual` on a Mac before tagging
  a release that touched a theme.
- **Each platform's assets must land.** `publish` asserts the three macOS ones
  before the release becomes visible, and `verify_windows` the three Windows
  ones after. A Release missing a `latest*.yml` makes every client report "up
  to date" with no error anywhere. That silence is why this is a job and not a
  checklist.
- **Both manifests must declare the released version.** A `latest*.yml` naming
  the wrong version is indistinguishable from no release at all to a client:
  the version compare finds nothing newer and the check succeeds.

Asset names in `scripts/verify-release-assets.sh` are asserted against electron-builder's real output.
Until 0.7.29 this doc claimed `Switchboard Setup X.Y.Z.exe`; the real name is
`Switchboard-Setup-X.Y.Z.exe`. A prose checklist cannot notice its own drift.

### Post-release smoke test (still manual, on purpose)

Nothing in CI can prove the update actually installs, because that needs a
packaged app replacing itself on a real machine. Install the previous version,
relaunch, and confirm the prompt appears after the initial update check. If it does not:

- Open Settings → General → Check for updates and read the status line.
- Tail the app log at `~/Library/Application Support/switchboard/logs/`
  on macOS (or `%APPDATA%\switchboard\logs\` on Windows). Lines tagged
  `[updater]` show what electron-updater saw.

---

## Local builds (without publishing)

```bash
npm run dist:mac   # → release/Switchboard-X.Y.Z-arm64-mac.zip
npm run dist:win   # → release/Switchboard-Setup-X.Y.Z.exe (Windows host only)
```

These don't touch GitHub - useful for one-off testing.

`dist:win` only works from a Windows host because the
`@anthropic-ai/claude-agent-sdk-win32-x64` optional dependency only
installs on Windows. Cross-compiling from a Mac produces a build that
crashes at SDK init.

---

## macOS Gatekeeper / unsigned-build caveats

Artifacts from a credential-free release run are unsigned. Users will see one
of two prompts:

- **First install**: "Switchboard can't be opened because the
  developer cannot be verified." - Right-click the app in Finder →
  Open → Open. macOS remembers this choice for the current binary.
- **After every auto-update**: macOS Gatekeeper re-quarantines the
  replaced app bundle. Users have to right-click → Open again, **or**
  run `xattr -d com.apple.quarantine /Applications/Switchboard.app`
  in a terminal. The only real fix is a $99/year Apple Developer cert.

The auto-update flow itself works fine - the updater downloads the
new version and replaces the app bundle. It's purely the post-replace
launch that gets re-quarantined.

Once the six macOS secrets above are configured, CI automatically switches to
the signed overlay, and none of these prompts appear. Do not hard-code a
certificate identity in the repository.

---

## Windows SmartScreen caveats

Artifacts from a credential-free Windows run are unsigned. Users see "Windows
protected your PC" the first time they run the installer - click **More info →
Run anyway**. Auto-update is silent thereafter.

Adding the two Windows secrets above switches the release lane to Authenticode.

---

## Emergency rollback

If a release ships a critical bug:

1. Go to the Release on GitHub and **delete** it (or mark it as
   "Draft" - the auto-updater ignores draft releases).
2. The previous Release's `latest-mac.yml` / `latest.yml` becomes
   the most recent published metadata.
3. On users' next update check (every launch + every manual click),
   the updater sees the older version as "latest" and won't push
   the bad build. Users who already updated stay on the bad build
   until you ship a fix; their `app.getVersion()` is higher than the
   re-instated-old `latest`, so they get no downgrade prompt.

The cleanest fix is **always to ship a +1 patch with the rollback**
rather than relying on the delete trick. e.g. v0.1.5 broke → ship
v0.1.6 that reverts the offending commit. Users auto-update again
within minutes.

---

## Adding new platforms

The platform list is intentionally minimal. To add Linux:

1. Add a `build_linux` job to `release.yml` that calls `release-build.yml`
   with `os: ubuntu-latest`, and a `verify_linux` job like `verify_windows`
   (plus a `linux` case in `scripts/verify-release-assets.sh`).
2. Add a `linux:` block to `electron-builder.yml`:
   ```yaml
   linux:
     target:
       - target: AppImage
         arch: [x64]
     category: Development
   ```
3. Push a tag. The Release will gain `*.AppImage` and a Linux
   `latest-linux.yml` for auto-update.

Windows arm64 is the same drill - add `arm64` to the existing `win.target`
arch list. We've kept it off because it doubles per-tag CI time and
Windows-on-ARM market share is thin.
