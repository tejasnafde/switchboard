/**
 * File naming convention for TS/JS under src/, apps/mobile/src/, tests/, e2e/,
 * scripts/ and videos/: PascalCase.tsx components, useThing hooks, kebab-case
 * for everything else. `node scripts/apply-naming-convention.mjs` fixes a
 * violation and rewrites every reference to it.
 */
import { describe, expect, it } from 'vitest'
import {
  expectedBasename,
  rewriteMentions,
  rewriteSpecifiers,
  toKebab,
  trackedFiles,
} from '../../scripts/apply-naming-convention.mjs'

describe('file naming convention', () => {
  // Unskipped by the generated rename commit.
  it.skip('every tracked file follows it', () => {
    const offenders = (trackedFiles() as string[])
      .map((f) => [f, expectedBasename(f)] as const)
      .filter(([, expected]) => expected)
      .map(([f, expected]) => `${f} -> ${expected}`)
    expect(offenders, 'run: node scripts/apply-naming-convention.mjs').toEqual([])
  })

  it('classifies names', () => {
    expect(expectedBasename('src/renderer/services/someHelper.ts')).toBe('some-helper.ts')
    expect(expectedBasename('tests/unit/someHelper.test.ts')).toBe('some-helper.test.ts')
    expect(expectedBasename('src/shared/Thing.ts')).toBe('thing.ts')
    expect(expectedBasename('src/renderer/components/ChatPanel.tsx')).toBeNull()
    expect(expectedBasename('apps/mobile/src/screens/__tests__/ThreadScreen.test.tsx')).toBeNull()
    expect(expectedBasename('src/renderer/hooks/useTerminal.ts')).toBeNull()
    expect(expectedBasename('src/shared/ws-protocol.ts')).toBeNull()
    expect(expectedBasename('src/main/index.ts')).toBeNull()
    expect(expectedBasename('apps/android/app/src/main/MainActivity.kt')).toBeNull()
    expect(expectedBasename('apps/mobile/App.tsx')).toBeNull()
    expect(toKebab('IAPTunnelCodec')).toBe('iap-tunnel-codec')
  })

  it('rewrites references to a renamed file and nothing else', () => {
    const oldPaths = new Map([['src/shared/fooBar.ts', 'src/shared/foo-bar.ts']])
    const code = [
      "import a from './fooBar'",
      "import b from '@shared/fooBar'",
      "vi.mock('../shared/fooBar.ts')",
      "import c from 'some-pkg/fooBar'",
      "import d from './fooBarBaz'",
    ].join('\n')
    const specifiers = rewriteSpecifiers(code, 'src/shared/x.ts', oldPaths)
    expect(rewriteMentions(specifiers, new Set(['fooBar']), true)).toBe(
      [
        "import a from './foo-bar'",
        "import b from '@shared/foo-bar'",
        "vi.mock('../shared/foo-bar.ts')",
        "import c from 'some-pkg/fooBar'",
        "import d from './fooBarBaz'",
      ].join('\n'),
    )
    expect(rewriteMentions('see `services/fooBar` and fooBar()', new Set(['fooBar']), false)).toBe(
      'see `services/foo-bar` and fooBar()',
    )
  })
})
