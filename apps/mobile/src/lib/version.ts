/**
 * Version parsing and comparison for the APK update lane.
 *
 * Separate from selfUpdate.ts, which imports react-native and expo modules and
 * so cannot load in a node test. These rules decide whether a user is ever
 * offered a build, which makes them worth testing directly.
 */

/** Tag prefix written by .github/workflows/mobile-release.yml. */
const MOBILE_TAG_PREFIX = 'mobile-v'

/**
 * Split a version into numbers. Non-numeric junk reads as 0 rather than NaN, so
 * a malformed tag can never make the comparison throw. Length is not capped:
 * capping at three made a four-segment hotfix tag compare EQUAL to the release
 * it was fixing, so it would never have been offered.
 */
function toSegments(version: string): number[] {
  return version
    .trim()
    .replace(/^v/, '')
    .split('.')
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isNaN(parsed) ? 0 : parsed
    })
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
  // Missing segments read as 0, so "1.2" and "1.2.0" still compare equal.
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
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
