const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const STAPLE_ATTEMPTS = 5
// Staple attempt n + 1 waits n times this. Read at call time so tests can set it to 0.
exports.stapleRetryDelayMs = 30_000

// electron-builder's notarize step staples once and fails the build on any
// network error. On GitHub's macOS runners the ticket lookup at
// api.apple-cloudkit.com drops the connection (stapler exit 68) after Apple has
// already accepted the submission, so the signed overlay turns that step off
// and this hook submits and staples, retrying the staple.
function notarize(appPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notarize-'))
  try {
    const zip = path.join(dir, `${path.basename(appPath, '.app')}.zip`)
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip], { stdio: 'inherit' })
    const output = execFileSync(
      'xcrun',
      [
        'notarytool',
        'submit',
        zip,
        '--key',
        process.env.APPLE_API_KEY,
        '--key-id',
        process.env.APPLE_API_KEY_ID,
        '--issuer',
        process.env.APPLE_API_ISSUER,
        '--wait',
        '--timeout',
        '30m',
        '--output-format',
        'json',
      ],
      { encoding: 'utf8' },
    )
    const result = JSON.parse(output)
    console.log(`[afterSign] notarization ${result.id}: ${result.status}`)
    if (result.status !== 'Accepted') {
      throw new Error(`Notarization ${result.id} ended with status ${result.status}; run xcrun notarytool log ${result.id}`)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function stapleWithRetries(appPath) {
  for (let attempt = 1; ; attempt++) {
    try {
      // A stalled lookup must end the attempt, not the job.
      execFileSync('xcrun', ['stapler', 'staple', '-v', appPath], { stdio: 'inherit', timeout: 300_000 })
      return
    } catch (err) {
      if (attempt >= STAPLE_ATTEMPTS) throw err
      const delay = exports.stapleRetryDelayMs * attempt
      console.warn(`[afterSign] staple attempt ${attempt} failed; retrying in ${delay / 1000}s`, err.message)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

exports.default = async function afterSign(context) {
  // Only electron-builder.signed.yml runs this hook, and it turns off
  // electron-builder's notarize step, so skipping here would ship an app with
  // no ticket and no checks.
  if (process.env.SB_SIGNING_MODE !== 'signed') {
    throw new Error('electron-builder.signed.yml needs SB_SIGNING_MODE=signed (scripts/signing-mode.mjs)')
  }

  const product = context.packager.appInfo.productFilename
  if (context.electronPlatformName === 'darwin') {
    const appPath = path.join(context.appOutDir, `${product}.app`)
    notarize(appPath)
    // `stapler staple` validates the ticket it attaches ("The staple and
    // validate action worked!"), so no separate `stapler validate` runs: it
    // fetched the same ticket again over the same flaky connection and failed
    // a release on 2026-11-03 after the staple had succeeded.
    await stapleWithRetries(appPath)
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
    console.log('[afterSign] stapled and validated the notarization ticket, verified Developer ID signature and Gatekeeper assessment')
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
