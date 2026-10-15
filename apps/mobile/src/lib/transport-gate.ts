/**
 * Store builds refuse plain ws:// to a host off this device.
 *
 * "Store build" is read from the installed binary (App Store and TestFlight
 * share a distribution profile), not from the JS bundle, because the store and
 * internal builds share an OTA channel and a bundle-time flag would follow
 * whichever profile published last.
 *
 * TestFlight and App Store builds cannot pin the desktop's self-signed
 * certificate yet: React Native's WebSocket has no hook for it, so that needs a
 * native module. Until then they reach a backend over Cloud IAP or a wss://
 * address whose certificate the system trusts.
 */
import * as Application from 'expo-application'
import { Platform } from 'react-native'
import { createLogger } from '@shared/logger'
import { cleartextRefusal } from '@shared/transport-security'

const log = createLogger('lib:transport-gate')

let storeBuild: boolean | undefined
let probe: Promise<void> | null = null

/** Resolves once the build type is known. Safe to call repeatedly. */
export function storeBuildKnown(): Promise<void> {
  if (storeBuild !== undefined) return Promise.resolve()
  probe ??= (
    Platform.OS === 'ios'
      ? // Called inside then() so a missing native function (an older binary, a
        // partial mock) rejects into the catch below instead of throwing here.
        Promise.resolve()
          .then(() => Application.getIosApplicationReleaseTypeAsync())
          .then((type) => type === Application.ApplicationReleaseType.APP_STORE)
      : Promise.resolve(false)
  )
    .catch((err: unknown) => {
      // Fail closed: an unknown build is treated as a store build.
      log.warn('could not read the build type, refusing plain ws:// to remote hosts', err)
      return true
    })
    .then((value) => {
      storeBuild = value
    })
  return probe
}

/**
 * Error copy when this build must not dial `url`, null when it may, and
 * undefined while the build type is still being read (await `storeBuildKnown`).
 */
export function transportRefusal(url: string): string | null | undefined {
  if (storeBuild === undefined) {
    void storeBuildKnown()
    return undefined
  }
  return storeBuild ? cleartextRefusal(url) : null
}
