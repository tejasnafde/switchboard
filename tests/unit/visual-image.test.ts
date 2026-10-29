import { describe, expect, it } from 'vitest'
import {
  inlineCssVars,
  pngLayout,
  visualFileStem,
  visualMenuItems,
} from '../../src/renderer/components/chat/visuals/visual-image'

const theme: Record<string, string> = {
  '--text-primary': ' #e6e6e6',
  '--accent': '#4a9eff',
  '--link': 'var(--accent)',
  '--empty': '',
}
const read = (name: string) => theme[name] ?? ''

describe('inlineCssVars', () => {
  it('replaces every theme variable with its value', () => {
    expect(inlineCssVars('<text fill="var(--text-primary)" stroke="var( --accent )"/>', read)).toBe(
      '<text fill="#e6e6e6" stroke="#4a9eff"/>',
    )
  })

  it('follows a variable that points at another one', () => {
    expect(inlineCssVars('fill:var(--link)', read)).toBe('fill:#4a9eff')
  })

  it('uses the fallback for an unset variable and keeps an unknown one with none', () => {
    expect(inlineCssVars('a:var(--empty, red);b:var(--missing)', read)).toBe('a:red;b:var(--missing)')
  })
})

describe('visualFileStem', () => {
  it('names a chart and a diagram by a stable hash of the source', () => {
    expect(visualFileStem('chart', '{"a":1}')).toMatch(/^chart-[0-9a-f]{8}$/)
    expect(visualFileStem('mermaid', 'graph LR')).toMatch(/^diagram-[0-9a-f]{8}$/)
    expect(visualFileStem('chart', 'x')).toBe(visualFileStem('chart', 'x'))
    expect(visualFileStem('chart', 'x')).not.toBe(visualFileStem('chart', 'y'))
  })
})

describe('pngLayout', () => {
  it('keeps the box width and padding and takes the full SVG height from the viewBox', () => {
    // A diagram 600 wide drawn into 300 px, cut off at 460 px by the card.
    const layout = pngLayout(
      { width: 638, padTop: 10, padBottom: 10, padRight: 10 },
      { left: 169, width: 300 },
      { width: 600, height: 1200 },
      460,
    )
    expect(layout).toEqual({ width: 638, height: 620, x: 169, y: 10, svgWidth: 300, svgHeight: 600 })
  })

  it('widens to a diagram wider than the pane', () => {
    const layout = pngLayout(
      { width: 400, padTop: 16, padBottom: 16, padRight: 16 },
      { left: 16, width: 900 },
      null,
      300,
    )
    expect(layout.width).toBe(932)
  })

  it('uses the drawn height without a viewBox', () => {
    expect(
      pngLayout({ width: 100, padTop: 0, padBottom: 0, padRight: 0 }, { left: 0, width: 100 }, null, 40).height,
    ).toBe(40)
  })
})

describe('visualMenuItems', () => {
  const noop = () => undefined
  const labels = (items: { label: string; hint: string }[]) => items.map((i) => `${i.label} (${i.hint})`)

  it('lists Save image and the copy that fits each kind', () => {
    expect(labels(visualMenuItems('chart', { saveImage: noop, copyText: noop }))).toEqual([
      'Save image (PNG, 2x)',
      'Copy data (TSV)',
    ])
    expect(labels(visualMenuItems('mermaid', { saveImage: noop, copyText: noop }))).toEqual([
      'Save image (PNG, 2x)',
      'Copy SVG (SVG)',
    ])
    expect(labels(visualMenuItems('html-live', { saveImage: noop, copyText: noop, saveAsFile: noop }))).toEqual([
      'Save image (PNG, 2x)',
      'Copy source (HTML)',
      'Save as file (.html)',
    ])
  })

  it('leaves out an action that is not there', () => {
    expect(labels(visualMenuItems('html-live', { copyText: noop }))).toEqual(['Copy source (HTML)'])
  })
})
