/** Backend side of ```html-live: still images and saved paths by source hash, and the phone's open request. */
import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it } from 'vitest'
import { HtmlLiveChannels } from '../../src/shared/ipc-channels'
import { isChannelAllowed, FULL_SCOPES, PHONE_SCOPES } from '../../src/shared/device-auth'
import { registerHtmlLiveHandlers } from '../../src/main/ipc/html-live'
import type { BackendHost } from '../../src/main/backend/host'

const KEY = 'a'.repeat(64)
const PNG = 'data:image/png;base64,iVBORw0KGgo='

function fakeHost() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const emitted: Array<[string, unknown[]]> = []
  const host: BackendHost = {
    handle: (channel, fn) => void handlers.set(channel, fn as (...args: unknown[]) => unknown),
    on: () => {},
    emit: (channel, ...args) => void emitted.push([channel, args]),
  }
  return { host, emitted, call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(...args) }
}

describe('html-live backend', () => {
  let h: ReturnType<typeof fakeHost>
  beforeEach(() => {
    createMigratedDb()
    h = fakeHost()
    registerHtmlLiveHandlers(h.host)
  })

  it('stores a still image and a saved path, and keeps one when the other arrives', () => {
    expect(h.call(HtmlLiveChannels.LOAD, KEY)).toEqual({ image: null, savedPath: null })
    expect(h.call(HtmlLiveChannels.UPDATE, KEY, { image: PNG })).toEqual({ ok: true })
    expect(h.call(HtmlLiveChannels.UPDATE, KEY, { savedPath: 'p95-latency.html' })).toEqual({ ok: true })
    expect(h.call(HtmlLiveChannels.LOAD, KEY)).toEqual({ image: PNG, savedPath: 'p95-latency.html' })
  })

  it('refuses bad keys, non-image data and paths that leave the chat folder', () => {
    expect(h.call(HtmlLiveChannels.LOAD, '../etc')).toEqual({ image: null, savedPath: null })
    expect(h.call(HtmlLiveChannels.UPDATE, 'x', { image: PNG })).toEqual({ ok: false })
    expect(h.call(HtmlLiveChannels.UPDATE, KEY, { image: 'data:text/html;base64,PGI+' })).toEqual({ ok: false })
    for (const savedPath of ['../x.html', '/etc/x.html', 'C:\\x.html', 'x.js', 'a/../../x.html']) {
      expect(h.call(HtmlLiveChannels.UPDATE, KEY, { savedPath }), savedPath).toEqual({ ok: false })
    }
    expect(h.call(HtmlLiveChannels.UPDATE, KEY, {})).toEqual({ ok: false })
  })

  it('pushes a valid open request to the desktop windows', () => {
    const request = { conversationId: 'conv-1', source: '<p>x</p>', title: 'X' }
    expect(h.call(HtmlLiveChannels.OPEN_ON_DESKTOP, request)).toEqual({ ok: true })
    expect(h.call(HtmlLiveChannels.OPEN_ON_DESKTOP, { conversationId: 'c' })).toEqual({ ok: false })
    expect(h.emitted).toEqual([[HtmlLiveChannels.OPEN_REQUEST, [request]]])
  })

  it('lets a phone read and open, but only a desktop store the image', () => {
    expect(isChannelAllowed(PHONE_SCOPES, HtmlLiveChannels.LOAD)).toBe(true)
    expect(isChannelAllowed(PHONE_SCOPES, HtmlLiveChannels.OPEN_ON_DESKTOP)).toBe(true)
    expect(isChannelAllowed(PHONE_SCOPES, HtmlLiveChannels.UPDATE)).toBe(false)
    expect(isChannelAllowed(FULL_SCOPES, HtmlLiveChannels.UPDATE)).toBe(true)
  })
})
