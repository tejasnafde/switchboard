/**
 * Backend pairing tokens, kept in the OS keystore rather than the persisted
 * store.
 *
 * A pairing token grants a PTY and full filesystem access on the paired
 * machine, so it is the highest-value secret this app holds. It used to ride
 * along in the zustand `persist` blob, which on Android is an unencrypted file
 * in the app sandbox - readable from a rooted device or an ADB backup. The
 * Google OAuth token was already in SecureStore, so the more dangerous
 * credential was the less protected one.
 *
 * Config rows still persist normally; only the token is split out and keyed by
 * connection id.
 */
import * as SecureStore from 'expo-secure-store'
import { createLogger } from '@shared/logger'

const log = createLogger('mobile:secrets')

/** SecureStore keys allow alphanumerics plus `.-_`, which connection ids
 *  (`c-<epoch ms>`) already satisfy. */
const KEY_PREFIX = 'sb-token-'

function keyFor(connectionId: string): string {
  return `${KEY_PREFIX}${connectionId.replace(/[^A-Za-z0-9._-]/g, '_')}`
}

/** True when the keystore accepted the write. The caller MUST act on false:
 *  a token that reached neither the keystore nor the persisted blob is gone,
 *  and the next launch presents nothing and is rejected with 4001, which the
 *  user reads as "wrong token" rather than "we lost it". */
export async function saveConnectionToken(connectionId: string, token: string | undefined): Promise<boolean> {
  try {
    if (token) await SecureStore.setItemAsync(keyFor(connectionId), token)
    else await SecureStore.deleteItemAsync(keyFor(connectionId))
    return true
  } catch (err) {
    log.warn('could not write pairing token to the keystore', err)
    return false
  }
}

export async function loadConnectionToken(connectionId: string): Promise<string | undefined> {
  try {
    return (await SecureStore.getItemAsync(keyFor(connectionId))) ?? undefined
  } catch (err) {
    log.warn('could not read pairing token from the keystore', err)
    return undefined
  }
}

export async function deleteConnectionToken(connectionId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(keyFor(connectionId))
  } catch (err) {
    log.warn('could not delete pairing token from the keystore', err)
  }
}

/**
 * Move tokens that an older build left in the persisted config blob into the
 * keystore.
 *
 * Write-then-clear, deliberately: a crash between the two replays the
 * migration harmlessly, whereas clearing first would lose the token outright.
 *
 * `failed` carries the ids the keystore refused. Those tokens must STAY in the
 * persisted blob, or they exist nowhere. Reporting a failed write as a success
 * is how the safer store and the only remaining copy get dropped in one step.
 */
export async function migrateTokensToKeystore(
  configs: ReadonlyArray<{ id: string; token?: string }>,
): Promise<{ migrated: string[]; failed: string[] }> {
  const migrated: string[] = []
  const failed: string[] = []
  for (const config of configs) {
    if (!config.token) continue
    if (await saveConnectionToken(config.id, config.token)) migrated.push(config.id)
    else failed.push(config.id)
  }
  if (migrated.length > 0) log.info(`moved ${migrated.length} pairing token(s) into the keystore`)
  if (failed.length > 0) log.error(`keystore refused ${failed.length} token(s); leaving them in local storage`)
  return { migrated, failed }
}
