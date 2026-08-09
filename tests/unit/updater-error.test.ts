import { describe, it, expect } from 'vitest'
import { friendlyUpdateError, isStaleDownloadError } from '../../src/main/updater-error'

/** Verbatim from a real 0.7.27 failure - the staging file was purged mid-download. */
const STALE_RENAME =
  "ENOENT: no such file or directory, rename '/Users/x/Library/Caches/switchboard-updater/pending/temp-Switchboard-0.7.27-arm64-mac.zip' -> '/Users/x/Library/Caches/switchboard-updater/pending/Switchboard-0.7.27-arm64-mac.zip'"

describe('isStaleDownloadError', () => {
  it('recognises the purged-staging-file rename failure', () => {
    expect(isStaleDownloadError(STALE_RENAME)).toBe(true)
  })

  it('ignores unrelated ENOENT and unrelated rename failures', () => {
    // A missing app-update.yml is a config problem, not a retryable download.
    expect(isStaleDownloadError("ENOENT: no such file or directory, open 'app-update.yml'")).toBe(false)
    // A rename that is not of a `temp-` staging file is not this bug.
    expect(isStaleDownloadError("EPERM: operation not permitted, rename '/a' -> '/b'")).toBe(false)
    expect(isStaleDownloadError('HttpError: 404 Not Found')).toBe(false)
  })
})

describe('friendlyUpdateError', () => {
  it('maps offline / network errors to a clean message', () => {
    expect(friendlyUpdateError('net::ERR_INTERNET_DISCONNECTED')).toBe('No internet connection')
    expect(friendlyUpdateError('getaddrinfo ENOTFOUND github.com')).toBe('No internet connection')
    expect(friendlyUpdateError('request to https://… failed, reason: ETIMEDOUT')).toBe('No internet connection')
  })

  it('replaces the raw staging-file errno with something actionable', () => {
    expect(friendlyUpdateError(STALE_RENAME)).toBe('Update download was interrupted - try again')
  })

  it('passes through non-network errors unchanged', () => {
    expect(friendlyUpdateError('HttpError: 404 Not Found')).toBe('HttpError: 404 Not Found')
    expect(friendlyUpdateError('signature verification failed')).toBe('signature verification failed')
  })

  it('maps a timed-out check to a message that names the restart escape hatch', () => {
    // electron-updater caches the in-flight check promise, so once one check
    // hangs, every retry click awaits the same hung request - only an app
    // restart truly resets it. The message has to say so.
    // The check usually COMPLETES after this fires. A network path that stalls
    // the connect to release-assets.githubusercontent.com for 30s+ makes it
    // late, not dead, and electron-updater keeps working in the background, so
    // claiming failure here is a lie the user acts on.
    expect(friendlyUpdateError('Update check timed out after 120000ms')).toBe(
      'Still checking. This network is slow to reach GitHub, so it will finish in the background.',
    )
  })
})
