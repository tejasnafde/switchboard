import React from 'react'
import { Image } from 'react-native'
import { act } from 'react-test-renderer'
import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { PHONE_LIVE_DESKTOP_ONLY_NOTE } from '@shared/html-live-phone'
import { renderComponent, type Node } from '../../test/render'
import { noteLivePageScroll, resetLivePages, setLivePagesActive } from '../../lib/live-pages'
import { usePrefsStore } from '../../stores/prefs'
import { HtmlLiveCard, clearHtmlLiveCache } from '../HtmlLiveCard'
import { Markdown } from '../Markdown'
import { getClient } from '../../stores/connections'

jest.mock('expo-crypto', () => {
  const { createHash } = jest.requireActual('crypto')
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
    digestStringAsync: jest.fn(async (_algorithm: string, data: string) =>
      createHash('sha256').update(data, 'utf8').digest('hex'),
    ),
  }
})
jest.mock('../../stores/connections', () => ({ getClient: jest.fn() }))

const SOURCE = '<script src="/_sb/chart.js"></script>\n<canvas id="c"></canvas>'
const SOURCE_HASH = '9235215ba9292f8dd21fecf0305a4b7d067e4cb41901b6840e8a6f5f2551a065'
const IMAGE = 'data:image/png;base64,iVBORw0KGgo='
const THREAD = { connectionId: 'mac', threadId: 'thread-1' }
const NO_IMAGE = 'No image yet. Your Mac makes one the next time it is online.'

