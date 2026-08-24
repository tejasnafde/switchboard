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

  it('rejects nonexistent and surface-inappropriate evidence when validating a repository', () => {
    const missing = structuredClone(completeManifest)
    missing.surfaces.desktop = {
      status: 'implemented',
      evidence: ['src/renderer/does-not-exist.tsx'],
    }
    expect(validateFeatureParityManifest(missing, { repoRoot: process.cwd() })).toContain(
      'surfaces.desktop.evidence path does not exist: src/renderer/does-not-exist.tsx',
    )

    const unrelated = structuredClone(completeManifest)
    unrelated.surfaces.nativeAndroid = {
      status: 'implemented',
      evidence: ['src/renderer/components/chat/ChatPanel.tsx'],
    }
    expect(validateFeatureParityManifest(unrelated, { repoRoot: process.cwd() })).toContain(
      'surfaces.nativeAndroid.evidence is outside the native Android surface: src/renderer/components/chat/ChatPanel.tsx',
    )
  })

  it('accepts packaged migration rehearsals and artifact hooks as release evidence', () => {
    const manifest = structuredClone(completeManifest)
    manifest.surfaces.desktop = {
      status: 'implemented',
      evidence: ['tests/unit/desktop-image-send-contract.test.ts'],
    }
    manifest.surfaces.reactNativeIos = {
      status: 'implemented',
      evidence: ['tests/unit/mobile-outbox.test.ts'],
    }
    manifest.surfaces.nativeAndroid = {
      status: 'implemented',
      evidence: [
        'apps/android/app/src/test/java/app/switchboard/mobile/data/outbox/OutboxCoordinatorTest.kt',
      ],
    }
    manifest.surfaces.sharedBackendApi = {
      status: 'implemented',
      evidence: ['tests/unit/provider-switch-ws.test.ts'],
    }
    manifest.surfaces.storageDataMigration = {
      status: 'implemented',
      evidence: ['e2e/v0835-packaged-upgrade.e2e.mjs'],
    }
    manifest.surfaces.updateRelease = {
      status: 'implemented',
      evidence: ['build/artifactBuildCompleted.js'],
    }

    expect(validateFeatureParityManifest(manifest, { repoRoot: process.cwd() })).toEqual([])
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
