/**
 * expo-updates OTA for JS-only changes. Inert in dev and whenever
 * Updates.isEnabled is false, so a checkout without EAS configured stays quiet.
 * runtimeVersion is pinned to appVersion, so a bundle can never reach an APK
 * missing native modules it needs.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import * as Updates from 'expo-updates'
import { createLogger } from '@shared/logger'

const log = createLogger('mobile:ota-update')

/**
 * Check for a new bundle and download it if there is one. Resolves true when a
 * new bundle is staged and waiting for a reload.
 *
 * Never rejects: a failed update check must not break the app. Every failure is
 * logged.
 */
export async function checkAndFetchOtaUpdate(): Promise<boolean> {
  // In dev the bundle comes from Metro, and checkForUpdateAsync throws rather
  // than no-oping, so this whole path is skipped instead of caught.
  if (__DEV__) return false

  // False until eas update:configure has set updates.url. Checking it keeps a
  // not-yet-configured build from logging a warning on every foreground.
  if (!Updates.isEnabled) return false

  try {
    const check = await Updates.checkForUpdateAsync()
    if (!check.isAvailable) return false

    const fetched = await Updates.fetchUpdateAsync()
    if (!fetched.isNew) {
      // Rollback-to-embedded, or the bundle was already downloaded earlier.
      log.info('update fetch produced no new bundle', {
        isRollBackToEmbedded: fetched.isRollBackToEmbedded,
      })
      return false
    }

    log.info('ota bundle downloaded, waiting for reload')
    return true
  } catch (err) {
    log.warn('ota update check failed', err)
    return false
  }
}

/**
 * Restart into the downloaded bundle. Throws if the reload fails so the caller
 * can tell the user; on success this call does not return, the app restarts.
 */
export async function applyOtaUpdate(): Promise<void> {
  try {
    await Updates.reloadAsync()
  } catch (err) {
    log.error('reloading into the new bundle failed', err)
    throw err
  }
}

export type OtaUpdateState = {
  /** A new bundle is downloaded and a reload will pick it up. */
  ready: boolean
  applying: boolean
  error: string | null
  apply: () => void
}

/**
 * Checks on mount and every time the app comes back to the foreground, which is
 * exactly when a user who left the app open for days picks it up again.
 */
export function useOtaUpdate(): OtaUpdateState {
  const [ready, setReady] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Guards against two checks overlapping when AppState flaps active/inactive.
  const checking = useRef(false)

  useEffect(() => {
    let mounted = true

    const check = () => {
      if (checking.current) return
      checking.current = true
      checkAndFetchOtaUpdate()
        .then((hasUpdate) => {
          if (mounted && hasUpdate) setReady(true)
        })
        .catch((err) => log.warn('ota check rejected unexpectedly', err))
        .finally(() => {
          checking.current = false
        })
    }

    check()
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') check()
    })

    return () => {
      mounted = false
      sub.remove()
    }
  }, [])

  const apply = useCallback(() => {
    setApplying(true)
    setError(null)
    applyOtaUpdate().catch((err) => {
      setApplying(false)
      setError(err instanceof Error ? err.message : 'Restart failed')
    })
  }, [])

  return { ready, applying, error, apply }
}
