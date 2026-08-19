import { describe, expect, it } from 'vitest'
import {
  requiresFeatureParityManifest,
  validateFeatureParityManifest,
} from '../../scripts/validate-feature-parity.mjs'

const completeManifest = {
  schemaVersion: 1,
  feature: 'thread-image-parity',
  summary: 'Keep image turns consistent across every Switchboard client.',
  surfaces: {
    desktop: { status: 'implemented', evidence: ['tests/unit/desktop-images.test.ts'] },
    reactNativeIos: { status: 'implemented', evidence: ['tests/unit/mobile-images.test.ts'] },
    nativeAndroid: {
      status: 'implemented',
      evidence: ['apps/android/app/src/test/ThreadImagesTest.kt'],
    },
    sharedBackendApi: { status: 'implemented', evidence: ['tests/unit/ipc-wire.test.ts'] },
    storageDataMigration: {
      status: 'not_applicable',
      reason: 'The wire payload changes without changing persisted records.',
    },
    updateRelease: {
      status: 'implemented',
      evidence: ['docs/releasing.md#mobile-upgrade-check'],
    },
  },
  verification: {
    automated: ['npm test -- tests/unit/mobile-images.test.ts'],
    hardware: ['Android production-signed upgrade preserves the saved thread.'],
    notExercised: [],
  },
}

describe('feature parity policy', () => {
  it('accepts a manifest that explicitly scopes every product surface', () => {
    expect(validateFeatureParityManifest(completeManifest)).toEqual([])
  })

  it('requires every product surface', () => {
    const manifest = structuredClone(completeManifest)
    delete (manifest.surfaces as Partial<typeof manifest.surfaces>).nativeAndroid

    expect(validateFeatureParityManifest(manifest)).toContain(
      'surfaces.nativeAndroid is required',
    )
  })

  it('requires a reason when a surface is not applicable', () => {
    const manifest = structuredClone(completeManifest)
    manifest.surfaces.storageDataMigration = {
      status: 'not_applicable',
      reason: '',
    }

    expect(validateFeatureParityManifest(manifest)).toContain(
      'surfaces.storageDataMigration.reason is required for not_applicable',
    )
  })

  it('requires a named flag and follow-up release for staged work', () => {
    const manifest = structuredClone(completeManifest)
    manifest.surfaces.nativeAndroid = {
      status: 'staged',
      evidence: [],
    } as never

    expect(validateFeatureParityManifest(manifest)).toEqual(
      expect.arrayContaining([
        'surfaces.nativeAndroid.flag is required for staged',
        'surfaces.nativeAndroid.followUpRelease is required for staged',
      ]),
    )
  })

  it('requires implementation evidence for completed surface work', () => {
    const manifest = structuredClone(completeManifest)
    manifest.surfaces.desktop = { status: 'implemented', evidence: [] }

    expect(validateFeatureParityManifest(manifest)).toContain(
      'surfaces.desktop.evidence must contain at least one item for implemented',
    )
  })

  it('gates behavior-bearing product paths but not tests and documentation alone', () => {
    expect(requiresFeatureParityManifest(['src/renderer/components/chat/ChatInput.tsx'])).toBe(true)
    expect(requiresFeatureParityManifest(['apps/mobile/src/screens/Thread.tsx'])).toBe(true)
    expect(requiresFeatureParityManifest(['apps/android/app/src/main/AndroidManifest.xml'])).toBe(true)
    expect(requiresFeatureParityManifest(['tests/unit/mobile-images.test.ts', 'docs/notes.md'])).toBe(
      false,
    )
  })
})
