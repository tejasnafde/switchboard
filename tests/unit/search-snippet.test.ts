import { describe, it, expect } from 'vitest'
import { renderSnippetHtml } from '../../src/renderer/components/searchSnippet'

describe('renderSnippetHtml', () => {
  it('wraps a ** pair in a balanced, closed <mark>', () => {
    const html = renderSnippetHtml('see **foo** here')
    expect(html).toContain('foo</mark>')
    // exactly one open + one close - the old code never closed the tag
    expect((html.match(/<mark/g) ?? []).length).toBe(1)
    expect((html.match(/<\/mark>/g) ?? []).length).toBe(1)
  })

  it('balances multiple matches', () => {
    const html = renderSnippetHtml('**a** and **b**')
    expect((html.match(/<mark/g) ?? []).length).toBe(2)
    expect((html.match(/<\/mark>/g) ?? []).length).toBe(2)
  })

  it('escapes HTML so snippet text cannot inject markup', () => {
    const html = renderSnippetHtml('<script>alert(1)</script> **x**')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('closes a dangling mark on an odd delimiter count', () => {
    const html = renderSnippetHtml('**oops')
    expect((html.match(/<mark/g) ?? []).length).toBe(1)
    expect((html.match(/<\/mark>/g) ?? []).length).toBe(1)
  })

  it('leaves plain text untouched', () => {
    expect(renderSnippetHtml('plain text')).toBe('plain text')
  })
})
