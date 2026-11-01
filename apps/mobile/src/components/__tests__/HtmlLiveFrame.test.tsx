import React from 'react'
import { Linking } from 'react-native'
import { act } from 'react-test-renderer'
import * as Clipboard from 'expo-clipboard'
import * as FileSystem from 'expo-file-system/legacy'
import { PHONE_LIVE_GUARD } from '@shared/html-live-phone'
import { renderComponent, type Node } from '../../test/render'
import { HtmlLiveFrame, LIVE_ORIGIN_WHITELIST, liveLibrariesSupported, liveNavigationGate } from '../HtmlLiveFrame'

const CHART_PAGE = '<script src="/_sb/chart.js"></script>\n<canvas id="c"></canvas>'
const SCHEMES = [
  'https://example.com/',
  'http://10.0.2.2/',
  'file:///etc/passwd',
  'content://settings/system',
  'intent://scan/#Intent;scheme=zxing;end',
  'market://details?id=app.example',
  'tel:5551234',
  'sms:5551234',
  'mailto:a@example.com',
  'javascript:alert(1)',
  'data:text/html,<b>x</b>',
  'blob:null/1234',
  'about:blank',
]

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function webView(root: Node): Node {
  return root.find((n) => n.props.testID === 'html-live-webview' && typeof n.type === 'string')
}

async function renderFrame(fullScreen = false, source = CHART_PAGE) {
  const callbacks = { onHeight: jest.fn(), onStop: jest.fn(), onCrash: jest.fn() }
  const rendered = renderComponent(<HtmlLiveFrame source={source} fullScreen={fullScreen} {...callbacks} />)
  await flush()
  return { ...rendered, ...callbacks, web: () => webView(rendered.root) }
}

function message(web: Node, data: unknown): void {
  act(() => web.props.onMessage({ nativeEvent: { data } }))
}

let linking: jest.SpyInstance[]
beforeEach(() => {
  jest.useFakeTimers({ now: 1_000_000 })
  linking = [
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true),
    jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true),
  ]
})
afterEach(() => {
  jest.useRealTimers()
})

it('sets every locked-down WebView prop inline', async () => {
  const { web } = await renderFrame()
  const props = web().props
  expect(props.source).toEqual({ html: expect.any(String) })
  expect(props.source.baseUrl).toBeUndefined()
  expect(props.originWhitelist).toEqual(['*'])
  expect(props.javaScriptEnabled).toBe(true)
  expect(props.javaScriptCanOpenWindowsAutomatically).toBe(false)
  expect('onOpenWindow' in props).toBe(false)
  expect(props.incognito).toBe(true)
  expect(props.cacheEnabled).toBe(false)
  expect(props.allowsLinkPreview).toBe(false)
  expect(props.dataDetectorTypes).toBe('none')
  expect(props.allowsInlineMediaPlayback).toBe(false)
  expect(props.mediaCapturePermissionGrantType).toBe('deny')
  expect(props.allowsBackForwardNavigationGestures).toBe(false)
  expect(props.textInteractionEnabled).toBe(false)
  expect(props.injectedJavaScriptBeforeContentLoaded).toBe(PHONE_LIVE_GUARD)
  expect(typeof props.onMessage).toBe('function')
  expect(typeof props.onContentProcessDidTerminate).toBe('function')
  expect(props.scrollEnabled).toBe(false)
})

it('scrolls and allows text selection only in the full-screen view', async () => {
  const { web } = await renderFrame(true)
  expect(web().props.scrollEnabled).toBe(true)
  expect(web().props.textInteractionEnabled).toBe(true)
  expect(web().props.javaScriptCanOpenWindowsAutomatically).toBe(false)
  expect('onOpenWindow' in web().props).toBe(false)
})

it('allows the first about:blank load and refuses every later navigation', async () => {
  const { web } = await renderFrame()
  const gate = web().props.onShouldStartLoadWithRequest
  expect(gate({ url: 'about:blank' })).toBe(true)
  for (const url of SCHEMES) expect(gate({ url })).toBe(false)
})

