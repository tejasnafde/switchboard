import { describe, expect, it } from 'vitest'
import type { DiffHunk } from '../../src/shared/pull-requests'
import { dragLineSelection, nextLineSelection } from '../../src/renderer/components/reviews/line-selection'

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

describe('dragLineSelection', () => {
  const hunk: DiffHunk = {
    header: '@@ -10,4 +10,5 @@',
    oldStart: 10,
    newStart: 10,
    lines: [
      { kind: 'context', text: 'a', oldLine: 10, newLine: 10 },
      { kind: 'del', text: 'b', oldLine: 11, newLine: null },
      { kind: 'add', text: 'c', oldLine: null, newLine: 11 },
      { kind: 'add', text: 'd', oldLine: null, newLine: 12 },
      { kind: 'context', text: 'e', oldLine: 12, newLine: 13 },
    ],
  }
  const start = { side: 'new' as const, hunk: 1, anchor: 11, start: 11, end: 11 }

  it('extends from the anchor either way inside the hunk', () => {
    expect(dragLineSelection(start, hunk, 1, 13)).toMatchObject({ anchor: 11, start: 11, end: 13 })
    expect(dragLineSelection(start, hunk, 1, 10)).toMatchObject({ anchor: 11, start: 10, end: 11 })
  })

  it('clamps to the start hunk when the pointer leaves it', () => {
    expect(dragLineSelection(start, hunk, 2, 40)).toMatchObject({ start: 11, end: 13 })
    expect(dragLineSelection(start, hunk, 0, 3)).toMatchObject({ start: 10, end: 11 })
  })

  it('keeps the range over a row with no line on its side', () => {
    const range = dragLineSelection(start, hunk, 1, 13)
    expect(dragLineSelection(range, hunk, 1, null)).toBe(range)
  })

  it('reads only its own side of the hunk', () => {
    const old = { side: 'old' as const, hunk: 1, anchor: 10, start: 10, end: 10 }
    expect(dragLineSelection(old, hunk, 2, null)).toMatchObject({ start: 10, end: 12 })
  })
})
