/** Backend side of ```html-live: still images and saved paths by source hash, and the phone's open request. */
import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it } from 'vitest'
import { HtmlLiveChannels } from '../../src/shared/ipc-channels'
import { isChannelAllowed, FULL_SCOPES, PHONE_SCOPES } from '../../src/shared/device-auth'
import { registerHtmlLiveHandlers } from '../../src/main/ipc/html-live'
import type { BackendHost } from '../../src/main/backend/host'
import { withBackendRequestContext } from '../../src/main/backend/request-context'
import { HTML_LIVE_OPEN_LIMIT } from '../../src/shared/html-live'
import { getDb } from '../../src/main/db/database'
import { ensureHtmlLivePagesSchema } from '../../src/main/db/html-live-pages'
import Database from 'better-sqlite3'

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

  it('treats a still stored before the current drawing rules as missing, keeps its saved path, and takes a new one', () => {
    // A row written before the version column: a translucent capture with white text on a near-clear background.
    getDb()
      .prepare('INSERT INTO html_live_pages (key, image, saved_path, updated_at) VALUES (?, ?, ?, ?)')
      .run(KEY, PNG, 'old.html', 1)
    expect(h.call(HtmlLiveChannels.LOAD, KEY)).toEqual({ image: null, savedPath: 'old.html' })
    const fresh = 'data:image/png;base64,AAAA'
    expect(h.call(HtmlLiveChannels.UPDATE, KEY, { image: fresh })).toEqual({ ok: true })
    expect(h.call(HtmlLiveChannels.LOAD, KEY)).toEqual({ image: fresh, savedPath: 'old.html' })
    // A saved path written later does not make the still stale again.
    expect(h.call(HtmlLiveChannels.UPDATE, KEY, { savedPath: 'new.html' })).toEqual({ ok: true })
    expect(h.call(HtmlLiveChannels.LOAD, KEY)).toEqual({ image: fresh, savedPath: 'new.html' })
  })

  it('adds the still version to a table from before it, keeping its rows', () => {
    const db = new Database(':memory:')
    db.exec(
      'CREATE TABLE html_live_pages (key TEXT PRIMARY KEY, image TEXT, saved_path TEXT, updated_at INTEGER NOT NULL)',
    )
    db.prepare('INSERT INTO html_live_pages VALUES (?, ?, ?, ?)').run(KEY, PNG, 'old.html', 1)
    ensureHtmlLivePagesSchema(db)
    ensureHtmlLivePagesSchema(db)
    expect(db.prepare('SELECT key, image, image_version, saved_path FROM html_live_pages').all()).toEqual([
      { key: KEY, image: PNG, image_version: null, saved_path: 'old.html' },
    ])
    db.close()
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

  it('limits each phone to a few open requests a minute, and never the desktop', () => {
    const request = { conversationId: 'conv-1', source: '<p>x</p>', title: null }
    const from = (deviceSessionId: string) => () =>
      withBackendRequestContext({ clientScope: 'c', transport: 'remote', deviceSessionId }, () =>
        h.call(HtmlLiveChannels.OPEN_ON_DESKTOP, request),
      )
    const phoneA = from('session-a')
    for (let i = 0; i < HTML_LIVE_OPEN_LIMIT; i++) expect(phoneA()).toEqual({ ok: true })
    expect(phoneA()).toEqual({
      ok: false,
      error: expect.stringMatching(/^Too many open requests\. Try again in \d+ seconds\.$/),
    })
    expect(from('session-b')()).toEqual({ ok: true })
    for (let i = 0; i < HTML_LIVE_OPEN_LIMIT + 2; i++) {
      expect(h.call(HtmlLiveChannels.OPEN_ON_DESKTOP, request)).toEqual({ ok: true })
    }
    expect(h.emitted).toHaveLength(HTML_LIVE_OPEN_LIMIT + 1 + HTML_LIVE_OPEN_LIMIT + 2)
  })

  it('lets a phone read and open, but only a desktop store the image', () => {
    expect(isChannelAllowed(PHONE_SCOPES, HtmlLiveChannels.LOAD)).toBe(true)
    expect(isChannelAllowed(PHONE_SCOPES, HtmlLiveChannels.OPEN_ON_DESKTOP)).toBe(true)
    expect(isChannelAllowed(PHONE_SCOPES, HtmlLiveChannels.UPDATE)).toBe(false)
    expect(isChannelAllowed(FULL_SCOPES, HtmlLiveChannels.UPDATE)).toBe(true)
  })
})
