import React from 'react'
import { Image } from 'react-native'
import { act } from 'react-test-renderer'
import { renderComponent } from '../../test/render'
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
const KEY = '9235215ba9292f8dd21fecf0305a4b7d067e4cb41901b6840e8a6f5f2551a065'
const IMAGE = 'data:image/png;base64,iVBORw0KGgo='
const THREAD = { connectionId: 'mac', threadId: 'thread-1' }
const NO_IMAGE = 'No image yet. Your Mac makes one the next time it is online.'

function fakeClient(capable: boolean, image: string | null) {
  return {
    supportsCapability: jest.fn((name: string) => capable && name === 'html_live_images_v1'),
    htmlLiveLoad: jest.fn(async () => ({ image, savedPath: null })),
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
  expect(client.htmlLiveLoad).toHaveBeenCalledWith(KEY)
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
