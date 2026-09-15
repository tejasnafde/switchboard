import { describe, it, expect } from 'vitest'
import {
  ANALYTICS_ENDPOINT,
  RENDERER_ANALYTICS_EVENTS,
  analyticsPlatformFor,
  buildAnalyticsEnvelope,
  isAnalyticsEventName,
  whitelistAnalyticsProperties,
  type AnalyticsContext,
} from '@shared/analytics-envelope'

const ctx: AnalyticsContext = {
  enabled: true,
  environment: 'production',
  platform: 'macos',
  installId: '4f1c2d3e-0000-4000-8000-000000000001',
}

describe('buildAnalyticsEnvelope', () => {
  it('produces the exact envelope the worker validates', () => {
    expect(buildAnalyticsEnvelope(ctx, 'app_launched', {
      arch: 'arm64',
      translated: 'false',
      app_version: '0.8.55',
    })).toEqual({
      event: 'app_launched',
      event_version: 1,
      product: 'switchboard',
      surface: 'desktop',
      environment: 'production',
      authority: 'client',
      platform: 'macos',
      install_id: '4f1c2d3e-0000-4000-8000-000000000001',
      properties: { arch: 'arm64', translated: 'false', app_version: '0.8.55' },
    })
  })

  it('returns null when the user turned analytics off', () => {
    expect(buildAnalyticsEnvelope({ ...ctx, enabled: false }, 'session_started', { provider: 'claude' })).toBeNull()
  })

  it('returns null outside production, mirroring the browser client', () => {
    expect(buildAnalyticsEnvelope({ ...ctx, environment: 'development' }, 'app_launched')).toBeNull()
  })

  it('returns null on a platform the worker does not list', () => {
    expect(buildAnalyticsEnvelope({ ...ctx, platform: null }, 'app_launched')).toBeNull()
  })

  it('sends only the install id as identifier - no other top-level keys', () => {
    const envelope = buildAnalyticsEnvelope(ctx, 'tour_completed')!
    expect(Object.keys(envelope).sort()).toEqual([
      'authority', 'environment', 'event', 'event_version', 'install_id', 'platform', 'product', 'properties', 'surface',
    ])
    expect(envelope.properties).toEqual({})
  })
})

describe('whitelistAnalyticsProperties', () => {
  it('drops properties the event does not declare', () => {
    expect(whitelistAnalyticsProperties('session_started', {
      provider: 'codex',
      hostname: 'my-mac',
      cwd: '/Users/me/project',
      arch: 'arm64',
    })).toEqual({ provider: 'codex' })
  })

  it('drops enum values the worker would reject', () => {
    expect(whitelistAnalyticsProperties('session_started', { provider: 'gemini' })).toEqual({})
    expect(whitelistAnalyticsProperties('crash_reported', { kind: 'oom' })).toEqual({})
    expect(whitelistAnalyticsProperties('app_launched', { arch: 'ia32', translated: 'yes' })).toEqual({})
  })

  it('drops non-string values', () => {
    expect(whitelistAnalyticsProperties('app_launched', { translated: false, arch: ['arm64'] })).toEqual({})
  })

  it('accepts app_version only as a dotted semver-looking string within the length cap', () => {
    expect(whitelistAnalyticsProperties('app_launched', { app_version: '0.8.55' })).toEqual({ app_version: '0.8.55' })
    expect(whitelistAnalyticsProperties('app_launched', { app_version: '1.2.3-beta.1' })).toEqual({ app_version: '1.2.3-beta.1' })
    expect(whitelistAnalyticsProperties('app_launched', { app_version: 'dev' })).toEqual({})
    expect(whitelistAnalyticsProperties('app_launched', { app_version: '1.2.3' + 'x'.repeat(40) })).toEqual({})
  })

  it('keeps every declared crash kind', () => {
    for (const kind of ['renderer_gone', 'child_process_gone', 'uncaught']) {
      expect(whitelistAnalyticsProperties('crash_reported', { kind })).toEqual({ kind })
    }
  })
})

describe('event name guards', () => {
  it('only the tour outcomes may come from the renderer', () => {
    expect([...RENDERER_ANALYTICS_EVENTS].sort()).toEqual(['tour_completed', 'tour_skipped'])
  })

  it('isAnalyticsEventName rejects unknown names and prototype keys', () => {
    expect(isAnalyticsEventName('app_launched')).toBe(true)
    expect(isAnalyticsEventName('page_view')).toBe(false)
    expect(isAnalyticsEventName('toString')).toBe(false)
    expect(isAnalyticsEventName(42)).toBe(false)
  })

  it('maps process.platform to the worker platform names', () => {
    expect(analyticsPlatformFor('darwin')).toBe('macos')
    expect(analyticsPlatformFor('win32')).toBe('windows')
    expect(analyticsPlatformFor('linux')).toBeNull()
  })

  it('targets the tn07 collector', () => {
    expect(ANALYTICS_ENDPOINT).toBe('https://analytics.tn07.dev/v1/events')
  })
})
