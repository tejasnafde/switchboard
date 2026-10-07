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

Monotonic means strictly higher than every APK ever published, not just the
newest one. The job pages through all releases (`gh api --paginate`), downloads
the APK of every non-draft `mobile-v*` release, and
`scripts/verify-android-apk.mjs --newer-than-published <dir>` refuses the new
APK unless its `versionCode` exceeds the highest published `versionCode` and
its `versionName` exceeds the highest published `versionName`, each compared
with its own maximum and naming the release it failed to beat. The published
APKs are only read for their version: 0.3.0 and 0.4.0 carry `versionCode` 1,
below the native floor, so they are compared but not identity-checked. When no
`mobile-v*` APK is published yet the check is skipped with a notice, which is
the first release.

React Native remains the iOS client. `mobile-ota.yml` now publishes EAS updates
with `--platform ios`; native Android receives signed APK updates only.

The workflow proves artifact identity, not installation behavior. Before the
first native public release, install the untouched production-signed v0.4.0 APK
on physical API 24 and current devices, seed its storage/outbox, and exercise an
actual in-app upgrade without uninstalling. Record migration, installer and
post-upgrade data checks separately from automated results.

## TL;DR

A desktop release is a tag on `main`. There is no version-bump pull request:
`release-build.yml` sets `package.json` to the tag's version on the runner
before it builds, so the artifacts, the update manifests and `app.getVersion()`
all carry the tag's version while `main` keeps whatever it had.

```bash
set -euo pipefail                          # or the tag outlives a failed step
git fetch origin
sha=$(git rev-parse origin/main)
ci=$(gh run list --branch main --workflow ci.yml --limit 10 --json headSha,conclusion \
  --jq ".[] | select(.headSha==\"$sha\") | .conclusion" | head -1)
[ "$ci" = success ] || { echo "main CI is not green on $sha ($ci)"; exit 1; }
git tag "v<version>" "$sha" && git push origin "v<version>"
```

Tag only a commit on `main`. `release.yml` fires on any `v*` tag and builds it,
so a tag on a branch commit ships that branch. If it happens: cancel the run,
then `git push origin :refs/tags/<tag>` before anything publishes.

`set -euo pipefail` is there because the block is meant to be pasted whole: a
failed check must stop the `git tag` at the bottom.

Write the CHANGELOG entry on the FEATURE branch, with the change itself.

Everything the operator used to verify by hand is a job in `release.yml`, so a
green run means it was checked:

| Job | Enforces |
|---|---|
| `ci_status` | Looks up a successful `ci.yml` run on the tagged commit. |
| `gate` | Calls `ci.yml` only when `ci_status` found none (a tag on a commit whose CI never ran or failed). Main CI already passed on a normal release commit, and running it again proves nothing. |
| `prepare_release` | Creates one hidden draft for both builds to upload into. |
| `build_mac`, `build_win` | `release-build.yml` once per OS, in parallel. Each sets the version from the tag, runs `build:ci` (build plus the packaged-app smoke test; typecheck and tests already passed on this commit) and publishes into the draft. |
| `publish` | As soon as the macOS build ends: asserts the macOS assets and `latest-mac.yml` (`scripts/verify-release-assets.sh mac`), then publishes the release. It does not wait for Windows. |
| `verify_windows` | When the slower Windows build ends: asserts its assets and `latest.yml` on the already published release. Until `latest.yml` lands, Windows clients see no update yet. |

The only judgment left to a human is the version: **a patch bump for iterative
work including feature batches**; reserve a minor bump for headline surface
changes (0.7.0 = the embedded IDE replaced the editor).

If `publish` or `verify_windows` fails, re-run the failed build job from the
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
stored data or a migration also waits for a clean hosted review.

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
On launch (and on demand from **Settings → General → Check for updates**),
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
- **The version must match the tag** (sans `v`). `release-build.yml` sets it
  from the tag on the runner (`npm version <tag> --no-git-tag-version`), so the
  two cannot differ and `main` needs no bump commit.
- **CI must pass the tagged tree.** `ci_status` finds a successful `ci.yml` run
  on the exact commit, or the `gate` job runs `ci.yml` itself. A tag pushed from
  a branch whose CI never ran cannot publish.
- **No screen changed by accident.** `ci.yml`'s `visual` job compares eight
  screens in all three themes with committed baselines, and the `gate` job
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
relaunch, and confirm the prompt appears within ~30 seconds. If it does not:

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
