/**
 * Phone live pages: the document order (our CSP before any page byte), the
 * CSP directives, the verdict, the run slot and the report parsers.
 *   SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/html-live-phone.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HtmlLiveTheme } from '../../src/shared/html-live'
import {
  PHONE_LIVE_CSP,
  htmlLivePhoneDocument,
  htmlLivePhoneVerdict,
  parsePhoneLiveConsole,
  parsePhoneLiveMessage,
  phoneLiveLowRam,
  phoneLiveRateGate,
  phoneLiveRunning,
  type PhoneLiveCandidate,
} from '../../src/shared/html-live-phone'

const FIXTURE = join(__dirname, '../fixtures/html-live-phone-document.json')

const PHONE_THEME: HtmlLiveTheme = {
  scheme: 'dark',
  bg: '#161B22',
  surface: '#21262D',
  text: '#E6EDF3',
  muted: '#8B949E',
  border: 'rgba(255,255,255,0.14)',
  accent: '#58A6FF',
  success: '#3FB950',
  warning: '#D29922',
  error: '#F85149',
  font: 'sans-serif',
  mono: 'monospace',
  radius: '6px',
  chart: ['#58A6FF', '#3FB950', '#D29922', '#BC8CFF', '#39C5CF', '#DB61A2'],
}

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PHONE_LIVE_CSP}">`

const SOURCES: Record<string, string> = {
  fragment: '<div id="x">hi</div><script>x.textContent = "ok"</script>',
  fullDocument: '<!DOCTYPE html><html><head><title>t</title></head><body><p>b</p></body></html>',
  scriptBeforeHead: '<script>fetch("https://example.com")</script><html><head></head><body></body></html>',
  headInComment: '<!-- <head> --><script>window.early = 1</script><p>x</p>',
  chart: '<script src="/_sb/chart.js"></script><canvas id="c"></canvas>',
  three:
    '<script type="module">import * as THREE from "three"; import { OrbitControls } from "three/addons/controls/OrbitControls.js"</script>',
}

const dataUrl = (path: string): string => `data:text/javascript;base64,${Buffer.from(`/*${path}*/`).toString('base64')}`

function cases(): Array<{ name: string; source: string; inline: boolean; document: string }> {
  return Object.entries(SOURCES).flatMap(([name, source]) => [
    { name, source, inline: false, document: htmlLivePhoneDocument(source, PHONE_THEME) },
    { name: `${name}-inline`, source, inline: true, document: htmlLivePhoneDocument(source, PHONE_THEME, dataUrl) },
  ])
}

/** Source list of one directive. */
function directive(name: string): string[] {
  const entry = PHONE_LIVE_CSP.split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([n]) => n === name)
  if (!entry) throw new Error(`no ${name}`)
  return entry.slice(1)
}

/** Whether a source list lets `url` load into a page whose origin is `self` (null: opaque). */
function allows(sources: string[], url: string, self: string | null): boolean {
  if (sources.includes("'none'")) return false
  const parsed = new URL(url)
  if (sources.includes(parsed.protocol)) return true
  if (sources.includes("'self'") && self !== null && parsed.origin === self) return true
  return sources.some((s) => !s.startsWith("'") && !s.endsWith(':'))
}

