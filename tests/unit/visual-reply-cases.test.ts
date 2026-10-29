/**
 * Canned agent replies for the visual guidance in the MCP instructions: a
 * prompt with data and a question expects a ```chart or ```html-live block,
 * a code task expects none. Each case holds a reply that passes and one that
 * fails, so the grader is checked here without a live model.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { splitVisualBlocks } from '../../src/shared/chat-visuals'

interface VisualReplyCase {
  id: string
  prompt: string
  expect: 'visual' | 'none'
  pass: string
  fail: string
}

const cases = JSON.parse(
  readFileSync(new URL('../fixtures/visual-reply-cases.json', import.meta.url), 'utf8'),
) as VisualReplyCase[]

/** A chart or a closed live page; a mermaid diagram does not answer a data question. */
function hasDataVisual(reply: string): boolean {
  return splitVisualBlocks(reply).some(
    (segment) => segment.kind === 'chart' || (segment.kind === 'html-live' && segment.closed),
  )
}

function grade(c: VisualReplyCase, reply: string): boolean {
  return hasDataVisual(reply) === (c.expect === 'visual')
}

describe('visual reply cases', () => {
  it('cover both kinds', () => {
    expect(cases.some((c) => c.expect === 'visual')).toBe(true)
    expect(cases.some((c) => c.expect === 'none')).toBe(true)
  })

  it.each(cases)('$id: grades the passing reply as a pass and the failing one as a fail', (c) => {
    expect(grade(c, c.pass)).toBe(true)
    expect(grade(c, c.fail)).toBe(false)
  })

  it('does not count a live page that is still being written', () => {
    expect(hasDataVisual('```html-live title="x"\n<p>half')).toBe(false)
  })
})
