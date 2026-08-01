/**
 * APK self-update version handling.
 *
 * The comparison decides whether a user is ever offered a build, so its edge
 * cases are the difference between shipping and silently stranding people.
 */
import { describe, it, expect } from 'vitest'
import { compareVersions, versionFromTag } from '../../apps/mobile/src/lib/version'

describe('compareVersions', () => {
  it('sees a newer patch, minor and major', () => {
    expect(compareVersions('0.2.1', '0.2.0')).toBe(true)
    expect(compareVersions('0.3.0', '0.2.9')).toBe(true)
    expect(compareVersions('1.0.0', '0.9.9')).toBe(true)
  })

  it('is false for equal or older', () => {
    expect(compareVersions('0.2.0', '0.2.0')).toBe(false)
    expect(compareVersions('0.1.9', '0.2.0')).toBe(false)
  })

  it('compares numerically, not lexicographically', () => {
    // The classic bug: as strings "1.10.0" < "1.9.0", stranding users forever.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(true)
    expect(compareVersions('0.2.10', '0.2.9')).toBe(true)
  })

  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(false)
    expect(compareVersions('1.2.0', '1.2')).toBe(false)
    expect(compareVersions('1.2.1', '1.2')).toBe(true)
  })

  it('sees a four-segment hotfix as newer than the release it fixes', () => {
    // Capping at three segments made these compare equal, so a hotfix would
    // never have been offered.
    expect(compareVersions('1.14.0.1', '1.14.0')).toBe(true)
    expect(compareVersions('1.14.0', '1.14.0.1')).toBe(false)
  })

  it('tolerates a leading v on either side', () => {
    expect(compareVersions('v0.3.0', '0.2.0')).toBe(true)
    expect(compareVersions('0.3.0', 'v0.2.0')).toBe(true)
  })

  it('does not throw or report an update for junk', () => {
    // A malformed tag must read as 0, never NaN - NaN comparisons are false in
    // both directions, which hides a real update rather than failing loudly.
    expect(compareVersions('not-a-version', '0.2.0')).toBe(false)
    expect(compareVersions('0.2.0', 'not-a-version')).toBe(true)
    expect(compareVersions('', '')).toBe(false)
  })
})

describe('versionFromTag', () => {
  it('reads the mobile tag namespace', () => {
    expect(versionFromTag('mobile-v0.2.0')).toBe('0.2.0')
  })

  it('reads the legacy bare tag', () => {
    expect(versionFromTag('v0.2.0')).toBe('0.2.0')
  })

  it('tolerates surrounding whitespace', () => {
    expect(versionFromTag('  mobile-v1.0.0 ')).toBe('1.0.0')
  })
})