describe('htmlLivePhoneDocument', () => {
  it.each(Object.entries(SOURCES))('puts the CSP meta before any page byte: %s', (_name, source) => {
    for (const doc of [
      htmlLivePhoneDocument(source, PHONE_THEME),
      htmlLivePhoneDocument(source, PHONE_THEME, dataUrl),
    ]) {
      expect(doc.startsWith(`<!doctype html><html data-sb-theme="dark"><head>${CSP_META}<script>`)).toBe(true)
      const page = source.replace(/^<!doctype[^>]*>/i, '')
      expect(doc.indexOf(page)).toBeGreaterThan(doc.indexOf(CSP_META))
      expect(doc.indexOf('RTCPeerConnection')).toBeLessThan(doc.indexOf(page))
    }
  })

  it('removes a leading doctype and keeps a full document whole', () => {
    const doc = htmlLivePhoneDocument(SOURCES.fullDocument, PHONE_THEME)
    expect(doc.match(/<!doctype/gi)).toHaveLength(1)
    expect(doc).toContain('<html><head><title>t</title></head><body><p>b</p></body></html>')
  })

  it('runs the guard before the theme and the size reporter', () => {
    const doc = htmlLivePhoneDocument(SOURCES.fragment, PHONE_THEME)
    expect(doc.indexOf('RTCPeerConnection')).toBeLessThan(doc.indexOf('__sb_live_height__'))
    expect(doc).toContain('body{overflow-x:auto}')
  })

  it('serves libraries from the page origin on Android', () => {
    const doc = htmlLivePhoneDocument(SOURCES.three, PHONE_THEME)
    expect(doc).toContain('"three":"/_sb/three.js"')
    expect(doc).not.toContain('data:text/javascript')
  })

  it('inlines only the named libraries on iOS: classic as scripts, modules in the import map', () => {
    const chart = htmlLivePhoneDocument(SOURCES.chart, PHONE_THEME, dataUrl)
    expect(chart).toContain(`<script src="${dataUrl('chart.js')}"></script>`)
    expect(chart).toContain('<script type="importmap">{"imports":{}}</script>')
    const three = htmlLivePhoneDocument(SOURCES.three, PHONE_THEME, dataUrl)
    expect(three).toContain(`"three":"${dataUrl('three.js')}"`)
    expect(three).toContain(
      `"three/addons/controls/OrbitControls.js":"${dataUrl('three/addons/controls/OrbitControls.js')}"`,
    )
    expect(three).not.toContain(dataUrl('chart.js'))
    expect(htmlLivePhoneDocument('<script src="/_sb/mermaid.js"></script>', PHONE_THEME, dataUrl)).not.toContain(
      dataUrl('mermaid.js'),
    )
  })

  it('keeps tests/fixtures/html-live-phone-document.json equal to the builder', () => {
    const expected = `${JSON.stringify({ theme: PHONE_THEME, cases: cases() }, null, 2)}\n`
    if (process.env.SB_UPDATE_FIXTURES === '1') writeFileSync(FIXTURE, expected)
    expect(
      readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n'),
      'tests/fixtures/html-live-phone-document.json is stale: run SB_UPDATE_FIXTURES=1 npx vitest run tests/unit/html-live-phone.test.ts',
    ).toBe(expected)
  })
})

describe('PHONE_LIVE_CSP', () => {
  const ANDROID = 'https://tok.sb-live.invalid'
  const OUTSIDE = [
    'https://example.com/x',
    'http://10.0.2.2/x',
    'http://127.0.0.1:9/x',
    'wss://example.com/s',
    'ws://192.168.1.2/s',
    'file:///proc/self/status',
    'content://settings/system',
    'intent://x#Intent;end',
    'https://other.sb-live.invalid/_sb/chart.js',
  ]

  it.each([
    ['connect-src', 'fetch, XHR, WebSocket, EventSource, sendBeacon'],
    ['img-src', '<img src> and CSS url() images'],
    ['style-src', 'stylesheets and @import'],
    ['font-src', '@font-face'],
    ['script-src', 'scripts'],
    ['media-src', 'audio and video'],
    ['object-src', 'plugins'],
    ['frame-src', 'frames'],
    ['form-action', 'form posts'],
  ])('%s blocks every outside URL (%s)', (name) => {
    for (const url of OUTSIDE) {
      expect(allows(directive(name), url, ANDROID), `${name} ${url} on Android`).toBe(false)
      expect(allows(directive(name), url, null), `${name} ${url} on iOS`).toBe(false)
    }
  })

  it('lets an Android page load its own libraries and nothing on iOS by self', () => {
    expect(allows(directive('script-src'), `${ANDROID}/_sb/chart.js`, ANDROID)).toBe(true)
    expect(allows(directive('script-src'), `${ANDROID}/_sb/chart.js`, null)).toBe(false)
    expect(allows(directive('script-src'), 'data:text/javascript;base64,AA==', null)).toBe(true)
  })

  it('names a source list for every fetch directive and bars base and form targets', () => {
    expect(directive('default-src')).toEqual(["'none'"])
    expect(directive('base-uri')).toEqual(["'none'"])
    expect(directive('form-action')).toEqual(["'none'"])
    expect(PHONE_LIVE_CSP).not.toMatch(/\*|https?:|wss?:/)
  })
})

describe('htmlLivePhoneVerdict', () => {
  it('refuses an open fence, mermaid, an unknown library and an oversize page', () => {
    expect(htmlLivePhoneVerdict(SOURCES.chart, false)).toEqual({ ok: false, reason: 'open' })
    expect(htmlLivePhoneVerdict('<script src="/_sb/mermaid.js"></script>', true)).toEqual({
      ok: false,
      reason: 'desktop-only',
      names: ['mermaid.js'],
    })
    expect(htmlLivePhoneVerdict('<script src="/_sb/vue.js"></script>', true)).toMatchObject({
      reason: 'unknown-library',
    })
    expect(htmlLivePhoneVerdict('x'.repeat(128 * 1024 + 1), true)).toMatchObject({ reason: 'too-large' })
  })

  it('runs a closed page that uses the shipped libraries', () => {
    expect(htmlLivePhoneVerdict(SOURCES.three, true)).toEqual({ ok: true, libraries: ['Three.js'] })
    expect(htmlLivePhoneVerdict('x'.repeat(128 * 1024), true)).toEqual({ ok: true, libraries: [] })
  })
})

