import { describe, expect, it } from 'vitest'
import { splitVisualBlocks, MAX_VISUAL_SOURCE_CHARS } from '../../src/shared/chat-visuals'
import {
  HTML_LIVE_MAX_BYTES,
  htmlLiveDocument,
  htmlLiveFileName,
  htmlLiveFolds,
  htmlLiveFrameHeight,
  htmlLiveHeightFromConsole,
  htmlLiveLibraryRefs,
  htmlLiveRejection,
  htmlLiveVerdict,
  isHtmlLiveImage,
  isHtmlLiveImageKey,
  isHtmlLiveOpenRequest,
  parseHtmlLiveInfo,
  pickRunningFrames,
  type HtmlLiveTheme,
} from '../../src/shared/html-live'

const theme: HtmlLiveTheme = {
  scheme: 'dark',
  bg: '#0d1117',
  surface: '#161b22',
  text: '#e6edf3',
  muted: '#8b949e',
  border: '#30363d',
  accent: '#58a6ff',
  success: '#3fb950',
  warning: '#d29922',
  error: '#f85149',
  font: '-apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, monospace',
}

describe('parseHtmlLiveInfo', () => {
  it('reads the title and refuses other languages', () => {
    expect(parseHtmlLiveInfo('html-live title="Chart"')).toEqual({ title: 'Chart' })
    expect(parseHtmlLiveInfo('html-live')).toEqual({ title: null })
    expect(parseHtmlLiveInfo('html')).toBeNull()
    expect(parseHtmlLiveInfo('html-lively')).toBeNull()
  })
})

describe('splitVisualBlocks with html-live', () => {
  it('keeps a block over the chart size limit as a segment, so the cap message shows', () => {
    const big = 'x'.repeat(MAX_VISUAL_SOURCE_CHARS + 10)
    const segments = splitVisualBlocks(`\`\`\`html-live\n${big}\n\`\`\``)
    expect(segments).toEqual([{ kind: 'html-live', source: big, title: null, closed: true }])
  })
})

describe('htmlLiveVerdict', () => {
  it('names the bundled libraries a page loads', () => {
    const source = `<script src="/_sb/chart.js"></script><script type="module">import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'</script>`
    expect(htmlLiveLibraryRefs(source)).toEqual(['chart.js', 'three.js', 'three/addons/controls/OrbitControls.js'])
    expect(htmlLiveVerdict(source)).toEqual({ ok: true, libraries: ['Chart.js', 'Three.js'] })
    expect(htmlLiveVerdict('<p>plain</p>')).toEqual({ ok: true, libraries: [] })
  })

  it('refuses an unknown /_sb/ name and lists the real ones', () => {
    const verdict = htmlLiveVerdict('<script src="/_sb/plotly.js"></script>')
    expect(verdict).toEqual({ ok: false, reason: 'unknown-library', names: ['plotly.js'] })
    if (verdict.ok) throw new Error('unreachable')
    expect(htmlLiveRejection(verdict)).toContain('/_sb/chart.js')
  })

  it('caps the block at 128 KB of UTF-8, not characters', () => {
    expect(htmlLiveVerdict('a'.repeat(HTML_LIVE_MAX_BYTES)).ok).toBe(true)
    const verdict = htmlLiveVerdict('é'.repeat(HTML_LIVE_MAX_BYTES / 2 + 1))
    expect(verdict).toMatchObject({ ok: false, reason: 'too-large', bytes: HTML_LIVE_MAX_BYTES + 2 })
    if (verdict.ok) throw new Error('unreachable')
    expect(htmlLiveRejection(verdict)).toContain('capped at 128 KB')
  })
})

