/**
 * Self-update over GitHub Releases (Android sideload lane).
 *
 * Switchboard mobile is not on the Play Store, so the APK is published as a
 * GitHub Release asset by `.github/workflows/mobile-release.yml` and the app
 * updates itself: read the latest release, compare its tag to the running
 * binary's version, download the `.apk` into the cache dir, and hand it to
 * Android's package installer. This lane is for NATIVE changes (new native
 * module, permission, SDK bump). JS-only changes go out over the OTA lane in
 * `otaUpdate.ts`, which does not require the user to tap through an install.
 *
 * The first install is always manual: the user has to sideload one APK and
 * grant "install unknown apps" before this code can take over.
 *
 * Why `expo-file-system/legacy` and not the modern `File`/`Directory` API:
 * in SDK 57 the modern API has no `getContentUriAsync`, and that call is not
 * optional here. Android 7+ blocks `file://` URIs crossing a process boundary
 * (`FileUriExposedException`), so the package installer can only read the APK
 * through a FileProvider `content://` URI. `getContentUriAsync` plus
 * `downloadAsync` both still live in the legacy module, so this file uses it
 * deliberately rather than by inertia. Revisit when the modern API grows a
 * content-URI equivalent.
 */
import { Platform } from 'react-native'
import * as Application from 'expo-application'
import * as FileSystem from 'expo-file-system/legacy'
import * as IntentLauncher from 'expo-intent-launcher'
import { createLogger } from '@shared/logger'

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

/** Tag prefix written by .github/workflows/mobile-release.yml. */
const MOBILE_TAG_PREFIX = 'mobile-v'

/** major.minor.patch. Anything past the third segment is ignored. */
const SEGMENT_COUNT = 3

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
// Pure version comparison - no network, no native modules. See selfCheck().
// ---------------------------------------------------------------------------

/**
 * Split a version into exactly three numbers. Missing segments read as 0 so
 * "1.2" and "1.2.0" compare equal, and non-numeric junk reads as 0 rather
 * than NaN so a malformed tag can never make the comparison throw.
 */
function toSegments(version: string): number[] {
  const parts = version.trim().replace(/^v/, '').split('.')
  const out: number[] = []
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    const parsed = Number.parseInt(parts[i] ?? '', 10)
    out.push(Number.isNaN(parsed) ? 0 : parsed)
  }
  return out
}

/**
 * True when `latest` is strictly newer than `current`.
 *
 * Compared per segment as NUMBERS, never as strings: a lexicographic compare
 * says "1.10.0" < "1.9.0" because "1" < "9", which is the classic bug that
 * strands users on the previous minor forever.
 */
export function compareVersions(latest: string, current: string): boolean {
  const a = toSegments(latest)
  const b = toSegments(current)
  for (let i = 0; i < SEGMENT_COUNT; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/** `mobile-v0.2.0` and the legacy `v0.2.0` both read as `0.2.0`. */
export function versionFromTag(tag: string): string {
  const trimmed = tag.trim()
  const withoutPrefix = trimmed.startsWith(MOBILE_TAG_PREFIX)
    ? trimmed.slice(MOBILE_TAG_PREFIX.length)
    : trimmed
  return withoutPrefix.replace(/^v/, '')
}

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

  try {
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
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

  await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
    data: contentUri,
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  })
}

// ---------------------------------------------------------------------------
// Offline self-check
// ---------------------------------------------------------------------------

/**
 * Offline assertion of the version comparison and release picking - no network,
 * no native modules.
 * There is no test runner in apps/mobile yet, so run it from the app when
 * touching this file: add `void selfCheck()` inside the useEffect in App.tsx,
 * reload, and read the console. Returns true when all assertions hold and logs
 * each failure.
 */
