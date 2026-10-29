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
import { secretAnswerSecondsBucket, secretExtendCountBucket } from '@shared/agent-secret-request'

const ctx: AnalyticsContext = {
  enabled: true,
  environment: 'production',
  platform: 'macos',
  installId: '4f1c2d3e-0000-4000-8000-000000000001',
}

describe('buildAnalyticsEnvelope', () => {
  it('produces the exact envelope the worker validates', () => {
    expect(
      buildAnalyticsEnvelope(ctx, 'app_launched', {
        arch: 'arm64',
        translated: 'false',
        app_version: '0.8.55',
      }),
    ).toEqual({
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
      'authority',
      'environment',
      'event',
      'event_version',
      'install_id',
      'platform',
      'product',
      'properties',
      'surface',
    ])
    expect(envelope.properties).toEqual({})
  })
})

describe('whitelistAnalyticsProperties', () => {
  it('drops properties the event does not declare', () => {
    expect(
      whitelistAnalyticsProperties('session_started', {
        provider: 'codex',
        hostname: 'my-mac',
        cwd: '/Users/me/project',
        arch: 'arm64',
      }),
    ).toEqual({ provider: 'codex' })
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
    expect(whitelistAnalyticsProperties('app_launched', { app_version: '1.2.3-beta.1' })).toEqual({
      app_version: '1.2.3-beta.1',
    })
    expect(whitelistAnalyticsProperties('app_launched', { app_version: 'dev' })).toEqual({})
    expect(whitelistAnalyticsProperties('app_launched', { app_version: '1.2.3' + 'x'.repeat(40) })).toEqual({})
  })

  it('keeps every declared crash kind', () => {
    for (const kind of ['renderer_gone', 'child_process_gone', 'uncaught']) {
      expect(whitelistAnalyticsProperties('crash_reported', { kind })).toEqual({ kind })
    }
  })
})

describe('secret request events', () => {
  it.each([
    ['secret_request.opened', { agentKind: 'gemini', ttlBucket: '4h', remote: 'true' }],
    ['secret_request.extended', { count: 'more' }],
    ['secret_request.answered', { outcome: 'declined', secondsBucket: '2m_10m' }],
    ['secret_request.closed', { outcome: 'withdrawn' }],
    ['secret_request.refused', { reason: 'cap' }],
    ['secret_request.masked', { where: 'diff' }],
  ] as const)('%s keeps its closed-list properties', (event, properties) => {
    expect(isAnalyticsEventName(event)).toBe(true)
    expect(whitelistAnalyticsProperties(event, properties)).toEqual(properties)
  })

  it('drops values off the closed list and any name, title, instructions, value or length', () => {
    expect(
      whitelistAnalyticsProperties('secret_request.opened', {
        agentKind: 'claude',
        ttlBucket: '48h',
        remote: true,
        name: 'TAILSCALE_AUTHKEY',
        title: 'Tailscale auth key',
        instructions: 'Make a key',
        value: 'tskey-123',
        length: '9',
      }),
    ).toEqual({ agentKind: 'claude' })
    expect(whitelistAnalyticsProperties('secret_request.extended', { count: '4' })).toEqual({})
    expect(
      whitelistAnalyticsProperties('secret_request.answered', { outcome: 'expired', secondsBucket: '42' }),
    ).toEqual({})
    expect(whitelistAnalyticsProperties('secret_request.closed', { outcome: 'saved' })).toEqual({})
    expect(whitelistAnalyticsProperties('secret_request.refused', { reason: 'archived' })).toEqual({})
    expect(whitelistAnalyticsProperties('secret_request.masked', { where: 'log' })).toEqual({})
  })

  it('buckets the answer time and the extend count', () => {
    expect(
      [0, 29_999, 30_000, 119_999, 120_000, 599_999, 600_000, 3_599_999, 3_600_000].map(secretAnswerSecondsBucket),
    ).toEqual(['under_30s', 'under_30s', '30s_2m', '30s_2m', '2m_10m', '2m_10m', '10m_1h', '10m_1h', 'over_1h'])
    expect([1, 2, 3, 4, 40].map(secretExtendCountBucket)).toEqual(['1', '2', '3', 'more', 'more'])
  })

  it('the renderer cannot report them', () => {
    for (const event of RENDERER_ANALYTICS_EVENTS) expect(event.startsWith('secret_request.')).toBe(false)
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