function fakeClient(capable: boolean, image: string | null, savedPath: string | null = null) {
  return {
    supportsCapability: jest.fn((name: string) => capable && name === 'html_live_images_v1'),
    htmlLiveLoad: jest.fn(async () => ({ image, savedPath })),
    htmlLiveOpenOnDesktop: jest.fn(async () => ({ ok: true })),
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

beforeEach(() => {
  clearHtmlLiveCache()
  // jest-expo's native image loader mock answers the callback form RN 0.86 no longer passes it.
  jest.spyOn(Image, 'getSize').mockImplementation((_uri, success) => success?.(400, 1200))
})

it('says there is no image yet when the backend has none', async () => {
  const client = fakeClient(true, null)
  jest.mocked(getClient).mockReturnValue(client as never)
  const root = renderComponent(<HtmlLiveCard source={SOURCE} title="Latency" thread={THREAD} />)
  await flush()
  expect(client.htmlLiveLoad).toHaveBeenCalledWith(SOURCE_HASH)
  expect(root.texts()).toContain(NO_IMAGE)
  expect(root.texts()).toContain('Latency')
})

it('shows the stored still image', async () => {
  const client = fakeClient(true, IMAGE)
  jest.mocked(getClient).mockReturnValue(client as never)
  const root = renderComponent(<HtmlLiveCard source={SOURCE} title={null} thread={THREAD} />)
  await flush()
  const image = root.root.find((n) => n.props.testID === 'html-live-image' && typeof n.type === 'string')
  expect(image.props.source).toEqual({ uri: IMAGE })
  expect(root.texts()).toContain('Still image. Interactive on your Mac.')
  expect(root.texts()).toContain('Live page')
})

it('crops a tall image and opens the whole one', async () => {
  const client = fakeClient(true, IMAGE)
  jest.mocked(getClient).mockReturnValue(client as never)
  const root = renderComponent(<HtmlLiveCard source={SOURCE} title="Tall" thread={THREAD} />)
  await flush()
  const card = root.root.find((n) => typeof n.type === 'string' && typeof n.props.onLayout === 'function')
  act(() => card.props.onLayout({ nativeEvent: { layout: { width: 300, height: 0 } } }))
  expect(root.texts()).toContain('First 480 px. Tap to view the whole image.')
  act(() => root.byLabel('View the whole image of Tall').props.onPress())
  expect(root.byLabel('Close image')).toBeTruthy()
})

it('never calls the backend when it lacks the capability', async () => {
  const client = fakeClient(false, IMAGE)
  jest.mocked(getClient).mockReturnValue(client as never)
  const root = renderComponent(<HtmlLiveCard source={SOURCE} title={null} thread={THREAD} />)
  await flush()
  act(() => root.byLabel('Show source').props.onPress())
  expect(root.allByLabel('Open on desktop')).toHaveLength(0)
  expect(client.htmlLiveLoad).not.toHaveBeenCalled()
  expect(client.htmlLiveOpenOnDesktop).not.toHaveBeenCalled()
  act(() => root.byLabel('Show image').props.onPress())
  expect(root.texts()).toContain(NO_IMAGE)
})

it('asks the desktop to open the page', async () => {
  const client = fakeClient(true, null)
  jest.mocked(getClient).mockReturnValue(client as never)
  const root = renderComponent(<HtmlLiveCard source={SOURCE} title="Latency" thread={THREAD} />)
  await flush()
  act(() => root.byLabel('Show source').props.onPress())
  expect(root.texts()).toContain(SOURCE)
  await act(async () => {
    root.byLabel('Open on desktop').props.onPress()
  })
  await flush()
  expect(client.htmlLiveOpenOnDesktop).toHaveBeenCalledWith({
    conversationId: 'thread-1',
    source: SOURCE,
    title: 'Latency',
  })
  expect(root.texts()).toContain('Opened on your Mac')
})

it('shows the backend refusal when the desktop rate-limits the open', async () => {
  const limited = 'Too many open requests. Try again in 12 seconds.'
  const client = fakeClient(true, null)
  client.htmlLiveOpenOnDesktop.mockResolvedValue({ ok: false, error: limited } as never)
  jest.mocked(getClient).mockReturnValue(client as never)
  const root = renderComponent(<HtmlLiveCard source={SOURCE} title="Latency" thread={THREAD} />)
  await flush()
  act(() => root.byLabel('Show source').props.onPress())
  await act(async () => {
    root.byLabel('Open on desktop').props.onPress()
  })
  await flush()
  expect(root.texts()).toContain(limited)
})

it('shares the still image as a PNG named after the saved page', async () => {
  const client = fakeClient(true, IMAGE, 'pages/latency chart.html')
  jest.mocked(getClient).mockReturnValue(client as never)
  const root = renderComponent(<HtmlLiveCard source={SOURCE} title="Latency" thread={THREAD} />)
  await flush()
  act(() => root.byLabel('Show source').props.onPress())
  await act(async () => {
    root.byLabel('Share image').props.onPress()
  })
  await flush()
  expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith('file:///cache/latency-chart.png', 'iVBORw0KGgo=', {
    encoding: 'base64',
  })
  expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/latency-chart.png', {
    mimeType: 'image/png',
    UTI: 'public.png',
    dialogTitle: 'Share image',
  })
})

it('offers no Share image without a still image', async () => {
  const client = fakeClient(true, null)
  jest.mocked(getClient).mockReturnValue(client as never)
  const root = renderComponent(<HtmlLiveCard source={SOURCE} title="Latency" thread={THREAD} />)
  await flush()
  act(() => root.byLabel('Show source').props.onPress())
  expect(root.byLabel('Open on desktop')).toBeTruthy()
  expect(root.allByLabel('Share image')).toHaveLength(0)
})

it('renders an html-live block in Markdown, an unclosed one as code', async () => {
  jest.mocked(getClient).mockReturnValue(undefined)
  const streaming = renderComponent(<Markdown text={'Here:\n```html-live title="Chart"\n<b>hi</b>'} />)
  expect(streaming.texts()).toContain('<b>hi</b>')
  expect(streaming.texts()).not.toContain('Writing')
  expect(streaming.texts()).not.toContain(NO_IMAGE)
  const closed = renderComponent(<Markdown text={'Here:\n```html-live title="Chart"\n<b>hi</b>\n```\nDone.'} />)
  await flush()
  expect(closed.texts()).toContain('Chart')
  expect(closed.texts()).toContain(NO_IMAGE)
})

