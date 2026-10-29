/**
 * `preview_visual` (flag `agent_visual_preview`): argument parsing and caps,
 * the per-turn limit, the timeout, the parse error path, and that the
 * renderer draws through the live page sandbox.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentVisualPreviewEnabled,
  parseVisualPreviewArgs,
  VISUAL_PREVIEW_MAX_PER_TURN,
  type VisualPreviewResult,
} from '../../src/shared/visual-preview'
import { HTML_LIVE_MAX_BYTES } from '../../src/shared/html-live'
import { MAX_VISUAL_SOURCE_CHARS } from '../../src/shared/chat-visuals'
import {
  buildVisualPreviewTool,
  VisualPreviewTurnCounter,
  type VisualPreviewRenderer,
} from '../../src/main/mcp/visual-preview-tool'

const CHART = '{"type":"bar","labels":["a","b"],"series":[{"name":"s","values":[1,2]}]}'
const PNG = 'data:image/png;base64,iVBORw0KGgo='
const drawn: VisualPreviewResult = {
  ok: true,
  image: PNG,
  contentHeight: 610,
  frameHeight: 480,
  width: 580,
  errors: ['ReferenceError: x is not defined · :3'],
  blocked: ['https://example.com/data.json'],
}

function tool(render: VisualPreviewRenderer, timeoutMs?: number) {
  return buildVisualPreviewTool({
    threadId: 't1',
    chatId: () => 'c1',
    render,
    counter: new VisualPreviewTurnCounter(),
    ...(timeoutMs ? { timeoutMs } : {}),
  })
}
const ctx = () => ({ signal: new AbortController().signal })
const text = (r: { content: Array<{ type: string; text?: string }> }) =>
  r.content.find((c) => c.type === 'text')?.text ?? ''

describe('agent_visual_preview flag', () => {
  it('is off by default and on by env or the labs setting', () => {
    expect(agentVisualPreviewEnabled({}, () => null)).toBe(false)
    expect(agentVisualPreviewEnabled({ SB_AGENT_VISUAL_PREVIEW: '1' }, () => null)).toBe(true)
    expect(agentVisualPreviewEnabled({}, (k) => (k === 'labs.agent_visual_preview' ? 'true' : null))).toBe(true)
  })
})

describe('parseVisualPreviewArgs', () => {
  it('reads one fenced block of each kind, or a body with its kind', () => {
    expect(parseVisualPreviewArgs({ block: '```mermaid\ngraph TD; A-->B\n```' })).toEqual({
      ok: true,
      kind: 'mermaid',
      source: 'graph TD; A-->B',
    })
    expect(parseVisualPreviewArgs({ block: `\`\`\`chart\n${CHART}\n\`\`\`` })).toMatchObject({
      ok: true,
      kind: 'chart',
    })
    expect(parseVisualPreviewArgs({ block: '```html-live title="x"\n<p>hi</p>\n```' })).toEqual({
      ok: true,
      kind: 'html-live',
      source: '<p>hi</p>',
    })
    expect(parseVisualPreviewArgs({ body: '<p>hi</p>', kind: 'html-live' })).toMatchObject({ ok: true })
  })

  it('refuses what the chat would not draw', () => {
    expect(parseVisualPreviewArgs({})).toMatchObject({ ok: false })
    expect(parseVisualPreviewArgs({ block: 'not a fence' })).toMatchObject({ ok: false })
    expect(parseVisualPreviewArgs({ block: '```python\nprint(1)\n```' })).toMatchObject({ ok: false })
    expect(parseVisualPreviewArgs({ body: 'x', kind: 'svg' })).toMatchObject({ ok: false })
    expect(parseVisualPreviewArgs({ body: '   ', kind: 'mermaid' })).toMatchObject({ ok: false })
    const big = parseVisualPreviewArgs({ body: 'x'.repeat(HTML_LIVE_MAX_BYTES + 1), kind: 'html-live' })
    expect(big).toMatchObject({ ok: false, error: expect.stringContaining('capped at 128 KB') })
    expect(parseVisualPreviewArgs({ body: '<script src="/_sb/plotly.js"></script>', kind: 'html-live' })).toMatchObject(
      { ok: false, error: expect.stringContaining('/_sb/plotly.js') },
    )
    expect(parseVisualPreviewArgs({ body: 'x'.repeat(MAX_VISUAL_SOURCE_CHARS + 1), kind: 'mermaid' })).toMatchObject({
      ok: false,
    })
  })

  it('returns a chart parse error as a parse error, before anything renders', () => {
    const bad = parseVisualPreviewArgs({ body: '{"type":"pie"}', kind: 'chart' })
    expect(bad).toMatchObject({
      ok: false,
      parse: true,
      error: expect.stringMatching(/^The chart could not be drawn: /),
    })
  })
})

describe('preview_visual tool', () => {
  it('returns the image, the height and the console errors', async () => {
    let asked: unknown = null
    const result = await tool(async (request) => {
      asked = request
      return drawn
    }).call({ body: '<p>x</p>', kind: 'html-live' }, ctx())
    expect(asked).toEqual({ threadId: 't1', chatId: 'c1', kind: 'html-live', source: '<p>x</p>' })
    expect(result.isError).toBeUndefined()
    expect(result.content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })
    expect(text(result)).toContain('Content height 610 px')
    expect(text(result)).toContain('folds behind Show all')
    expect(text(result)).toContain('ReferenceError: x is not defined')
    expect(text(result)).toContain('https://example.com/data.json')
  })

  it('never asks the renderer for a bad chart, and passes a diagram parse error on', async () => {
    let calls = 0
    const render: VisualPreviewRenderer = async () => {
      calls++
      return { ok: false, error: 'The diagram could not be drawn: Parse error on line 1', parse: true }
    }
    const t = tool(render)
    const chart = await t.call({ body: '{"type":"bar"}', kind: 'chart' }, ctx())
    expect(chart.isError).toBe(true)
    expect(calls).toBe(0)
    const diagram = await t.call({ body: 'graph ??', kind: 'mermaid' }, ctx())
    expect(diagram).toMatchObject({ isError: true })
    expect(text(diagram)).toContain('Parse error on line 1')
  })

  it('gives up after the timeout and aborts the render', async () => {
    let aborted = false
    const result = await tool(
      (_request, signal) =>
        new Promise(() => {
          signal.addEventListener('abort', () => (aborted = true))
        }),
      20,
    ).call({ body: '<p>x</p>', kind: 'html-live' }, ctx())
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/did not finish/)
    expect(aborted).toBe(true)
  })

  it(`allows ${VISUAL_PREVIEW_MAX_PER_TURN} previews a turn, and a turn end gives them back`, async () => {
    const counter = new VisualPreviewTurnCounter()
    const t = buildVisualPreviewTool({ threadId: 't1', chatId: () => 'c1', render: async () => drawn, counter })
    // A refused argument costs nothing.
    expect((await t.call({}, ctx())).isError).toBe(true)
    for (let i = 0; i < VISUAL_PREVIEW_MAX_PER_TURN; i++)
      expect((await t.call({ body: 'x', kind: 'html-live' }, ctx())).isError).toBeUndefined()
    const over = await t.call({ body: 'x', kind: 'html-live' }, ctx())
    expect(over.isError).toBe(true)
    expect(text(over)).toMatch(/limit/)
    // Another chat has its own count.
    expect(counter.take('c2')).toBe(true)
    counter.reset('c1')
    expect((await t.call({ body: 'x', kind: 'html-live' }, ctx())).isError).toBeUndefined()
  })
})

describe('the renderer draws a preview in the live page sandbox', () => {
  const host = readFileSync(join(process.cwd(), 'src/renderer/components/chat/visuals/VisualPreviewHost.tsx'), 'utf8')
  it('opens the inline sandboxed document and captures it like a hidden still', () => {
    // The inline document is what html-preview-sandbox.test.ts proves: no network, bundled libraries only.
    expect(host).toContain('window.api.preview.openInline(')
    expect(host).toContain('window.api.preview.captureInline(')
    expect(host).toContain('partition={PREVIEW_PARTITION}')
    expect(host).toContain('webpreferences="contextIsolation=yes,sandbox=yes,nodeIntegration=no"')
    expect(host).not.toMatch(/fetch\(|XMLHttpRequest|new WebSocket/)
  })
})
