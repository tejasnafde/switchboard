/**
 * electron-builder afterPack hook — re-sign the macOS bundle ad-hoc.
 *
 * Why: we don't have an Apple Developer cert, so `mac.identity: null`
 * tells electron-builder to skip signing. But the Electron framework
 * binaries inside the bundle ship with ad-hoc signatures from upstream
 * that reference a `Contents/_CodeSignature/CodeResources` manifest.
 * When electron-builder rewrites resources during pack (changing the
 * app icon, adding asar, etc.), the on-disk hashes no longer match the
 * signature manifest. macOS's Squirrel updater (ShipIt) validates the
 * downloaded bundle before swapping it in, sees the mismatch, and
 * aborts with "code has no resources but signature indicates they
 * must be present."
 *
 * Ad-hoc re-signing (`codesign --sign -`) regenerates the manifest
 * without a cert. Free, no notarization, no provisioning profile —
 * just makes the bundle internally consistent so ShipIt's validation
 * passes. Gatekeeper still flags it as unsigned on first launch (the
 * `xattr -dr com.apple.quarantine` dance from the README), but at
 * least auto-update no longer falls over.
 */
const { execSync } = require('child_process')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  console.log(`[afterPack] ad-hoc signing ${appPath}`)
  try {
    // --force overwrites any existing signature; --deep recurses through
    // every helper binary and the framework. `--sign -` means "ad-hoc";
    // produces a valid in-bundle signature with no cert.
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' })
    console.log('[afterPack] ad-hoc signing succeeded')
  } catch (err) {
    console.error('[afterPack] ad-hoc signing failed:', err)
    throw err
  }
}
