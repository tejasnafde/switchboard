/**
 * APK self-update off GitHub Releases, for native changes an OTA cannot carry.
 *
 * Reads the releases LIST, not /releases/latest: this repo also publishes the
 * Electron app under `v*` tags, so "latest" is usually a desktop release with no
 * .apk attached. Mobile tags are `mobile-v<version>`.
 *
 * Uses expo-file-system/legacy because downloadAsync and getContentUriAsync live
 * there in SDK 57; the new File API has no getContentUriAsync, and the package
 * installer cannot read file:// URIs on Android 7+.
 */
import { Platform } from 'react-native'
import * as Application from 'expo-application'
import * as FileSystem from 'expo-file-system/legacy'
import * as IntentLauncher from 'expo-intent-launcher'
import { createLogger } from '@shared/logger'
import { compareVersions, versionFromTag } from './version'

const log = createLogger('mobile:self-update')

/**
 * The releases LIST, not `/releases/latest`.
 *
 * This repo publishes the Electron desktop app under `v*` tags too, and it
 * releases far more often than mobile does, so `/releases/latest` would almost
 * always hand back a desktop release with no `.apk` attached and mobile would
 * never see its own update. Scanning the list for the newest release that
 * actually carries an APK is what makes a shared repo work. Mobile releases are
 * tagged `mobile-v<version>` to keep the two namespaces from colliding.
 */
const RELEASES_API = 'https://api.github.com/repos/tejasnafde/switchboard/releases?per_page=30'

/** Give up on the releases API rather than delaying startup indefinitely. */
const RELEASES_TIMEOUT_MS = 8000

/**
 * FLAG_GRANT_READ_URI_PERMISSION. The installer runs as a different process, so
 * without this flag it cannot read our `content://` URI and the install screen
 * fails with a parse error instead of a permission error.
 */
const FLAG_GRANT_READ_URI_PERMISSION = 1

export type ApkUpdate = {
  version: string
  apkUrl: string
}

type ReleaseAsset = {
  name?: string
  browser_download_url?: string
}

type Release = {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------


/**
 * The newest shipped release that actually carries an APK.
 *
 * GitHub returns releases newest-first, so the first match wins. Drafts and
 * prereleases are skipped: a draft is not published yet, and a prerelease is
 * opt-in, not something to push at every user automatically.
 */
export function pickApkRelease(releases: Release[]): { version: string; apkUrl: string } | null {
  for (const release of releases) {
    if (release.draft || release.prerelease) continue

    const version = versionFromTag(release.tag_name ?? '')
    if (!version) continue

    const apkUrl = (release.assets ?? []).find((asset) => asset.name?.endsWith('.apk'))?.browser_download_url
    if (apkUrl) return { version, apkUrl }
  }
  return null
}

// ---------------------------------------------------------------------------
// Update check + install
// ---------------------------------------------------------------------------

/**
 * Ask GitHub for the newest APK release and return it only if it beats the
 * running binary. Returns null for every other outcome, including every
 * failure: a dead network or a rate-limited API must never keep the app from
 * starting. Failures are logged, never swallowed.
 */
export async function checkForApkUpdate(): Promise<ApkUpdate | null> {
  // iOS cannot sideload an APK at all, so there is nothing to check for.
  if (Platform.OS !== 'android') return null

  // A launch-time check must not hang on a stalled connection.
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), RELEASES_TIMEOUT_MS)
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: abort.signal,
    })
    if (!res.ok) {
      // 403 here is almost always the unauthenticated rate limit (60/hour/IP).
      log.warn('releases API rejected the request', { status: res.status, statusText: res.statusText })
      return null
    }

    const body = (await res.json()) as unknown
    if (!Array.isArray(body)) {
      log.warn('releases API returned a non-array body')
      return null
    }

    const candidate = pickApkRelease(body as Release[])
    if (!candidate) {
      // Expected before the first mobile release is published.
      log.info('no published release carries an apk asset')
      return null
    }

    const current = Application.nativeApplicationVersion ?? '0.0.0'
    if (!compareVersions(candidate.version, current)) {
      log.debug('already on the latest apk', { current, latest: candidate.version })
      return null
    }

    log.info('apk update available', { current, version: candidate.version })
    return candidate
  } catch (err) {
    log.warn('apk update check failed', err)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Download the APK and open Android's install screen for it.
 *
 * Throws on failure so the caller can show the reason. The user still has to
 * confirm the install: we hand off an intent, we do not install silently.
 */
export async function downloadAndInstall(update: ApkUpdate): Promise<void> {
  const dest = `${FileSystem.cacheDirectory}switchboard-${update.version}.apk`

  const result = await FileSystem.downloadAsync(update.apkUrl, dest)
  if (result.status !== 200) {
    log.error('apk download failed', { status: result.status, version: update.version })
    throw new Error(`Download failed (HTTP ${result.status})`)
  }

  // file:// is unreadable to the installer on Android 7+; FileProvider gives us
  // a content:// URI it can actually open. See the docblock at the top.
  const contentUri = await FileSystem.getContentUriAsync(result.uri)
  log.info('handing apk to the package installer', { version: update.version })

  // ACTION_VIEW with the package-archive MIME type, not ACTION_INSTALL_PACKAGE:
  // that one is deprecated since API 29 and some OEM installers reject it.
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  })
}
