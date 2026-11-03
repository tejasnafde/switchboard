const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function afterSign(context) {
  if (process.env.SB_SIGNING_MODE !== 'signed') return

  const product = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    const appPath = path.join(context.appOutDir, `${product}.app`)
    // Installed builds signed ad-hoc by afterPack.js carry the designated
    // requirement `identifier "<bundle id>"`, and ShipIt installs an update
    // only if it satisfies the running app's requirement. Checking it here
    // keeps the ad-hoc to Developer ID auto-update path open.
    const updateRequirement = `=identifier "${context.packager.appInfo.id}"`
    execFileSync(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', `-R${updateRequirement}`, appPath],
      { stdio: 'inherit' },
    )
    execFileSync('spctl', ['--assess', '--type', 'exec', '-vv', appPath], { stdio: 'inherit' })
    execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })
    console.log('[afterSign] verified Developer ID signature, Gatekeeper assessment and notarization ticket')
    return
  }

  if (context.electronPlatformName === 'win32') {
    const executable = path.join(context.appOutDir, `${product}.exe`)
    const script = [
      "$signature = Get-AuthenticodeSignature -LiteralPath $env:SB_SIGN_TARGET",
      "if ($signature.Status -ne 'Valid') {",
      "  throw ('Authenticode verification failed: ' + $signature.Status)",
      '}',
    ].join('; ')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, SB_SIGN_TARGET: executable },
      stdio: 'inherit',
    })
    console.log('[afterSign] verified Authenticode signature')
  }
}
