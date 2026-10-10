// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { PILL_LABEL_ATTR, textWithPillLabels } from '../../src/renderer/services/context-formatters'

afterEach(() => { document.body.innerHTML = '' })

// A sent user bubble as renderPillBody draws it: text spans and chips, the
// chip holding a dot and its label.
function bubble(): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<span>Compare </span><span ${PILL_LABEL_ATTR}="src/api/auth.ts:1-7"><span></span><span>src/api/auth.ts:1-7</span></span><span> with </span><span ${PILL_LABEL_ATTR}="api · oauth callback"><span></span><span>api · oauth callback</span></span><span>.</span>`
  document.body.append(root)
  return root
}

describe('textWithPillLabels', () => {
  it('reads a selected user bubble as one line, each chip as its label', () => {
    const range = document.createRange()
    range.selectNodeContents(bubble())
    expect(textWithPillLabels(range.cloneContents())).toBe('Compare src/api/auth.ts:1-7 with api · oauth callback.')
  })

  it('reads a selection that starts mid-text and ends inside a chip', () => {
    const root = bubble()
    const range = document.createRange()
    range.setStart(root.firstElementChild!.firstChild!, 3)
    range.setEnd(root.children[1].lastElementChild!.firstChild!, 3)
    expect(textWithPillLabels(range.cloneContents())).toBe('pare src/api/auth.ts:1-7')
  })

  it('keeps line breaks the user typed', () => {
    const root = document.createElement('div')
    root.innerHTML = '<span>first line\nsecond line</span>'
    expect(textWithPillLabels(root)).toBe('first line\nsecond line')
  })
})
