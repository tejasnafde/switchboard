import { describe, it, expect } from 'vitest'
import {
  UNKNOWN_RESET_TTL_MS,
  describeSpendBlock,
  findSpendBlock,
  isSpendBlockActive,
  pruneSpendBlocks,
  upsertSpendBlock,
  type SpendBlock,
} from '../../src/shared/spend-block'

const NOW = Date.parse('2026-07-31T18:00:00Z')

function block(overrides: Partial<SpendBlock> = {}): SpendBlock {
  return {
    instanceId: 'claude-code-akshaya-933v',
    model: 'claude-fable-5',
    reason: 'org_level_disabled_until',
    scope: 'org' as const,
    resetsAtMs: Date.parse('2026-08-01T00:00:00Z'),
    recordedAtMs: NOW,
    ...overrides,
  }
}

describe('isSpendBlockActive', () => {
  it('is active before the known reset and expired after it', () => {
    const b = block()
    expect(isSpendBlockActive(b, NOW)).toBe(true)
    expect(isSpendBlockActive(b, Date.parse('2026-08-01T00:00:01Z'))).toBe(false)
  })

  it('falls back to a bounded TTL when the reset is unknown', () => {
    // An unbounded block would warn forever, which is worse than not warning:
    // an admin can raise the org limit at any time.
    const b = block({ resetsAtMs: null })
    expect(isSpendBlockActive(b, NOW + UNKNOWN_RESET_TTL_MS - 1)).toBe(true)
    expect(isSpendBlockActive(b, NOW + UNKNOWN_RESET_TTL_MS)).toBe(false)
  })
})

describe('findSpendBlock', () => {
  const blocks = [block()]

  it('matches the same instance and model', () => {
    expect(findSpendBlock(blocks, 'claude-code-akshaya-933v', 'claude-fable-5', NOW)).not.toBeNull()
  })

  it('does NOT match a different model on the same seat', () => {
    // Proven on 2026-07-31: opus/sonnet/haiku all worked on the same profile at
    // the moment Fable was refused. Warning about them would be wrong.
    for (const m of ['claude-opus-4-7', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
      expect(findSpendBlock(blocks, 'claude-code-akshaya-933v', m, NOW)).toBeNull()
    }
  })

  it('does NOT match a different instance on the same model', () => {
    // tech-team and backend ran Fable fine, so the block is not org-global here.
    expect(findSpendBlock(blocks, 'claude-code-default', 'claude-fable-5', NOW)).toBeNull()
  })

  it('returns null once the block has expired', () => {
    expect(findSpendBlock(blocks, 'claude-code-akshaya-933v', 'claude-fable-5', Date.parse('2026-08-02T00:00:00Z'))).toBeNull()
  })

  it('returns null when no model is known yet', () => {
    expect(findSpendBlock(blocks, 'claude-code-akshaya-933v', null, NOW)).toBeNull()
  })

  it('treats a null instance as its own key, not a wildcard', () => {
    expect(findSpendBlock([block({ instanceId: null })], null, 'claude-fable-5', NOW)).not.toBeNull()
    expect(findSpendBlock([block({ instanceId: null })], 'claude-code-default', 'claude-fable-5', NOW)).toBeNull()
  })
})

describe('upsertSpendBlock', () => {
  it('replaces the entry for the same pair instead of duplicating it', () => {
    const first = block({ reason: 'out_of_credits' })
    const next = upsertSpendBlock([first], block({ reason: 'org_level_disabled_until' }), NOW)
    expect(next).toHaveLength(1)
    expect(next[0].reason).toBe('org_level_disabled_until')
  })

  it('keeps entries for other pairs', () => {
    const other = block({ instanceId: 'claude-code-tejas', model: 'claude-fable-5' })
    const next = upsertSpendBlock([other], block(), NOW)
    expect(next).toHaveLength(2)
  })

  it('drops expired entries on write so the list cannot grow forever', () => {
    const stale = block({ instanceId: 'old', resetsAtMs: Date.parse('2026-07-01T00:00:00Z') })
    const next = upsertSpendBlock([stale], block(), NOW)
    expect(next.map((b) => b.instanceId)).toEqual(['claude-code-akshaya-933v'])
  })
})

describe('pruneSpendBlocks', () => {
  it('keeps only active entries', () => {
    const kept = block()
    const gone = block({ instanceId: 'x', resetsAtMs: Date.parse('2026-07-01T00:00:00Z') })
    expect(pruneSpendBlocks([kept, gone], NOW)).toEqual([kept])
  })
})

describe('describeSpendBlock', () => {
  const text = describeSpendBlock(block())

  it('names the model, which the picker previously hid behind "Default"', () => {
    expect(text).toContain('claude-fable-5')
  })

  it('names covered models the user can switch to', () => {
    expect(text).toMatch(/opus/)
    expect(text).toMatch(/sonnet/)
  })

  it('says profile rotation will not help', () => {
    expect(text).toMatch(/switching profile .* will not help/i)
  })

  it('carries the raw reason and mentions the admin route', () => {
    expect(text).toContain('org_level_disabled_until')
    expect(text).toMatch(/admin/i)
  })

  it('omits the reason cleanly when there is none', () => {
    const t = describeSpendBlock(block({ reason: null }))
    expect(t).not.toContain('()')
    expect(t).not.toMatch(/ {2}/)
  })

  it('never emits an em dash', () => {
    expect(text).not.toContain('—')
  })
})

describe('describeSpendBlock: scope-aware advice', () => {
  it('only claims profile rotation is useless for an ORG-wide cap', () => {
    // Found in review: the chat error correctly offers another instance for an
    // account-scoped block, so a blanket "rotation will not help" here would
    // contradict it - the exact class of bug this change exists to fix.
    expect(describeSpendBlock(block({ scope: 'org' }))).toMatch(/will not help/i)
    expect(describeSpendBlock(block({ scope: 'account' }))).not.toMatch(/will not help/i)
  })

  it('offers another profile when the block is account-scoped', () => {
    expect(describeSpendBlock(block({ scope: 'account', reason: 'out_of_credits' })))
      .toMatch(/switch to another profile/i)
  })

  it('asks for extra usage to be enabled when it was never provisioned', () => {
    expect(describeSpendBlock(block({ scope: 'not-provisioned', reason: 'overage_not_provisioned' })))
      .toMatch(/enable extra usage/i)
  })

  it('defaults to the org wording when scope is absent on a persisted block', () => {
    expect(describeSpendBlock(block({ scope: undefined }))).toMatch(/will not help/i)
  })

  it('names the model in every scope', () => {
    for (const scope of ['org', 'account', 'not-provisioned', undefined] as const) {
      expect(describeSpendBlock(block({ scope }))).toContain('claude-fable-5')
    }
  })
})
