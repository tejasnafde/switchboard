/**
 * Version parsing for the APK update lane. Split from selfUpdate.ts, which
 * pulls in react-native and so cannot load in a node test.
 */

/** Tag prefix written by .github/workflows/mobile-release.yml. */
const MOBILE_TAG_PREFIX = 'mobile-v'

/**
 * Junk reads as 0, never NaN, so a malformed tag cannot make a comparison
 * throw. Length is uncapped: capping at three made a four-segment hotfix tag
 * compare EQUAL to the release it fixed, so it was never offered.
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
