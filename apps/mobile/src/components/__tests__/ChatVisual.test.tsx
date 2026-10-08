import React from 'react'
import { act } from 'react-test-renderer'
import * as Clipboard from 'expo-clipboard'
import { renderComponent } from '../../test/render'
import { ChatVisual } from '../ChatVisual'
import { Markdown } from '../Markdown'

const CHART = '{"type":"bar","labels":["a","b"],"series":[{"name":"s","values":[1,2]}]}'

async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}

it('shows an invalid chart as its error and its source, with no WebView', () => {
  const root = renderComponent(<ChatVisual kind="chart" source='{"type":"pie"}' />)
  expect(root.texts().join('|')).toContain('This chart could not be drawn: "type" must be "bar", "line" or "table".')
  expect(root.texts()).toContain('{"type":"pie"}')
  expect(root.root.findAll((n) => n.props.testID === 'webview', { deep: true })).toHaveLength(0)
})

it('toggles between the drawing and its source', async () => {
  const root = renderComponent(<ChatVisual kind="chart" source={CHART} />)
  await flush()
  const webviews = (): number => root.root.findAll((n) => n.props.testID === 'webview' && typeof n.type === 'string').length
  expect(webviews()).toBe(1)
  expect(root.texts()).not.toContain(CHART)
  act(() => root.byLabel('Show source').props.onPress())
  expect(root.texts()).toContain(CHART)
  expect(webviews()).toBe(0)
  act(() => root.byLabel('Show chart').props.onPress())
  expect(webviews()).toBe(1)
})

it('copies a chart as tab-separated data', async () => {
  const root = renderComponent(<ChatVisual kind="chart" source={CHART} />)
  await flush()
  await act(async () => { root.byLabel('Copy data').props.onPress() })
  expect(Clipboard.setStringAsync).toHaveBeenCalledWith('\ts\na\t1\nb\t2')
})

it('falls back to the source when the diagram does not draw', async () => {
  const root = renderComponent(<ChatVisual kind="mermaid" source={'flowchart LR\n A -->'} />)
  await flush()
  const webview = root.root.find((n) => n.props.testID === 'webview' && typeof n.type === 'string')
  act(() => webview.props.onMessage({ nativeEvent: { data: JSON.stringify({ type: 'error', error: 'Parse error on line 2' }) } }))
  expect(root.texts().join('|')).toContain('This diagram could not be drawn: Parse error on line 2')
  expect(root.texts()).toContain('flowchart LR\n A -->')
})

it('refuses every navigation but the bundled page', async () => {
  const root = renderComponent(<ChatVisual kind="mermaid" source={'flowchart LR\n A --> B'} />)
  await flush()
  const webview = root.root.find((n) => n.props.testID === 'webview' && typeof n.type === 'string')
  expect(webview.props.onShouldStartLoadWithRequest({ url: 'about:blank' })).toBe(true)
  expect(webview.props.onShouldStartLoadWithRequest({ url: 'https://example.com' })).toBe(false)
  expect(webview.props.javaScriptCanOpenWindowsAutomatically).toBe(false)
  expect(webview.props.allowFileAccess).toBe(false)
})

it('keeps a block that is still streaming as code', () => {
  const root = renderComponent(<Markdown text={'Here:\n```chart\n{"type":"bar"'} />)
  expect(root.texts()).toContain('{"type":"bar"')
  expect(root.texts()).not.toContain('Chart')
})
