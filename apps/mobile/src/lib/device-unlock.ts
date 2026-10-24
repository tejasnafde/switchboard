/**
 * Face ID, Touch ID or the device passcode, asked before every pull request
 * write (no grace window). The passcode fallback is always allowed, so nobody
 * is locked out; a phone with no passcode at all cannot post.
 */
import { createLogger } from '@shared/logger'

const log = createLogger('lib:device-unlock')

/** 'ok' posts. Every other answer sends nothing. */
export type DeviceUnlock = 'ok' | 'cancelled' | 'no-passcode' | 'unavailable'

const NO_PASSCODE_ERRORS = new Set(['passcode_not_set', 'not_enrolled', 'not_available'])

export async function unlockToPost(): Promise<DeviceUnlock> {
  try {
    // Required lazily: an Expo Go runtime without the native module reaches the catch, not a crash at import.
    const LocalAuthentication = require('expo-local-authentication') as typeof import('expo-local-authentication')
    const level = await LocalAuthentication.getEnrolledLevelAsync()
    if (level === LocalAuthentication.SecurityLevel.NONE) return 'no-passcode'
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Post to the pull request',
      disableDeviceFallback: false,
    })
    if (result.success) return 'ok'
    if (NO_PASSCODE_ERRORS.has(result.error)) return 'no-passcode'
    log.info('device unlock not given', { error: result.error })
    return 'cancelled'
  } catch (err) {
    log.warn('device unlock unavailable', err)
    return 'unavailable'
  }
}
