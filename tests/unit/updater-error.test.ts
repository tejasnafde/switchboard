import { describe, it, expect } from 'vitest'
import {
  friendlyUpdateError,
  isMissingUpdateManifestError,
  isStaleDownloadError,
  redactUpdateLog,
  shouldRetryUpdateError,
} from '../../src/main/updater-error'

/** Shape of the 2026-11-05 failure: GitHub's CDN served a stale signed link. */
const JWT = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3MDAwMDAwMDB9.c2lnbmF0dXJl'
const JWT_EXPIRED = `HttpError: 618 "method: GET url: https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sv=2018&sig=abc404def&jwt=${JWT}&response-content-disposition=latest-mac.yml\n\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\n"\nHeaders: { "x-github-token": "ghs_secret123", "authorization": "Bearer ghp_abc" }\nData:\n <html><head><title>618 jwt:expired</title></head><body>Varnish cache server</body></html>`

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
  it('maps offline errors to a clean message', () => {
    expect(friendlyUpdateError('net::ERR_INTERNET_DISCONNECTED')).toBe('No internet connection.')
    expect(friendlyUpdateError('getaddrinfo ENOTFOUND github.com')).toBe('No internet connection.')
  })

  it('maps 618, 5xx and dropped connections to a server problem', () => {
    const server = "GitHub's download server had a problem. Try again in a minute."
    expect(friendlyUpdateError(JWT_EXPIRED)).toBe(server)
    expect(friendlyUpdateError('HttpError: 503 Service Unavailable')).toBe(server)
    expect(friendlyUpdateError('Cannot download "https://x/latest.yml", status 502: Bad Gateway')).toBe(server)
    expect(friendlyUpdateError('request to https://x failed, reason: ETIMEDOUT')).toBe(server)
    expect(friendlyUpdateError('read ECONNRESET')).toBe(server)
  })

  it('replaces the raw staging-file errno with something actionable', () => {
    expect(friendlyUpdateError(STALE_RENAME)).toBe('Update download was interrupted - try again')
  })

  it('never shows an unknown raw error', () => {
    expect(friendlyUpdateError('signature verification failed')).toBe("Couldn't check for updates. Try again later.")
  })

  it('reports a missing desktop update manifest as a broken release channel', () => {
    const mac = 'HttpError: 404 Not Found for latest-mac.yml'
    const windows = 'Cannot download latest.yml: status 404'

    expect(isMissingUpdateManifestError(mac)).toBe(true)
    expect(isMissingUpdateManifestError(windows)).toBe(true)
    expect(isMissingUpdateManifestError('HttpError: 404 Not Found for notes.md')).toBe(false)
    expect(friendlyUpdateError(mac)).toBe(
      'The latest desktop release is missing its update manifest. Install from the release page or try again after the release is repaired.',
    )
  })

  it('maps a timed-out check to a message that names the restart escape hatch', () => {
    // electron-updater caches the in-flight check promise, so once one check
    // hangs, every retry click awaits the same hung request - only an app
    // restart truly resets it. The message has to say so.
    // The check usually COMPLETES after this fires, so claiming failure is a
    // lie the user acts on by retrying into the same in-flight request.
    expect(friendlyUpdateError('Update check timed out after 120000ms')).toBe(
      'Still checking. This network is slow to reach GitHub, so it will finish in the background.',
    )
  })
})

describe('redactUpdateLog', () => {
  it('removes the signed URL query, the jwt and header tokens', () => {
    const out = redactUpdateLog(JWT_EXPIRED)
    expect(out).toContain('https://release-assets.githubusercontent.com/github-production-release-asset/1/2?<redacted>')
    expect(out).toContain('618 jwt:expired')
    for (const secret of ['eyJ', 'sig=abc', 'ghs_secret123', 'ghp_abc', 'sv=2018']) {
      expect(out).not.toContain(secret)
    }
  })

  it('removes a bare jwt and token parameter outside a URL', () => {
    expect(redactUpdateLog(`token=abc123 then ${JWT}`)).toBe('token=<redacted> then <jwt>')
  })

  it('leaves a plain line alone', () => {
    expect(redactUpdateLog('Checking for update')).toBe('Checking for update')
  })
})

describe('shouldRetryUpdateError', () => {
  it('retries a transient first failure once', () => {
    expect(shouldRetryUpdateError(JWT_EXPIRED, 1)).toBe(true)
    expect(shouldRetryUpdateError('HttpError: 500 Internal Server Error', 1)).toBe(true)
    expect(shouldRetryUpdateError('read ECONNRESET', 1)).toBe(true)
    expect(shouldRetryUpdateError('connect ETIMEDOUT 1.2.3.4:443', 1)).toBe(true)
    // electron-updater requests go through Electron's net module.
    expect(shouldRetryUpdateError('net::ERR_CONNECTION_RESET', 1)).toBe(true)
    expect(shouldRetryUpdateError('net::ERR_CONNECTION_TIMED_OUT', 1)).toBe(true)
    expect(shouldRetryUpdateError('Request timed out', 1)).toBe(true)
    expect(shouldRetryUpdateError(JWT_EXPIRED, 2)).toBe(false)
  })

  it('does not retry offline, missing-manifest or unknown errors', () => {
    expect(shouldRetryUpdateError('net::ERR_INTERNET_DISCONNECTED', 1)).toBe(false)
    expect(shouldRetryUpdateError('HttpError: 404 Not Found for latest-mac.yml', 1)).toBe(false)
    expect(shouldRetryUpdateError('signature verification failed', 1)).toBe(false)
  })
})
