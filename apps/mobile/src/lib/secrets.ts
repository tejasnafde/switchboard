/**
 * Backend credentials, in the OS keystore rather than the persisted store.
 *
 * These grant filesystem and (for a legacy token) PTY access on the paired
 * machine. They used to ride in the zustand `persist` blob, which on Android is
 * an unencrypted file in the app sandbox, while the lower-value Google token
 * was already in SecureStore.
 */
import * as SecureStore from 'expo-secure-store'
import { createLogger } from '@shared/logger'

const log = createLogger('mobile:secrets')

/** SecureStore keys allow alphanumerics plus `.-_`. */
const KEY_PREFIX = 'sb-token-'
/** Kept apart from the legacy token so a connection can hold both. */
const SESSION_PREFIX = 'sb-session-'

function safeId(connectionId: string): string {
  return connectionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

function keyFor(connectionId: string): string {
  return `${KEY_PREFIX}${safeId(connectionId)}`
}

function sessionKeyFor(connectionId: string): string {
  return `${SESSION_PREFIX}${safeId(connectionId)}`
}

export async function saveConnectionSession(connectionId: string, session: string | undefined): Promise<boolean> {
  try {
    if (session) await SecureStore.setItemAsync(sessionKeyFor(connectionId), session)
    else await SecureStore.deleteItemAsync(sessionKeyFor(connectionId))
    return true
  } catch (err) {
    log.warn('could not write the device session to the keystore', err)
    return false
  }
}

export async function loadConnectionSession(connectionId: string): Promise<string | undefined> {
  try {
    return (await SecureStore.getItemAsync(sessionKeyFor(connectionId))) ?? undefined
  } catch (err) {
    log.warn('could not read the device session from the keystore', err)
    return undefined
  }
}

/** Callers MUST act on false: a token in neither store is gone, and the next
 *  launch is rejected with 4001, which reads as "wrong token". */
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
    await SecureStore.deleteItemAsync(sessionKeyFor(connectionId))
    await SecureStore.deleteItemAsync(keyFor(connectionId))
  } catch (err) {
    log.warn('could not delete pairing token from the keystore', err)
  }
}

/**
 * Move tokens an older build left in the persisted blob into the keystore.
 * Write-then-clear, so a crash between the two replays harmlessly.
 *
 * `failed` ids must STAY in the blob or they exist nowhere: reporting a failed
 * write as success drops the safer store and the only copy in one step.
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
