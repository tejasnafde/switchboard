import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { overflowedItems, TOOLBAR_STEPS, toolbarTier } from '../../src/renderer/components/ui/toolbar-steps'

const componentsDir = resolve(__dirname, '../../src/renderer/components')
const read = (name: string) => readFileSync(join(componentsDir, name), 'utf8')

describe('toolbarTier', () => {
  it('steps down at each width the mock names', () => {
    expect(toolbarTier(1176)).toBe(0)
    expect(toolbarTier(760)).toBe(0)
    expect(toolbarTier(759)).toBe(1)
    expect(toolbarTier(680)).toBe(1)
    expect(toolbarTier(679)).toBe(2)
    expect(toolbarTier(630)).toBe(2) // the landing card
    expect(toolbarTier(599)).toBe(3)
    expect(toolbarTier(479)).toBe(4)
    expect(toolbarTier(399)).toBe(5)
    expect(toolbarTier(336)).toBe(5) // a 360 px pane
  })

  it('reads an element that is not laid out yet as full width', () => {
    expect(toolbarTier(0)).toBe(0)
    expect(toolbarTier(Number.NaN)).toBe(0)
  })
})

describe('overflowedItems', () => {
  const footer = [
    { key: 'effort', hideBelow: 400 },
    { key: 'checkout', hideBelow: 480 },
    { key: 'mode', hideBelow: 600 },
  ] as const
  const keys = (tier: number) => overflowedItems(footer, tier).map((item) => item.key)

  it('moves mode first, then checkout, then effort, keeping the given order', () => {
    expect(keys(0)).toEqual([])
    expect(keys(2)).toEqual([])
    expect(keys(3)).toEqual(['mode'])
    expect(keys(4)).toEqual(['checkout', 'mode'])
    expect(keys(5)).toEqual(['effort', 'checkout', 'mode'])
  })
})

// The container queries and the "..." menu read the same width; if one moves
// a step without the other, a control would show in both places or neither.
describe('toolbar container queries', () => {
  const footer = read('chat/ComposerFooter.tsx')
  const toolbar = read('ui/toolbar.tsx')
  const sources = [
    footer,
    toolbar,
    read('ui/chip.tsx'),
    read('chat/UnifiedProviderPicker.tsx'),
    read('chat/ChatLanding.tsx'),
  ].join('\n')

  it('use only the steps in TOOLBAR_STEPS, and every one of them', () => {
    const used = new Set([...sources.matchAll(/@max-\[(\d+)px\]\/toolbar:/g)].map((m) => Number(m[1])))
    expect([...used].sort()).toEqual([...TOOLBAR_STEPS].sort())
  })

  it('hide each footer control at the step its "..." entry names', () => {
    for (const [step, marker] of [
      [400, '<EffortPicker'],
      [480, '{isDraft'],
      [600, '<ChipSelect\\s+label="Runtime mode"'],
    ] as const) {
      expect(footer).toMatch(new RegExp(`<ToolbarItem hideBelow=\\{${step}\\}>\\s*${marker}`))
    }
    expect(footer).toMatch(/key: 'effort',\s*hideBelow: 400/)
    expect(footer).toMatch(/withStep\([^\n]*, 480\)/)
    expect(footer).toMatch(/key: 'mode',\s*hideBelow: 600/)
    expect(footer).toContain('<ToolbarOverflow entries={overflow} showBelow={600} />')
  })

  it('shorten labels and the model chip at their steps', () => {
    expect(read('ui/chip.tsx')).toContain('@max-[760px]/toolbar:hidden')
    expect(read('chat/UnifiedProviderPicker.tsx')).toContain('@max-[680px]/toolbar:hidden')
  })

  it('keep the row on one line', () => {
    expect(toolbar).toContain("'@container/toolbar flex items-center'")
    expect(footer).toContain('flex-nowrap')
    expect(sources).not.toContain('flex-wrap ')
  })
})
