/**
 * The composer footer is one flex row of fixed-width controls. On a narrow
 * pane (right-pane resize on a small screen) the row overflowed: the hint
 * wrapped, the context meter was covered, selects kept their full width.
 * The policy below decides what compacts first; wrapping and shrink are CSS.
 */
import { describe, it, expect } from 'vitest'
import { composerFooterLayout, COMPACT_FOOTER_BELOW_PX } from '../../src/renderer/components/chat/composerFooterLayout'

describe('composerFooterLayout', () => {
  it('shows everything on a wide pane', () => {
    expect(composerFooterLayout(900)).toEqual({ showHint: true, shortModeLabels: false })
  })

  it('drops the hint and shortens mode labels on a narrow pane', () => {
    expect(composerFooterLayout(400)).toEqual({ showHint: false, shortModeLabels: true })
  })

  it('treats the breakpoint itself as wide', () => {
    expect(composerFooterLayout(COMPACT_FOOTER_BELOW_PX)).toEqual({ showHint: true, shortModeLabels: false })
  })

  it('compacts one pixel under the breakpoint', () => {
    expect(composerFooterLayout(COMPACT_FOOTER_BELOW_PX - 1)).toEqual({ showHint: false, shortModeLabels: true })
  })

  it('assumes wide before the first measurement lands', () => {
    expect(composerFooterLayout(null)).toEqual({ showHint: true, shortModeLabels: false })
  })
})