describe('phoneLiveRunning', () => {
  const page = (key: string, visible: number, extra: Partial<PhoneLiveCandidate> = {}): PhoneLiveCandidate => ({
    key,
    visible,
    runPressed: false,
    fullScreen: false,
    ...extra,
  })
  const still = { listStillMs: 300, lowRam: false, crashes: new Map<string, number>() }

  it('runs one page: the most visible, at least half in view, once the list is still', () => {
    expect(phoneLiveRunning([page('a', 0.6), page('b', 0.9)], still)).toBe('b')
    expect(phoneLiveRunning([page('a', 0.49)], still)).toBeNull()
    expect(phoneLiveRunning([page('a', 1)], { ...still, listStillMs: 299 })).toBeNull()
  })

  it('gives the slot to the full-screen view', () => {
    expect(phoneLiveRunning([page('a', 1), page('b', 0, { fullScreen: true })], { ...still, listStillMs: 0 })).toBe('b')
  })

  it('needs Run on a low-RAM phone', () => {
    const low = { ...still, lowRam: true }
    expect(phoneLiveRunning([page('a', 1)], low)).toBeNull()
    expect(phoneLiveRunning([page('a', 1, { runPressed: true })], low)).toBe('a')
    expect(phoneLiveLowRam(3 * 1024 ** 3 - 1)).toBe(true)
    expect(phoneLiveLowRam(3 * 1024 ** 3)).toBe(false)
    expect(phoneLiveLowRam(8 * 1024 ** 3, true)).toBe(true)
  })

  it('does not retry a crashed page by itself and blocks a key after two crashes', () => {
    expect(phoneLiveRunning([page('a', 1)], { ...still, crashes: new Map([['a', 1]]) })).toBeNull()
    expect(phoneLiveRunning([page('a', 1, { runPressed: true })], { ...still, crashes: new Map([['a', 1]]) })).toBe('a')
    const twice = { ...still, crashes: new Map([['a', 2]]) }
    expect(phoneLiveRunning([page('a', 1, { runPressed: true }), page('b', 0.6)], twice)).toBe('b')
    expect(phoneLiveRunning([page('a', 0, { fullScreen: true })], twice)).toBeNull()
  })
})

describe('report parsers', () => {
  it('reads only the three message shapes under the size cap', () => {
    expect(parsePhoneLiveMessage('{"t":"h","v":240}')).toEqual({ t: 'h', v: 240 })
    expect(parsePhoneLiveMessage('{"t":"e","v":"boom"}')).toEqual({ t: 'e', v: 'boom' })
    expect(parsePhoneLiveMessage('{"t":"b","v":"https://example.com/"}')).toEqual({ t: 'b', v: 'https://example.com/' })
    for (const bad of [
      '{"t":"h","v":-1}',
      '{"t":"h","v":"240"}',
      '{"t":"open","v":"https://example.com"}',
      '{"t":"e","v":{}}',
      '[1]',
      'null',
      'not json',
      JSON.stringify({ t: 'e', v: 'x'.repeat(1100) }),
      42,
    ]) {
      expect(parsePhoneLiveMessage(bad), String(bad)).toBeNull()
    }
  })

  it('reads console lines the way the guard writes them', () => {
    expect(parsePhoneLiveConsole('__sb_live_height__:310', false)).toEqual({ t: 'h', v: 310 })
    expect(parsePhoneLiveConsole('__sb_live_blocked__:https://example.com/', false)).toEqual({
      t: 'b',
      v: 'https://example.com/',
    })
    expect(parsePhoneLiveConsole('Uncaught TypeError', true)).toEqual({ t: 'e', v: 'Uncaught TypeError' })
    expect(parsePhoneLiveConsole('hello', false)).toBeNull()
    expect(parsePhoneLiveConsole('__sb_live_height__:NaN', false)).toBeNull()
    expect(parsePhoneLiveConsole(`__sb_live_blocked__:${'x'.repeat(5000)}`, false)?.v).toHaveLength(300)
  })

  it('lets at most the limit through in each second', () => {
    const gate = phoneLiveRateGate(3)
    expect([0, 10, 20, 30].map(gate)).toEqual([true, true, true, false])
    expect(gate(1000)).toBe(true)
  })
})