it('refuses a window.open or target=_blank load, which comes back as a navigation in the same view', async () => {
  const { web } = await renderFrame()
  const gate = web().props.onShouldStartLoadWithRequest
  expect(gate({ url: 'about:blank' })).toBe(true)
  expect(gate({ url: 'https://example.com/popup', navigationType: 'other', isTopFrame: true })).toBe(false)
  expect(gate({ url: 'about:blank', navigationType: 'other', isTopFrame: false })).toBe(false)
})

it('refuses a first load that is not about:blank', () => {
  const gate = liveNavigationGate()
  expect(gate({ url: 'https://example.com/' })).toBe(false)
  expect(gate({ url: 'about:blank' })).toBe(true)
  expect(gate({ url: 'about:blank' })).toBe(false)
})

it("never hands a refused URL to Linking through the library's whitelist path", async () => {
  const { createOnShouldStartLoadWithRequest } = jest.requireActual('react-native-webview/lib/WebViewShared')
  const loadRequest = jest.fn()
  const decide = createOnShouldStartLoadWithRequest(loadRequest, LIVE_ORIGIN_WHITELIST, liveNavigationGate())
  decide({ nativeEvent: { url: 'about:blank', lockIdentifier: 0 } })
  SCHEMES.forEach((url, i) => decide({ nativeEvent: { url, lockIdentifier: i + 1 } }))
  await flush()
  expect(loadRequest).toHaveBeenNthCalledWith(1, true, 'about:blank', 0)
  for (let i = 1; i <= SCHEMES.length; i++) expect(loadRequest.mock.calls[i][0]).toBe(false)
  for (const spy of linking) expect(spy).not.toHaveBeenCalled()
})

it("would hand a refused URL to Linking with originWhitelist ['about:blank'], so the gate is the only filter", async () => {
  const { createOnShouldStartLoadWithRequest } = jest.requireActual('react-native-webview/lib/WebViewShared')
  const loadRequest = jest.fn()
  const decide = createOnShouldStartLoadWithRequest(loadRequest, ['about:blank'], liveNavigationGate())
  decide({ nativeEvent: { url: 'about:blank', lockIdentifier: 0 } })
  decide({ nativeEvent: { url: 'tel:5551234', lockIdentifier: 1 } })
  await flush()
  expect(loadRequest).toHaveBeenLastCalledWith(false, 'tel:5551234', 1)
  expect(Linking.openURL).toHaveBeenCalledWith('tel:5551234')
})

it('passes a document that starts with the CSP meta that blocks the network', async () => {
  const { web } = await renderFrame()
  const html: string = web().props.source.html
  expect(
    html.startsWith('<!doctype html><html data-sb-theme="dark"><head><meta http-equiv="Content-Security-Policy"'),
  ).toBe(true)
  const csp = /content="([^"]*)"/.exec(html)?.[1] ?? ''
  // fetch, XHR, WebSocket, EventSource and sendBeacon
  expect(csp).toContain("connect-src 'self' data: blob:")
  // <img src>
  expect(csp).toContain("img-src 'self' data: blob:")
  // CSS url() and @import, fonts
  expect(csp).toContain("style-src 'self' 'unsafe-inline' data:")
  expect(csp).toContain("font-src 'self' data:")
  expect(csp).toContain("default-src 'none'")
  expect(csp).toContain("form-action 'none'")
  // No directive names a remote host or a wildcard.
  expect(csp).not.toMatch(/https?:|wss?:|\*/)
  expect(html.indexOf('<canvas')).toBeGreaterThan(html.indexOf('Content-Security-Policy'))
})

it('inlines only the libraries the page names, as data: URLs', async () => {
  const { web } = await renderFrame()
  expect(FileSystem.readAsStringAsync).toHaveBeenCalledTimes(1)
  expect(FileSystem.readAsStringAsync).toHaveBeenCalledWith(expect.any(String), { encoding: 'base64' })
  expect(web().props.source.html).toContain('<script src="data:text/javascript;base64,')
})

