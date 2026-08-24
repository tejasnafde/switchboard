import { describe, expect, it } from 'vitest'
import { terminalHydrationTargets } from '../../src/renderer/hooks/useTerminalLifecycle'

describe('dual-chat terminal lifecycle', () => {
  it('hydrates a newly displayed secondary session even before it becomes primary', () => {
    expect(terminalHydrationTargets(
      ['primary', 'secondary'],
      new Set(['primary']),
      () => false,
    )).toEqual(['secondary'])
  })

  it('marks already-restored layouts hydrated without spawning duplicates', () => {
    const hydrated = new Set<string>()
    expect(terminalHydrationTargets(['primary', 'secondary'], hydrated, (id) => id === 'secondary')).toEqual(['primary'])
    expect(hydrated).toContain('secondary')
  })
})
