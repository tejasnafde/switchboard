/**
 * electron-builder afterPack hook — re-sign the macOS bundle ad-hoc with
 * an identifier-only designated requirement.
 *
 * Two problems we're solving:
 *
 * 1. Internal consistency. We don't have an Apple Developer cert, so
 *    electron-builder skips signing (`mac.identity: null`). The Electron
 *    framework binaries inside the bundle inherit ad-hoc signatures from
 *    upstream that reference a `Contents/_CodeSignature/CodeResources`
 *    manifest; when electron-builder rewrites resources during pack
 *    (icon, asar, extraResources), those hashes drift and ShipIt's
 *    validation fails with "code has no resources but signature
 *    indicates they must be present." Re-signing the whole bundle
 *    regenerates the manifest.
 *
 * 2. Cross-version compatibility (THE auto-update blocker). ShipIt
 *    validates the downloaded bundle by checking that its signature
 *    satisfies the *currently installed* app's designated requirement.
 *    A vanilla `codesign --sign -` produces a DR that includes the
 *    binary's cdhash — which is by definition unique per build. So
 *    v0.1.N+1 can never satisfy v0.1.N's cdhash-bound DR, and ShipIt
 *    rejects every auto-update with "code failed to satisfy specified
 *    code requirement(s)."
 *
 *    Fix: pass an explicit DR that uses only the bundle identifier:
 *      =designated => identifier "io.geoiq.switchboard"
 *    Any future build with the same CFBundleIdentifier now satisfies
 *    the requirement.
 *
 *    NOTE: This only takes effect from this build forward. The v0.1.N
 *    that's already installed on a user's machine has a cdhash DR baked
 *    into its signature; auto-update *to* the first build with this fix
 *    will fail. Users have to manually install one more DMG. Every
 *    update after that works.
 *
 * Gatekeeper still flags the build as unsigned on first launch (we have
 * no Developer ID), so the `xattr -dr com.apple.quarantine` dance from
 * the README is still required. That's separate from the ShipIt
 * validation we're fixing here.
 */
const { execSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const bundleId = context.packager.appInfo.id // io.geoiq.switchboard
  // `=designated => identifier "..."` overrides the implicit DR. Without
  // this, codesign synthesizes a DR that includes cdhash + anchor, which
  // pins the requirement to one specific build.
  const requirements = `=designated => identifier "${bundleId}"`

  console.log(`[afterPack] ad-hoc signing ${appPath} with DR identifier=${bundleId}`)
  try {
    // --force: overwrite any existing (inherited) signature.
    // --deep: recurse through helper binaries + the Electron framework.
    // --sign -: ad-hoc, no certificate required.
    // --identifier: explicit identifier so the DR string can reference it.
    // --requirements: custom designated requirement that omits cdhash.
    execSync(
      `codesign --force --deep --sign - ` +
        `--identifier "${bundleId}" ` +
        `--requirements '${requirements}' ` +
        `"${appPath}"`,
      { stdio: 'inherit' },
    )
    console.log('[afterPack] ad-hoc signing succeeded')
  } catch (err) {
    console.error('[afterPack] ad-hoc signing failed:', err)
    throw err
  }
}
