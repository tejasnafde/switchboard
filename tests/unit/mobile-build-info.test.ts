/**
 * The build stamp. An APK carries native code from one commit with OTA bundles
 * stacked on top, so the version alone does not say what is running.
 */
import { describe, it, expect } from 'vitest'
import { formatBuildStamp } from '../../apps/mobile/src/lib/buildInfo'

describe('formatBuildStamp', () => {
  it('names the version, channel and OTA bundle', () => {
    expect(
      formatBuildStamp({
        version: '0.2.0',
        channel: 'production',
        updateId: '019fbd3f-7eea-7327-a5e4-bf1f6fd98fae',
        isEmbedded: false,
      }),
    ).toBe('v0.2.0 · production · ota 019fbd3f')
  })

  it('says embedded when running the bundle inside the APK', () => {
    expect(
      formatBuildStamp({ version: '0.2.0', channel: 'production', updateId: 'x', isEmbedded: true }),
    ).toBe('v0.2.0 · production · embedded')
  })

  it('says embedded when there is no update id at all', () => {
    expect(formatBuildStamp({ version: '0.2.0', channel: null, updateId: null, isEmbedded: false })).toBe(
      'v0.2.0 · embedded',
    )
  })

  it('still produces a line when the version is unknown', () => {
    // Better a partial stamp than an empty footer that explains nothing.
    expect(formatBuildStamp({ version: null, channel: null, updateId: null, isEmbedded: true })).toBe(
      'version unknown · embedded',
    )
  })
})