describe('live pages (phone_html_live_run)', () => {
  const LIVE_TITLE = 'Latency'
  let top = 100
  // Every mocked host view shares this instance method.
  const { measureInWindow } = jest.requireActual('@react-native/jest-preset/jest/MockNativeMethods').default

  async function settle(ms = 0): Promise<void> {
    await flush()
    act(() => jest.advanceTimersByTime(ms))
    await flush()
  }

  function liveWebView(root: Node): Node | undefined {
    return root.findAll((n) => n.props.testID === 'html-live-webview' && typeof n.type === 'string')[0]
  }

  async function renderLive(source = SOURCE, image: string | null = IMAGE) {
    const client = fakeClient(true, image)
    jest.mocked(getClient).mockReturnValue(client as never)
    const rendered = renderComponent(<HtmlLiveCard source={source} title={LIVE_TITLE} thread={THREAD} />)
    await settle(400)
    return { ...rendered, client }
  }

  async function run(rendered: { byLabel: (label: string) => Node }, label = 'Run'): Promise<void> {
    act(() => rendered.byLabel(label).props.onPress())
    await settle(400)
  }

  beforeEach(() => {
    jest.useFakeTimers()
    top = 100
    measureInWindow.mockImplementation((cb: (x: number, y: number, w: number, h: number) => void) =>
      cb(0, top, 300, 200),
    )
    resetLivePages()
    setLivePagesActive(true)
    usePrefsStore.setState({ liveHtmlPages: true })
  })
  afterEach(() => {
    resetLivePages()
    jest.useRealTimers()
  })

  it('never runs and offers no Run while the flag is off', async () => {
    usePrefsStore.setState({ liveHtmlPages: false })
    const { root, allByLabel, texts } = await renderLive()
    expect(allByLabel('Run')).toHaveLength(0)
    expect(liveWebView(root)).toBeUndefined()
    expect(texts()).toContain('Still image. Interactive on your Mac.')
  })

  it('waits for Run on a phone whose memory is unknown, then runs in view', async () => {
    const rendered = await renderLive()
    expect(liveWebView(rendered.root)).toBeUndefined()
    expect(rendered.byLabel('Run')).toBeTruthy()
    await run(rendered)
    expect(liveWebView(rendered.root)).toBeDefined()
    expect(rendered.texts()).toContain('Live. Tap to open full screen.')
  })

  it('offers no Run when the verdict fails', async () => {
    const rendered = await renderLive('<script src="/_sb/jquery.js"></script>')
    expect(rendered.allByLabel('Run')).toHaveLength(0)
    expect(liveWebView(rendered.root)).toBeUndefined()
  })

  it('keeps a mermaid page on its still image with the desktop-only note', async () => {
    const rendered = await renderLive(
      '<script src="/_sb/mermaid.js"></script><div class="mermaid">graph TD; A-->B</div>',
    )
    expect(rendered.allByLabel('Run')).toHaveLength(0)
    expect(rendered.texts()).toContain(PHONE_LIVE_DESKTOP_ONLY_NOTE)
  })

  it('keeps the row height when the still image and the page swap', async () => {
    const rendered = await renderLive()
    const card = rendered.root.find((n) => typeof n.type === 'string' && typeof n.props.onLayout === 'function')
    act(() => card.props.onLayout({ nativeEvent: { layout: { width: 300, height: 0 } } }))
    const stillBox = () => rendered.byLabel(`View the whole image of ${LIVE_TITLE}`).props.style.height
    expect(stillBox()).toBe(480)
    await run(rendered)
    const liveBox = () => rendered.byLabel(`Open ${LIVE_TITLE} full screen`).props.style.height
    expect(liveBox()).toBe(480)
    act(() =>
      liveWebView(rendered.root)?.props.onMessage({ nativeEvent: { data: JSON.stringify({ t: 'h', v: 210 }) } }),
    )
    await settle(100)
    expect(liveBox()).toBe(210)
    act(() => setLivePagesActive(false))
    expect(liveWebView(rendered.root)).toBeUndefined()
    expect(stillBox()).toBe(210)
  })

  it('takes no touches inline and opens a full-screen view that gets them', async () => {
    const rendered = await renderLive()
    await run(rendered)
    const inline = liveWebView(rendered.root)
    expect(inline?.props.scrollEnabled).toBe(false)
    expect(rendered.root.findAll((n) => n.props.pointerEvents === 'none' && typeof n.type === 'string')).toHaveLength(1)
    act(() => rendered.byLabel(`Open ${LIVE_TITLE} full screen`).props.onPress())
    await settle(0)
    expect(rendered.texts()).toContain('Live page from the agent')
    const full = liveWebView(rendered.root)
    expect(full?.props.scrollEnabled).toBe(true)
    expect(
      rendered.root.findAll((n) => n.props.testID === 'html-live-webview' && typeof n.type === 'string'),
    ).toHaveLength(1)
    act(() => rendered.byLabel('Close live page').props.onPress())
    await settle(0)
    expect(liveWebView(rendered.root)?.props.scrollEnabled).toBe(false)
  })

  it('stops when the page leaves view, on blur and in the background', async () => {
    const rendered = await renderLive()
    await run(rendered)
    top = -190
    act(() => noteLivePageScroll())
    await settle(299)
    expect(liveWebView(rendered.root)).toBeDefined()
    await settle(1)
    expect(liveWebView(rendered.root)).toBeUndefined()
    top = 100
    act(() => noteLivePageScroll())
    await settle(300)
    expect(liveWebView(rendered.root)).toBeDefined()
    act(() => setLivePagesActive(false))
    expect(liveWebView(rendered.root)).toBeUndefined()
  })

  it('shows the crash text, offers Run again once, then no Run after a second crash', async () => {
    const rendered = await renderLive()
    await run(rendered)
    act(() => liveWebView(rendered.root)?.props.onContentProcessDidTerminate({ nativeEvent: {} }))
    await settle(400)
    expect(liveWebView(rendered.root)).toBeUndefined()
    expect(rendered.texts()).toContain('This page stopped.')
    expect(rendered.byLabel('Run again')).toBeTruthy()
    expect(rendered.byLabel(`View the whole image of ${LIVE_TITLE}`)).toBeTruthy()
    await run(rendered, 'Run again')
    act(() => liveWebView(rendered.root)?.props.onContentProcessDidTerminate({ nativeEvent: {} }))
    await settle(400)
    expect(rendered.texts()).toContain('This page stopped.')
    expect(rendered.allByLabel('Run again')).toHaveLength(0)
    expect(rendered.allByLabel('Run')).toHaveLength(0)
    act(() => rendered.byLabel('Show source').props.onPress())
    expect(rendered.byLabel('Copy source')).toBeTruthy()
    expect(rendered.byLabel('Open on desktop')).toBeTruthy()
  })

  it('keeps Source, Copy source and Open on desktop while a page runs', async () => {
    const rendered = await renderLive()
    await run(rendered)
    act(() => rendered.byLabel('Show source').props.onPress())
    expect(rendered.byLabel('Copy source')).toBeTruthy()
    expect(rendered.byLabel('Open on desktop')).toBeTruthy()
  })

  it('stops a page that reports no height within 8 s', async () => {
    const rendered = await renderLive(SOURCE, null)
    await run(rendered)
    expect(liveWebView(rendered.root)).toBeDefined()
    await settle(8000)
    expect(liveWebView(rendered.root)).toBeUndefined()
    expect(rendered.texts()).toContain('This page stopped.')
    expect(rendered.byLabel('Run again')).toBeTruthy()
  })
})
