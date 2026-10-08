// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeDiagramSvg } from '../../src/renderer/components/chat/visuals/diagram-render'

describe('sanitizeDiagramSvg', () => {
  it('removes scripts, event handlers and links but keeps the drawing', () => {
    const out = sanitizeDiagramSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">' +
        '<script>alert(2)</script>' +
        '<a href="https://example.com"><text onclick="alert(3)">Node</text></a>' +
        '<rect width="10" height="10"/>' +
        '<foreignObject><div onmouseover="alert(4)">Label<img src=x onerror="alert(5)"></div></foreignObject>' +
        '</svg>',
    )
    expect(out).not.toMatch(/alert|<script|<a\b|href|<img|foreignObject/i)
    expect(out).toContain('<rect')
    expect(out).toContain('Node')
  })

  it('keeps references inside the SVG and drops references outside it', () => {
    const out = sanitizeDiagramSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<style>.a{fill:url(#grad)} .b{background:url(https://evil.test/x.png)} @import "https://evil.test/a.css";</style>' +
        '<path marker-end="url(#arrow)" style="fill:url(http://evil.test/p)"/>' +
        '<image href="https://evil.test/i.png"/>' +
        '</svg>',
    )
    expect(out).toContain('url(#grad)')
    expect(out).toContain('url(#arrow)')
    expect(out).not.toContain('evil.test')
  })
})
