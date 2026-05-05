# Releasing Switchboard

This is the operator's guide for cutting a release. The user-facing
install instructions live in `README.md`.

## TL;DR

```bash
# 1. Bump version in package.json (must match the tag without `v`)
npm version patch          # or minor / major
git push && git push --tags

# 2. Wait ~10 min — GitHub Actions builds for macOS arm64 + Windows x64
#    in parallel and publishes both to the same Release.

# 3. Verify the Release page contains:
#    - Switchboard-X.Y.Z-arm64-mac.zip   ← macOS install + auto-update source
#    - Switchboard-X.Y.Z-arm64-mac.zip.blockmap
#    - latest-mac.yml          ← required for macOS auto-update
#    - Switchboard Setup X.Y.Z.exe
#    - Switchboard-X.Y.Z-win.zip
#    - latest.yml              ← required for Windows auto-update
```

Note: macOS ships as a `.zip` (not `.dmg`) — `dmg-builder` crashes on the
`macos-14` CI runner (`hdiutil: create failed - Device not configured`).
Users drag `Switchboard.app` from the zip to `/Applications` on first install.
Auto-update uses the zip directly and works without the DMG.

If any of those are missing, the auto-updater will silently fail to
detect the new version. Re-run the failing matrix job.

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

The updater is **a no-op in `npm run dev`** — `app.isPackaged` is
false, so there's no version baseline to compare against. Test against
a real `.dmg` / `.exe`.

---

## Release dance, in detail

### 1. Pre-flight

- Make sure `main` is green on CI (`.github/workflows/ci.yml`).
- Make sure `package.json#version` matches what you want to publish.
  electron-builder will refuse to publish if the version doesn't match
  the git tag (sans `v` prefix).
- Make sure no secrets are about to land — `git diff` for any
  `ANTHROPIC_API_KEY`, `GH_TOKEN`, `.env*`, `*.pem`, `*.key` etc. The
  `.gitignore` covers the common cases but a manual scan never hurts.

### 2. Cut the version

`npm version <patch|minor|major>` does three things atomically:

- bumps `package.json#version`
- commits with message `vX.Y.Z`
- creates an annotated tag `vX.Y.Z`

```bash
npm version patch
git push origin main --follow-tags
```

`--follow-tags` (or two pushes — `git push && git push --tags`) is
mandatory; the workflow only triggers on tag pushes.

### 3. Watch the build

Open `https://github.com/tejasnafde/switchboard/actions`. Two parallel
jobs (macos-14, windows-latest) run for ~8–12 minutes. If one fails,
the Release will only contain the other platform's artifacts and
that platform's users won't auto-update. Re-run the failed job from
the Actions UI.

### 4. Verify the Release

Check the Release page for the six artifacts listed in the TL;DR.
Install the previous version manually, relaunch, and confirm the
update prompt appears within ~30 seconds. If it doesn't:

- Open Settings → About → Check for updates and look at the status line.
- Tail the app log at `~/Library/Application Support/switchboard/logs/`
  on macOS (or `%APPDATA%\switchboard\logs\` on Windows). Lines tagged
  `[updater]` show what electron-updater saw.

---

## Local builds (without publishing)

```bash
npm run dist:mac   # → release/Switchboard-X.Y.Z-arm64.dmg
npm run dist:win   # → release/Switchboard Setup X.Y.Z.exe (Windows host only)
```

These don't touch GitHub — useful for one-off testing.

`dist:win` only works from a Windows host because the
`@anthropic-ai/claude-agent-sdk-win32-x64` optional dependency only
installs on Windows. Cross-compiling from a Mac produces a build that
crashes at SDK init.

---

## macOS Gatekeeper / unsigned-build caveats

We don't have an Apple Developer certificate, so `.dmg` files are
unsigned. Users will see one of two prompts:

- **First install**: "Switchboard can't be opened because the
  developer cannot be verified." — Right-click the app in Finder →
  Open → Open. macOS remembers this choice for the current binary.
- **After every auto-update**: macOS Gatekeeper re-quarantines the
  replaced app bundle. Users have to right-click → Open again, **or**
  run `xattr -d com.apple.quarantine /Applications/Switchboard.app`
  in a terminal. There is no way around this without paying $99/year
  for the Apple Developer Program; document loudly.

The auto-update flow itself works fine — the updater downloads the
new version and replaces the app bundle. It's purely the post-replace
launch that gets re-quarantined.

If we ever buy a cert: populate `mac.identity` in `electron-builder.yml`
with the `Developer ID Application: Tejas (TEAM_ID)` cert name, set
`hardenedRuntime: true`, add notarization credentials as CI secrets
(`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), and
electron-builder will sign + notarize on every release.

---

## Windows SmartScreen caveats

Windows builds are also unsigned. Users see "Windows protected your
PC" the first time they run the installer — click **More info → Run
anyway**. Auto-update is silent thereafter.

Buying a Windows code-signing cert (~$200–400/yr from Sectigo or
similar) removes the prompt; until then, accept the friction.

---

## Emergency rollback

If a release ships a critical bug:

1. Go to the Release on GitHub and **delete** it (or mark it as
   "Draft" — the auto-updater ignores draft releases).
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

Windows arm64 is the same drill — add `arm64` to the existing `win.target`
arch list. We've kept it off because it doubles per-tag CI time and
Windows-on-ARM market share is thin.
