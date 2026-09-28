import { describe, expect, it } from 'vitest'
import { nextLineSelection } from '../../src/renderer/components/reviews/line-selection'

describe('nextLineSelection', () => {
  const one = nextLineSelection(null, 'new', 0, 12, false)

  it('picks one line, and clears it on a second plain click', () => {
    expect(one).toEqual({ side: 'new', hunk: 0, anchor: 12, start: 12, end: 12 })
    expect(nextLineSelection(one, 'new', 0, 12, false)).toBeNull()
  })

  it('extends from the anchor either way with shift, inside the hunk', () => {
    const down = nextLineSelection(one, 'new', 0, 18, true)
    expect(down).toMatchObject({ start: 12, end: 18 })
    expect(nextLineSelection(down, 'new', 0, 9, true)).toMatchObject({ anchor: 12, start: 9, end: 12 })
  })

  it('starts over on shift-click in another hunk or on the other side', () => {
    expect(nextLineSelection(one, 'new', 1, 40, true)).toEqual({ side: 'new', hunk: 1, anchor: 40, start: 40, end: 40 })
    expect(nextLineSelection(one, 'old', 0, 14, true)).toEqual({ side: 'old', hunk: 0, anchor: 14, start: 14, end: 14 })
  })
})
