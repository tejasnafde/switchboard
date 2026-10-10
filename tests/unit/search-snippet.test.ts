import { describe, it, expect } from 'vitest'
import { renderSearchResultSnippetHtml, renderSnippetHtml } from '../../src/renderer/components/search-snippet'

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

describe('renderSearchResultSnippetHtml', () => {
  const open = '\u0002'
  const close = '\u0003'

  it('uses the control-character snippet, so markdown bold is plain text', () => {
    const html = renderSearchResultSnippetHtml({ snippet: '**bold** **x**', snippetMarked: `**bold** ${open}x${close}` })
    expect(html).toContain('**bold**')
    expect(html.match(/<mark/g)).toHaveLength(1)
    expect(html).toMatch(/<mark[^>]*>x<\/mark>/)
  })

  it('balances stray markers', () => {
    expect(renderSearchResultSnippetHtml({ snippet: '', snippetMarked: `${close}a ${open}b` })).toMatch(/^a <mark[^>]*>b<\/mark>$/)
  })

  it('falls back to the ** snippet from an older backend', () => {
    expect(renderSearchResultSnippetHtml({ snippet: 'see **foo**' })).toMatch(/see <mark[^>]*>foo<\/mark>/)
  })
})
