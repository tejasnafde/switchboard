import { describe, expect, it } from 'vitest'
import type { DiffHunk } from '../../src/shared/pull-requests'
import {
  afterDrag,
  dragLineSelection,
  EDGE_BAND_PX,
  EDGE_HEADER_PX,
  EDGE_MAX_SPEED_PX,
  edgeProbeY,
  edgeScrollSpeed,
  nextLineSelection,
} from '../../src/renderer/components/reviews/line-selection'

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

describe('afterDrag', () => {
  const sel = { side: 'new' as const, hunk: 0, anchor: 12, start: 12, end: 12 }
  const open = { sel, composing: true }

  it('keeps the selection and an open comment box when the drag never moved', () => {
    expect(afterDrag(open, null)).toBe(open)
  })

  it('keeps them when the drag ends on the range already selected', () => {
    expect(afterDrag(open, { ...sel, anchor: 12 })).toBe(open)
  })

  it('selects a new range and closes the comment box', () => {
    const range = { ...sel, end: 15 }
    expect(afterDrag(open, range)).toEqual({ sel: range, composing: false })
    expect(afterDrag({ sel: null, composing: false }, range)).toEqual({ sel: range, composing: false })
  })
})

describe('edgeScrollSpeed', () => {
  const top = 100
  const bottom = 600
  const bandTop = top + EDGE_HEADER_PX

  it('does not scroll between the bands', () => {
    expect(edgeScrollSpeed(bandTop + EDGE_BAND_PX, top, bottom)).toBe(0)
    expect(edgeScrollSpeed(350, top, bottom)).toBe(0)
    expect(edgeScrollSpeed(bottom - EDGE_BAND_PX, top, bottom)).toBe(0)
  })

  it('scrolls up in the top band under the header and down in the bottom band', () => {
    expect(edgeScrollSpeed(bandTop + EDGE_BAND_PX - 1, top, bottom)).toBeLessThan(0)
    expect(edgeScrollSpeed(bottom - EDGE_BAND_PX + 1, top, bottom)).toBeGreaterThan(0)
  })

  it('goes faster deeper into a band, capped over the header and past the pane', () => {
    const shallow = edgeScrollSpeed(bottom - EDGE_BAND_PX + 4, top, bottom)
    const deep = edgeScrollSpeed(bottom - 4, top, bottom)
    expect(deep).toBeGreaterThan(shallow)
    expect(edgeScrollSpeed(bottom, top, bottom)).toBe(EDGE_MAX_SPEED_PX)
    expect(edgeScrollSpeed(bottom + 500, top, bottom)).toBe(EDGE_MAX_SPEED_PX)
    expect(edgeScrollSpeed(bandTop, top, bottom)).toBe(-EDGE_MAX_SPEED_PX)
    expect(edgeScrollSpeed(top + 5, top, bottom)).toBe(-EDGE_MAX_SPEED_PX)
    expect(edgeScrollSpeed(top - 500, top, bottom)).toBe(-EDGE_MAX_SPEED_PX)
  })
})

describe('edgeProbeY', () => {
  it('keeps the probe below the header and inside the pane', () => {
    expect(edgeProbeY(300, 100, 600)).toBe(300)
    expect(edgeProbeY(110, 100, 600)).toBe(100 + EDGE_HEADER_PX)
    expect(edgeProbeY(900, 100, 600)).toBe(599)
  })

  it('keeps the current range over a row with no line on the selected side', () => {
    const hunk = {
      header: '@@',
      lines: [
        { kind: 'context', oldLine: 1, newLine: 1, text: 'a' },
        { kind: 'del', oldLine: 2, newLine: null, text: 'b' },
        { kind: 'add', oldLine: null, newLine: 2, text: 'c' },
        { kind: 'add', oldLine: null, newLine: 3, text: 'd' },
      ],
    } as never
    const range = { side: 'new' as const, hunk: 0, anchor: 1, start: 1, end: 3 }
    expect(dragLineSelection(range, hunk, 0, null)).toEqual(range)
  })
})
