import { describe, expect, it } from 'vitest'
import fixtures from '../fixtures/chart-spec-cases.json'
import fenceFixtures from '../fixtures/visual-fence-cases.json'
import {
  chartDataText,
  MAX_VISUAL_SOURCE_CHARS,
  MAX_VISUALS_PER_MESSAGE,
  niceTicks,
  parseChartSpec,
  renderChart,
  splitVisualBlocks,
  type ChartSpec,
} from '../../src/shared/chat-visuals'

const palette = { text: 'var(--text-primary)', muted: 'var(--text-secondary)', grid: 'var(--border)', font: 'sans-serif', series: ['red', 'blue'] }

describe('parseChartSpec (shared fixtures, also run by Android)', () => {
  for (const c of fixtures) {
    it(c.id, () => {
      expect(parseChartSpec(c.source)).toEqual(c.expected)
    })
  }
})

describe('splitVisualBlocks (shared fixtures, also run by Android)', () => {
  for (const c of fenceFixtures) {
    it(c.id, () => {
      expect(splitVisualBlocks(c.markdown)).toEqual(c.expected)
    })
  }

  it('keeps oversized and surplus blocks as code', () => {
    const big = `\`\`\`mermaid\n${'x'.repeat(MAX_VISUAL_SOURCE_CHARS + 1)}\n\`\`\``
    expect(splitVisualBlocks(big)).toEqual([{ kind: 'markdown', text: big }])
    const many = Array.from({ length: MAX_VISUALS_PER_MESSAGE + 1 }, () => '```chart\n{}\n```').join('\n')
    const segments = splitVisualBlocks(many)
    expect(segments.filter((s) => s.kind === 'chart')).toHaveLength(MAX_VISUALS_PER_MESSAGE)
    expect(segments[segments.length - 1]).toEqual({ kind: 'markdown', text: '```chart\n{}\n```' })
  })
})

describe('renderChart', () => {
  const spec: ChartSpec = {
    version: 1,
    type: 'bar',
    title: '<script>alert(1)</script>',
    labels: ['<img src=x onerror=alert(1)>', 'b'],
    series: [{ name: '"><svg onload=alert(1)>', values: [3, -1] }],
    yTitle: 'ms & s',
  }

  it('escapes every string from the spec', () => {
    for (const type of ['bar', 'line', 'table'] as const) {
      const out = renderChart({ ...spec, type }, palette)
      expect(out).not.toMatch(/<script|<img|<svg onload/)
      expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;')
    }
    expect(renderChart(spec, palette)).toContain('ms &amp; s')
  })

  it('draws one bar per value and one line per series', () => {
    expect(renderChart(spec, palette).match(/<rect [^>]*><title>/g)).toHaveLength(2)
    expect(renderChart({ ...spec, type: 'line' }, palette).match(/<polyline/g)).toHaveLength(1)
    expect(renderChart({ ...spec, type: 'table' }, palette).match(/<tr>/g)).toHaveLength(3)
  })
})

describe('chart helpers', () => {
  it('niceTicks covers the range and includes zero', () => {
    expect(niceTicks(0, 3800)).toEqual([0, 1000, 2000, 3000, 4000])
    expect(niceTicks(-3, 2.5)).toEqual([-4, -2, 0, 2, 4])
    expect(niceTicks(0, 0)).toEqual([0, 1])
  })

  it('chartDataText is tab separated with a header row', () => {
    const parsed = parseChartSpec(fixtures[0].source)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(chartDataText(parsed.spec)).toBe('\tbefore\tafter\nlong chat\t3800\t400\nshort chat\t1100\t150')
  })
})