describe('frame height', () => {
  it('fits content between 120 and 480, and Show all lifts the fold', () => {
    expect(htmlLiveFrameHeight(40, false)).toBe(120)
    expect(htmlLiveFrameHeight(300.2, false)).toBe(301)
    expect(htmlLiveFrameHeight(812, false)).toBe(480)
    expect(htmlLiveFrameHeight(812, true)).toBe(812)
    expect(htmlLiveFrameHeight(1e9, true)).toBe(4000)
    expect(htmlLiveFrameHeight(Number.NaN, false)).toBe(120)
    expect(htmlLiveFolds(480)).toBe(false)
    expect(htmlLiveFolds(481)).toBe(true)
  })

  it('reads the size reporter line only', () => {
    expect(htmlLiveHeightFromConsole('__sb_live_height__:812')).toBe(812)
    expect(htmlLiveHeightFromConsole('__sb_live_height__:-1')).toBeNull()
    expect(htmlLiveHeightFromConsole('height 812')).toBeNull()
  })
})

describe('pickRunningFrames', () => {
  it('runs at most two, newest first, and never one that does not want to', () => {
    const frames = [
      { id: 'a', wants: true, since: 1 },
      { id: 'b', wants: true, since: 3 },
      { id: 'c', wants: false, since: 9 },
      { id: 'd', wants: true, since: 2 },
    ]
    expect([...pickRunningFrames(frames)].sort()).toEqual(['b', 'd'])
    // Run on the paused one displaces the one that has run longest.
    frames[0].since = 10
    expect([...pickRunningFrames(frames)].sort()).toEqual(['a', 'b'])
    expect(pickRunningFrames([])).toEqual(new Set())
  })
})

describe('htmlLiveDocument', () => {
  it('wraps a fragment with the theme, the import map and the size reporter', () => {
    const doc = htmlLiveDocument('<p>hi</p>', theme)
    expect(doc.startsWith('<!doctype html><html data-sb-theme="dark"><head>')).toBe(true)
    expect(doc).toContain('--sb-accent:#58a6ff;')
    expect(doc).toContain('"three":"/_sb/three.js"')
    expect(doc).toContain('__sb_live_height__:')
    expect(doc.endsWith('<body><p>hi</p></body></html>')).toBe(true)
  })

  it('puts the head pieces first inside a full document head', () => {
    const doc = htmlLiveDocument('<!doctype html><html><head><title>x</title></head><body></body></html>', theme)
    expect(doc.indexOf('importmap')).toBeLessThan(doc.indexOf('<title>'))
    expect(doc.match(/<head>/g)).toHaveLength(1)
    const noHead = htmlLiveDocument('<html lang="en"><body>x</body></html>', theme)
    expect(noHead).toMatch(/^<html lang="en"><head><meta charset/)
  })

  it('drops a theme value that could break out of the style block', () => {
    const doc = htmlLiveDocument('x', { ...theme, accent: 'red}</style><script>alert(1)</script>' })
    expect(doc).not.toContain('alert(1)')
    expect(doc).not.toContain('--sb-accent')
  })
})

describe('store and request guards', () => {
  it('accepts only a hex sha256 key and a small image data URL', () => {
    expect(isHtmlLiveImageKey('a'.repeat(64))).toBe(true)
    expect(isHtmlLiveImageKey('A'.repeat(64))).toBe(false)
    expect(isHtmlLiveImageKey('../x')).toBe(false)
    expect(isHtmlLiveImage('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
    expect(isHtmlLiveImage('data:text/html;base64,PGI+')).toBe(false)
    expect(isHtmlLiveImage('javascript:alert(1)')).toBe(false)
  })

  it('checks an open-on-desktop request', () => {
    expect(isHtmlLiveOpenRequest({ conversationId: 'c', source: '<b>', title: null })).toBe(true)
    expect(isHtmlLiveOpenRequest({ conversationId: '', source: '<b>', title: null })).toBe(false)
    expect(
      isHtmlLiveOpenRequest({ conversationId: 'c', source: 'a'.repeat(HTML_LIVE_MAX_BYTES + 1), title: null }),
    ).toBe(false)
  })
})

describe('htmlLiveFileName', () => {
  it('slugs the title and skips taken names', () => {
    expect(htmlLiveFileName('p95 latency, Mon to Wed')).toBe('p95-latency-mon-to-wed.html')
    expect(htmlLiveFileName(null)).toBe('live-page.html')
    const taken = new Set(['chart.html', 'chart-2.html'])
    expect(htmlLiveFileName('Chart', (name) => taken.has(name))).toBe('chart-3.html')
  })
})
