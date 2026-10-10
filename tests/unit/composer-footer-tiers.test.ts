import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FOOTER_STEPS, footerTier, overflowedPriorities } from '../../src/renderer/components/chat/composer-footer-tiers'

const chatDir = resolve(__dirname, '../../src/renderer/components/chat')
const read = (name: string) => readFileSync(join(chatDir, name), 'utf8')

describe('footerTier', () => {
  it('steps down at each width the mock names', () => {
    expect(footerTier(1176)).toBe(0)
    expect(footerTier(760)).toBe(0)
    expect(footerTier(759)).toBe(1)
    expect(footerTier(680)).toBe(1)
    expect(footerTier(679)).toBe(2)
    expect(footerTier(630)).toBe(2) // the landing card
    expect(footerTier(599)).toBe(3)
    expect(footerTier(479)).toBe(4)
    expect(footerTier(399)).toBe(5)
    expect(footerTier(336)).toBe(5) // a 360 px pane
  })

  it('reads an element that is not laid out yet as full width', () => {
    expect(footerTier(0)).toBe(0)
    expect(footerTier(Number.NaN)).toBe(0)
  })
})

describe('overflowedPriorities', () => {
  it('moves mode first, then checkout, then effort', () => {
    expect(overflowedPriorities(0)).toEqual([])
    expect(overflowedPriorities(2)).toEqual([])
    expect(overflowedPriorities(3)).toEqual([5])
    expect(overflowedPriorities(4)).toEqual([4, 5])
    expect(overflowedPriorities(5)).toEqual([3, 4, 5])
  })

  it('never moves the project or the agent and model', () => {
    for (const tier of [0, 1, 2, 3, 4, 5] as const) {
      expect(overflowedPriorities(tier)).not.toContain(1)
      expect(overflowedPriorities(tier)).not.toContain(2)
    }
  })
})

// The container queries and the "..." menu read the same width; if one moves
// a step without the other, a control would show in both places or neither.
describe('footer container queries', () => {
  const footer = read('ComposerFooter.tsx')
  const sources = ['ComposerFooter.tsx', 'ComposerOverflowMenu.tsx', 'FooterChip.tsx', 'UnifiedProviderPicker.tsx', 'ChatLanding.tsx']
    .map(read).join('\n')

  it('use only the steps in FOOTER_STEPS', () => {
    const used = new Set([...sources.matchAll(/@max-\[(\d+)px\]\/footer:/g)].map((m) => Number(m[1])))
    expect([...used].sort()).toEqual(Object.values(FOOTER_STEPS).sort())
  })

  it('hide each control at the step that moves it into the menu', () => {
    expect(footer).toMatch(new RegExp(`@max-\\[${FOOTER_STEPS.overflowEffort}px\\]/footer:hidden">\\s*<EffortPicker`))
    expect(footer).toMatch(new RegExp(`@max-\\[${FOOTER_STEPS.overflowCheckout}px\\]/footer:hidden">\\s*\\{isDraft`))
    expect(footer).toMatch(new RegExp(`@max-\\[${FOOTER_STEPS.overflowMode}px\\]/footer:hidden">\\s*<ChipSelect\\s+label="Runtime mode"`))
    expect(read('ComposerOverflowMenu.tsx')).toContain(`@max-[${FOOTER_STEPS.overflowMode}px]/footer:inline-flex`)
  })

  it('shorten labels and the model chip at their steps', () => {
    expect(read('FooterChip.tsx')).toContain(`@max-[${FOOTER_STEPS.shortLabels}px]/footer:hidden`)
    expect(read('UnifiedProviderPicker.tsx')).toContain(`@max-[${FOOTER_STEPS.modelOnly}px]/footer:hidden`)
  })

  it('keep the footer on one row', () => {
    expect(footer).toContain('@container/footer')
    expect(footer).toContain('flex-nowrap')
    expect(footer).not.toContain('flex-wrap ')
  })
})
