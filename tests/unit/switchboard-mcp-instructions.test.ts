import { describe, expect, it } from 'vitest'
import { SWITCHBOARD_MCP_INSTRUCTIONS as text } from '../../src/main/mcp/switchboard-mcp-server'

describe('Switchboard MCP instructions: visuals', () => {
  it('asks for a chart on data with a trend or comparison, unasked, but not on a code task', () => {
    expect(text).toMatch(/trend or a comparison, answer with a ```chart or ```html-live block even when not asked/)
    expect(text).toMatch(/Do not add one to a plain code task/)
  })

  it('asks for a .png file and its path for an image to share', () => {
    expect(text).toMatch(/image to share or post, write a \.png file/)
    expect(text).toMatch(/headless browser screenshot\) and give its path/)
  })

  it('gives the layout rules', () => {
    expect(text).toMatch(/at most 640 px wide/)
    expect(text).toMatch(/about 360 px wide/)
    expect(text).toMatch(/no outer background, border or card/)
    expect(text).toMatch(/fixed pixel heights, never vh units/)
  })

  it('names every theme variable the page gets', () => {
    for (const name of ['--sb-bg', '--sb-text', '--sb-muted', '--sb-border', '--sb-accent', '--sb-radius']) {
      expect(text).toContain(name)
    }
    expect(text).toContain('--sb-chart-1 to --sb-chart-6')
  })

  it('stays short and has no em dash', () => {
    expect(text).not.toContain('\u2014')
    expect(text.length).toBeLessThan(4000)
  })
})
