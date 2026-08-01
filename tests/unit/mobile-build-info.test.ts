/**
 * The build stamp. An APK carries native code from one commit with OTA bundles
 * stacked on top, so the version alone does not say what is running.
 */
import { describe, it, expect } from 'vitest'
import { formatBuildStamp, type BuildFacts } from '../../apps/mobile/src/lib/buildInfo'

/** A production APK serving a downloaded bundle. */
const OTA: BuildFacts = {
  version: '0.3.0',
  channel: 'production',
  updateId: '019fbd3f-7eea-7327-a5e4-bf1f6fd98fae',
  isEmbedded: false,
  isEmergencyLaunch: false,
}

describe('formatBuildStamp', () => {
  it('names the version, channel and OTA bundle', () => {
    expect(formatBuildStamp(OTA)).toBe('v0.3.0 · production · ota 019fbd3f')
  })

  it('says embedded when running the bundle inside the APK', () => {
    // A production APK on its embedded bundle still reports a real update id,
    // so isEmbedded is the only thing that distinguishes this from an OTA.
    expect(formatBuildStamp({ ...OTA, isEmbedded: true })).toBe('v0.3.0 · production · embedded')
  })

  it('calls out a bundle that fell back after a failed update', () => {
    // Reporting a plain "embedded" here hides the failure. The user is running
    // code they were never served, which is exactly what needs saying.
    expect(formatBuildStamp({ ...OTA, isEmbedded: true, isEmergencyLaunch: true })).toBe(
      'v0.3.0 · production · embedded (update failed)',
    )
  })

  it('says dev bundle when expo-updates is disabled', () => {
    // No update id and nothing embedded means Metro is serving. Calling that
    // "embedded" was wrong in the one environment a developer sees most.
    expect(
      formatBuildStamp({ version: '0.3.0', channel: null, updateId: null, isEmbedded: false, isEmergencyLaunch: false }),
    ).toBe('v0.3.0 · dev bundle')
  })

  it('still produces a line when the version is unknown', () => {
    // Better a partial stamp than an empty footer that explains nothing.
    expect(
      formatBuildStamp({ version: null, channel: null, updateId: null, isEmbedded: true, isEmergencyLaunch: false }),
    ).toBe('version unknown · embedded')
  })
})
