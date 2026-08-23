# Releasing Switchboard

This is the operator's guide for cutting a release. The user-facing
install instructions live in `README.md`.

## Native Android mobile release

Native Android uses the existing `mobile-v<version>` GitHub channel, but no
longer builds its APK on EAS. Increment `versionName` and `versionCode` in
`apps/android/app/build.gradle.kts`; a main-branch change under `apps/android`
becomes eligible for a manual `mobile-release.yml` dispatch, which builds
`switchboard-<version>.apk` and its `.sha256` file. Keep the lane manual until
the complete production-signed physical-device upgrade matrix is certified.

The release job is intentionally inert until the production EAS keystore used
for the public v0.4.0 APK has been exported and these repository secrets exist:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Before publishing, the workflow runs the Android unit/lint gate and rejects an
APK unless its package is `app.switchboard.mobile`, its version is monotonic,
its sole signer has SHA-256 fingerprint
`BC:81:1E:37:12:C2:D5:7F:2B:6E:BD:A5:43:92:E6:2E:BD:2A:77:34:53:E5:0F:B3:75:E1:10:2D:B9:01:A8:F6`,
and its checksum file matches the APK bytes. Never generate a replacement key:
Android would reject the update and force an uninstall, losing app-private
data.

React Native remains the iOS client. `mobile-ota.yml` now publishes EAS updates
with `--platform ios`; native Android receives signed APK updates only.

The workflow proves artifact identity, not installation behavior. Before the
first native public release, install the untouched production-signed v0.4.0 APK
on physical API 24 and current devices, seed its storage/outbox, and exercise an
actual in-app upgrade without uninstalling. Record migration, installer and
post-upgrade data checks separately from automated results.

## TL;DR

```bash
npm version patch          # or minor / major
git push --follow-tags
```

That is the whole procedure. Everything the operator used to verify by hand
is a job in `release.yml`, so a green run means it was checked:

| Job | Enforces |
|---|---|
| `gate` | Calls `ci.yml`. A tag cannot publish a tree that fails typecheck, tests or build on ubuntu + macOS + Windows. |
| `build` | Packages and publishes macOS arm64 + Windows x64 in parallel to the one Release. |
| `verify` | Fails the run unless all six install / auto-update assets exist AND both `latest*.yml` declare the version being released. |

The only judgment left to a human is the bump itself: **`patch` for iterative
work including feature batches** (0.6.3 shipped the SSH day-2 batch); reserve
`minor` for headline surface changes (0.7.0 = the embedded IDE replaced the
editor). Write the CHANGELOG entry before tagging.

If `verify` fails, the Release is partial and clients will not see the version.
Re-run the failed matrix job from the Actions UI; it is safe to re-run because
electron-builder dedups uploads by name.

### Signing modes

Release CI selects signing independently for each platform. With no signing
secrets, it deliberately produces the existing unsigned artifacts. With every
secret for a platform, it uses `electron-builder.signed.yml`, refuses unsigned
fallbacks, and verifies the resulting signature before packaging finishes.
Providing only part of a credential set fails the job before electron-builder
runs; secret values are never printed.

macOS signed releases require these repository secrets:

- `MAC_CSC_LINK`
- `MAC_CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Windows signed releases require:

- `WIN_CSC_LINK`
- `WIN_CSC_KEY_PASSWORD`

The macOS lane enables hardened runtime, Developer ID signing, notarization,
and ticket validation. The Windows lane enables Authenticode and validates the
packed executable. A manual workflow dispatch exercises the same selection and
verification without publishing.

Note: macOS ships as a `.zip` (not `.dmg`) - `dmg-builder` crashes on the
`macos-14` CI runner (`hdiutil: create failed - Device not configured`).
Users drag `Switchboard.app` from the zip to `/Applications` on first install.
Auto-update uses the zip directly and works without the DMG.

---

## How auto-update works

Both platforms use [`electron-updater`](https://www.electron.build/auto-update).
On launch (and on demand from **Settings → About → Check for updates**),
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

- **`--follow-tags`.** `release.yml` triggers only on a `v*` tag push. Pushing
  the commit without the tag builds nothing, which reads as a hung release.
- **The version must match the tag** (sans `v`). `npm version` guarantees it by
  bumping, committing and tagging atomically; electron-builder refuses to
  publish on a mismatch.
- **CI must pass the tagged tree.** The `gate` job calls `ci.yml`, so this is
  now an ordering property of the pipeline. A tag pushed from a branch whose CI
  never ran cannot publish.
- **All six assets must land.** The `verify` job asserts them by name. Two
  parallel build jobs mean one platform can fail while the other publishes, and
  a Release missing a `latest*.yml` makes every client report "up to date" with
  no error anywhere. That silence is why this is a job and not a checklist.
- **Both manifests must declare the released version.** A `latest*.yml` naming
  the wrong version is indistinguishable from no release at all to a client:
  the version compare finds nothing newer and the check succeeds.

Asset names in `verify` are asserted against electron-builder's real output.
Until 0.7.29 this doc claimed `Switchboard Setup X.Y.Z.exe`; the real name is
`Switchboard-Setup-X.Y.Z.exe`. A prose checklist cannot notice its own drift.

### Post-release smoke test (still manual, on purpose)

Nothing in CI can prove the update actually installs, because that needs a
packaged app replacing itself on a real machine. Install the previous version,
relaunch, and confirm the prompt appears within ~30 seconds. If it does not:

- Open Settings → About → Check for updates and read the status line.
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

Once the five macOS secrets above are configured, CI automatically switches to
the signed overlay. Do not hard-code a certificate identity in the repository.

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

The matrix is intentionally minimal. To add Linux:

1. Append `ubuntu-latest` to `strategy.matrix.os` in `release.yml`.
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
