import { describe, expect, it } from 'vitest'
import { selectionToRestore } from '../../src/renderer/services/composer-selection'

describe('selectionToRestore', () => {
  it('keeps the caret when the text did not change', () => {
    expect(selectionToRestore({ anchor: 6, focus: 6, body: 'hello world' }, 'hello world')).toEqual({ anchor: 6, focus: 6 })
  })

  it('keeps a selected range, backward included', () => {
    expect(selectionToRestore({ anchor: 11, focus: 6, body: 'hello world' }, 'hello world')).toEqual({ anchor: 11, focus: 6 })
  })

  it('keeps the caret when text was added after it', () => {
    const body = 'hello world [[pill:p1]] '
    expect(selectionToRestore({ anchor: 6, focus: 6, body: 'hello world' }, body)).toEqual({ anchor: 6, focus: 6 })
  })

  it('goes to the end when the old position is past the new text', () => {
    expect(selectionToRestore({ anchor: 9, focus: 9, body: 'hello world' }, 'hello')).toEqual({ anchor: 5, focus: 5 })
  })

  it('goes to the end when one end of a range no longer exists', () => {
    expect(selectionToRestore({ anchor: 2, focus: 9, body: 'hello world' }, 'hello')).toEqual({ anchor: 5, focus: 5 })
  })

  it('goes to the end when the old position now falls inside a pill token', () => {
    expect(selectionToRestore({ anchor: 3, focus: 3, body: 'abcdef' }, 'a[[pill:p1]]')).toEqual({ anchor: 12, focus: 12 })
  })

  it('keeps a position on a pill boundary', () => {
    expect(selectionToRestore({ anchor: 1, focus: 1, body: 'ab' }, 'a[[pill:p1]]')).toEqual({ anchor: 1, focus: 1 })
  })

  it('puts the caret at the end of text written into an empty composer', () => {
    expect(selectionToRestore({ anchor: 0, focus: 0, body: '' }, '/send-to Bob: hi')).toEqual({ anchor: 16, focus: 16 })
  })
})
