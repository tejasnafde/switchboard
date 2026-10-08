import { describe, expect, it } from 'vitest'
import { ciScope } from '../../scripts/ci-scope.mjs'

describe('ciScope', () => {
  it('skips everything for a docs-only change', () => {
    expect(ciScope(['docs/plans/x.md', 'AGENTS.md', 'docs/mocks/landing.html'])).toEqual({
      code: false,
      visual: false,
    })
  })

  it('runs tests but not screenshots for Android, mobile and script changes', () => {
    expect(ciScope(['apps/android/app/build.gradle.kts'])).toEqual({ code: true, visual: false })
    expect(ciScope(['apps/mobile/src/lib/composer.ts'])).toEqual({ code: true, visual: false })
    expect(ciScope(['scripts/ci-scope.mjs'])).toEqual({ code: true, visual: false })
  })

  it('runs everything for a desktop source change, even beside docs', () => {
    expect(ciScope(['README.md', 'src/renderer/App.tsx'])).toEqual({ code: true, visual: true })
  })

  it('treats workflow files as code, since unit tests read them', () => {
    expect(ciScope(['.github/workflows/android-native-ci.yml']).code).toBe(true)
  })

  it('treats an unknown kind of file as code', () => {
    expect(ciScope(['some-new-config.toml']).code).toBe(true)
  })
})