export function selfCheck(): boolean {
  const failures: string[] = []
  const expect = (label: string, actual: unknown, wanted: unknown) => {
    if (actual !== wanted) failures.push(`${label}: expected ${String(wanted)}, got ${String(actual)}`)
  }

  expect('1.2.0 is newer than 1.1.9', compareVersions('1.2.0', '1.1.9'), true)
  // The whole reason this is a numeric compare: "10" sorts before "9" as a string.
  expect('1.10.0 is newer than 1.9.0', compareVersions('1.10.0', '1.9.0'), true)
  expect('1.9.0 is not newer than 1.10.0', compareVersions('1.9.0', '1.10.0'), false)
  expect('0.2.0 is newer than 0.1.99', compareVersions('0.2.0', '0.1.99'), true)
  expect('2.0.0 is newer than 1.99.99', compareVersions('2.0.0', '1.99.99'), true)

  expect('equal versions are not newer', compareVersions('1.2.3', '1.2.3'), false)
  expect('older patch is not newer', compareVersions('1.2.2', '1.2.3'), false)
  expect('older minor is not newer', compareVersions('1.1.0', '1.2.0'), false)
  expect('older major is not newer', compareVersions('0.9.9', '1.0.0'), false)

  // Missing segments read as 0, so a two-segment tag is not mistaken for newer.
  expect('1.2 equals 1.2.0', compareVersions('1.2', '1.2.0'), false)
  expect('1.2.0 does not beat 1.2', compareVersions('1.2.0', '1.2'), false)
  expect('1.2.1 beats 1.2', compareVersions('1.2.1', '1.2'), true)
  expect('1 equals 1.0.0', compareVersions('1', '1.0.0'), false)

  // A leading v (a raw tag_name) must not change the answer.
  expect('a v prefix is stripped', compareVersions('v1.3.0', '1.2.0'), true)

  // Junk must not throw and must not read as newer than a real version.
  expect('empty string is not newer', compareVersions('', '1.0.0'), false)
  expect('garbage is not newer', compareVersions('not-a-version', '1.0.0'), false)
  expect('a real version beats garbage', compareVersions('1.0.0', 'not-a-version'), true)
  expect('prerelease suffix is ignored', compareVersions('1.2.0-beta.1', '1.2.0'), false)
  expect('prerelease suffix still compares by segment', compareVersions('1.3.0-beta.1', '1.2.0'), true)

  expect('mobile tag prefix is stripped', versionFromTag('mobile-v0.2.0'), '0.2.0')
  expect('a bare v tag is stripped', versionFromTag('v0.2.0'), '0.2.0')
  expect('an unprefixed tag passes through', versionFromTag('0.2.0'), '0.2.0')
  expect('an empty tag stays empty', versionFromTag(''), '')

  // The desktop app releases into the same repo under v* with no apk attached,
  // so the picker has to walk past those to find the mobile one.
  const desktopRelease: Release = {
    tag_name: 'v0.7.25',
    assets: [{ name: 'Switchboard-0.7.25-arm64.dmg', browser_download_url: 'https://example.test/dmg' }],
  }
  const mobileRelease: Release = {
    tag_name: 'mobile-v0.2.0',
    assets: [{ name: 'switchboard-0.2.0.apk', browser_download_url: 'https://example.test/apk' }],
  }

  expect('a desktop-only release yields nothing', pickApkRelease([desktopRelease]), null)
  expect(
    'the apk release is found past desktop releases',
    pickApkRelease([desktopRelease, mobileRelease])?.version,
    '0.2.0',
  )
  expect(
    'the apk url comes from the apk asset',
    pickApkRelease([desktopRelease, mobileRelease])?.apkUrl,
    'https://example.test/apk',
  )
  expect('an empty release list yields nothing', pickApkRelease([]), null)
  expect('drafts are skipped', pickApkRelease([{ ...mobileRelease, draft: true }]), null)
  expect('prereleases are skipped', pickApkRelease([{ ...mobileRelease, prerelease: true }]), null)
  expect(
    'the newest apk release wins over an older one',
    pickApkRelease([mobileRelease, { tag_name: 'mobile-v0.1.0', assets: [{ name: 'a.apk', browser_download_url: 'u' }] }])
      ?.version,
    '0.2.0',
  )

  if (failures.length > 0) {
    for (const failure of failures) log.error(`selfCheck: ${failure}`)
    return false
  }
  log.info('selfCheck: all version-comparison and release-picking assertions hold')
  return true
}
