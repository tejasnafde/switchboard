/**
 * Permit cleartext HTTP/WebSocket traffic in Android release builds.
 *
 * Without this the app is broken in every shipped APK, in a way that never
 * appears during development:
 *
 *  - React Native's Gradle plugin sets `usesCleartextTraffic` to "true" for the
 *    debug build type and "false" for release
 *    (@react-native/gradle-plugin AgpConfiguratorUtils.kt).
 *  - Expo's generated debug manifest sets `android:usesCleartextTraffic="true"`,
 *    but the main manifest sets nothing, so a release build falls back to the
 *    platform default, which is "block" for targetSdk 28 and above.
 *  - Our entire backend transport is `ws://` (LAN, tailnet, or an ssh tunnel).
 *
 * So `expo run:android` and the `development` EAS profile work, while the
 * `preview` and `production` profiles produce an APK whose every connection
 * attempt fails at the platform layer. The failure surfaces as a generic
 * socket error, which reads exactly like the desktop being offline.
 *
 * The blanket flag rather than a narrow networkSecurityConfig, deliberately: a
 * user pairs with an arbitrary host they name themselves (a LAN address, a
 * tailnet name, a forwarded port), so there is no fixed domain list to allow.
 * The real fix is `wss://`, which needs a certificate story the pairing flow
 * does not have yet.
 */
const { withAndroidManifest } = require('expo/config-plugins')

module.exports = function withAndroidCleartextTraffic(config) {
  return withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0]
    if (!application) {
      throw new Error('withAndroidCleartextTraffic: no <application> node in the Android manifest')
    }
    application.$['android:usesCleartextTraffic'] = 'true'
    return mod
  })
}