it('stops the page when a library cannot be read', async () => {
  jest.mocked(FileSystem.readAsStringAsync).mockRejectedValueOnce(new Error('gone'))
  const { onStop, root } = await renderFrame()
  expect(onStop).toHaveBeenCalledWith('libraries')
  expect(root.findAll((n) => n.props.testID === 'html-live-webview')).toHaveLength(0)
})

it('keeps a three page on a still image before iOS 16.4', () => {
  const three = '<script type="module">import * as THREE from \'three\'</script>'
  expect(liveLibrariesSupported(three, '16.2')).toBe(false)
  expect(liveLibrariesSupported(three, '16.4')).toBe(true)
  expect(liveLibrariesSupported(three, '17.0')).toBe(true)
  expect(liveLibrariesSupported(CHART_PAGE, '15.0')).toBe(true)
})

it('reads a height, debounced to 100 ms', async () => {
  const { web, onHeight } = await renderFrame()
  message(web(), JSON.stringify({ t: 'h', v: 200 }))
  message(web(), JSON.stringify({ t: 'h', v: 300 }))
  act(() => jest.advanceTimersByTime(99))
  expect(onHeight).not.toHaveBeenCalled()
  act(() => jest.advanceTimersByTime(1))
  expect(onHeight).toHaveBeenCalledTimes(1)
  expect(onHeight).toHaveBeenCalledWith(300)
})

it('drops messages outside the schema, oversize ones and those past the rate, and never opens or copies', async () => {
  const { web, onHeight, texts } = await renderFrame(true)
  for (const data of [
    'not json',
    '[1,2]',
    JSON.stringify({ t: 'open', v: 'https://example.com' }),
    JSON.stringify({ t: 'h', v: 'tall' }),
    JSON.stringify({ t: 'h', v: -4 }),
    JSON.stringify({ t: 'e', v: 3 }),
    JSON.stringify({ t: 'b', v: 'x'.repeat(2000) }),
    { t: 'h', v: 10 },
  ]) {
    message(web(), data)
  }
  act(() => jest.advanceTimersByTime(200))
  expect(onHeight).not.toHaveBeenCalled()
  expect(texts().join(' ')).not.toMatch(/error|blocked/)

  // 8 used this second; 92 more pass and the rest are dropped.
  for (let i = 0; i < 150; i++) message(web(), JSON.stringify({ t: 'b', v: `https://x/${i}` }))
  for (let i = 0; i < 30; i++) message(web(), JSON.stringify({ t: 'e', v: `boom ${i}` }))
  expect(texts()).toContain('20 blocked')
  expect(texts().join(' ')).not.toContain('error')

  act(() => jest.advanceTimersByTime(1000))
  for (let i = 0; i < 30; i++) message(web(), JSON.stringify({ t: 'e', v: `boom ${i}` }))
  expect(texts()).toContain('20 errors, 20 blocked')
  expect(Linking.openURL).not.toHaveBeenCalled()
  expect(Linking.canOpenURL).not.toHaveBeenCalled()
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled()
})

it('stops the page after 8 s with no height', async () => {
  const { onStop } = await renderFrame()
  act(() => jest.advanceTimersByTime(7999))
  expect(onStop).not.toHaveBeenCalled()
  act(() => jest.advanceTimersByTime(1))
  expect(onStop).toHaveBeenCalledWith('watchdog')
})

it('keeps a page that reported its height', async () => {
  const { web, onStop } = await renderFrame()
  message(web(), JSON.stringify({ t: 'h', v: 200 }))
  act(() => jest.advanceTimersByTime(10_000))
  expect(onStop).not.toHaveBeenCalled()
})

it('stops the page on a second document load', async () => {
  const { web, onStop } = await renderFrame()
  act(() => web().props.onLoadStart({ nativeEvent: { url: 'about:blank' } }))
  expect(onStop).not.toHaveBeenCalled()
  act(() => web().props.onLoadStart({ nativeEvent: { url: 'about:blank' } }))
  expect(onStop).toHaveBeenCalledWith('reload')
})

it('reports a WebContent process crash', async () => {
  const { web, onCrash } = await renderFrame()
  act(() => web().props.onContentProcessDidTerminate({ nativeEvent: {} }))
  expect(onCrash).toHaveBeenCalledTimes(1)
})
