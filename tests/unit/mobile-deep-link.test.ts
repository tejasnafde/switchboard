/**
 * switchboard://settings on the Expo app, the same links Android's
 * SwitchboardDeepLinkContract.appRoute accepts.
 */
import { describe, it, expect } from 'vitest'
import { appLinkRoute } from '../../apps/mobile/src/lib/deep-link'

describe('appLinkRoute', () => {
  it('opens Settings for switchboard://settings and switchboard:///settings', () => {
    expect(appLinkRoute('settings')).toBe('Settings')
    expect(appLinkRoute('/settings')).toBe('Settings')
  })

  it('ignores a query, a fragment, an extra path and other names', () => {
    for (const path of ['settings?tab=1', 'settings#x', 'settings/', 'settings/push', 'Settings', '', 'thread/abc']) {
      expect(appLinkRoute(path)).toBeNull()
    }
  })
})
