/**
 * Registering this device for push.
 *
 * The phone obtains an Expo push token and hands it to every paired backend;
 * the backend does the sending, because the phone is asleep when it matters.
 *
 * Android requires FCM credentials on the EAS project - without them
 * `getExpoPushTokenAsync` throws and there is no token to register. Remote push
 * also does not work in Expo Go on Android from SDK 53, so this is a
 * development or production build feature only.
 */
import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import Constants from 'expo-constants'
import { ANDROID_CHANNEL_ID } from '@shared/push-policy'
import { createLogger } from '@shared/logger'

const log = createLogger('push')

/**
 * Android 8+ delivers only through a channel, and a payload naming a channel
 * that does not exist is dropped SILENTLY. The id must match what the backend
 * sends, hence the shared constant.
 */
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: 'Agent activity',
    importance: Notifications.AndroidImportance.HIGH,
    // No `sound`: on a channel the field is a FILENAME, so the literal
    // 'default' makes it hunt for a bundled file called "default" and warn.
    // Omitting it gives the system default.
  })
}

/** EAS project id. `getExpoPushTokenAsync` throws without one. */
function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId
}

export type PushSetup =
  | { ok: true; token: string }
  | { ok: false; reason: 'denied' | 'unsupported' | 'error'; detail?: string }

/**
 * Ask for permission and return this device's token.
 *
 * Never throws: push is an enhancement, and a phone that cannot register must
 * still work as a client.
 */
export async function obtainPushToken(): Promise<PushSetup> {
  try {
    await ensureAndroidChannel()

    const existing = await Notifications.getPermissionsAsync()
    let granted = existing.granted
    if (!granted && existing.canAskAgain) {
      granted = (await Notifications.requestPermissionsAsync()).granted
    }
    if (!granted) return { ok: false, reason: 'denied' }

    const id = projectId()
    if (!id) return { ok: false, reason: 'unsupported', detail: 'no EAS project id in the build' }

    const { data } = await Notifications.getExpoPushTokenAsync({ projectId: id })
    log.info('obtained push token')
    return { ok: true, token: data }
  } catch (err) {
    // The usual cause on Android is missing FCM credentials on the EAS project.
    const detail = err instanceof Error ? err.message : String(err)
    log.warn('push token unavailable', detail)
    return { ok: false, reason: 'error', detail }
  }
}
