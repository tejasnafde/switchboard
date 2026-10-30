/**
 * The phone document's CSP and guard in a real engine (headless Chromium).
 * A probe page tries every network path the CSP must stop; every request that
 * reaches the network layer is recorded, so a leak shows up even when it
 * would have failed. Android serves the document with the CSP header from its
 * own origin; iOS loads it as a string, so only the meta applies. Navigation,
 * window.open and app links are stopped by the WebView callbacks, not the CSP:
 * the phone apps test those. Skipped when no Chromium is installed.
 */
import { existsSync } from 'node:fs'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HtmlLiveTheme } from '../../src/shared/html-live'
import { HTML_LIVE_BLOCKED_MARKER, PHONE_LIVE_CSP, htmlLivePhoneDocument } from '../../src/shared/html-live-phone'

const ORIGIN = 'https://tok.sb-live.invalid'

const THEME: HtmlLiveTheme = {
  scheme: 'dark',
  bg: '#161B22',
  surface: '#21262D',
  text: '#E6EDF3',
  muted: '#8B949E',
  border: '#30363D',
  accent: '#58A6FF',
  success: '#3FB950',
  warning: '#D29922',
  error: '#F85149',
  font: 'sans-serif',
  mono: 'monospace',
  radius: '6px',
  chart: [],
}

const PROBE = `<!doctype html><html><head>
<link rel="stylesheet" href="https://example.com/style.css">
<link rel="preload" href="https://example.com/preload.js" as="script">
<link rel="prefetch" href="https://example.com/prefetch">
<style>
@import url("https://example.com/import.css");
@font-face { font-family: probe; src: url(https://example.com/font.woff); }
body { background: url(https://example.com/bg.png); font-family: probe; }
</style></head><body>
<img src="https://example.com/img.png"><img src="http://10.0.2.2/lan.png"><img src="file:///etc/hosts">
<iframe src="https://example.com/frame"></iframe>
<object data="https://example.com/object"></object>
<video src="https://example.com/v.mp4"></video>
<script src="https://example.com/script.js"></script>
<script>
const out = []
const attempt = async (name, run) => { try { await run(); out.push(name + ':ran') } catch (e) { out.push(name + ':threw') } }
;(async () => {
  await attempt('fetch', () => fetch('https://example.com/fetch'))
  await attempt('fetch-lan', () => fetch('http://10.0.2.2/lan'))
  await attempt('fetch-loopback', () => fetch('http://127.0.0.1:9/loop'))
  await attempt('fetch-file', () => fetch('file:///proc/self/status'))
  await attempt('fetch-content', () => fetch('content://settings/system'))
  await attempt('xhr', () => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('GET', 'https://example.com/xhr'); x.onload = resolve; x.onerror = reject; x.send()
  }))
  await attempt('websocket', () => new WebSocket('wss://example.com/socket'))
  await attempt('eventsource', () => new EventSource('https://example.com/events'))
  await attempt('beacon', () => { if (!navigator.sendBeacon('https://example.com/beacon', 'x')) throw new Error('refused') })
  await attempt('worker', () => new Worker('https://example.com/worker.js'))
  await attempt('rtc', () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:example.com:3478' }] }))
  await attempt('rtc-webkit', () => new webkitRTCPeerConnection({}))
  await new Promise((r) => setTimeout(r, 300))
  console.info('PROBE_DONE ' + out.join(','))
  const form = document.createElement('form'); form.action = 'https://example.com/post'; form.method = 'post'
  document.body.append(form); form.submit()
})()
</script></body></html>`

let browser: Browser | null = null

interface Run {
  outside: string[]
  sockets: string[]
  results: string[]
  blocked: string[]
  lines: string[]
}

function emptyRun(): Run {
  return { outside: [], sockets: [], results: [], blocked: [], lines: [] }
}

async function probe(page: Page, load: () => Promise<unknown>): Promise<Run> {
  const run = emptyRun()
  page.on('websocket', (ws) => run.sockets.push(ws.url()))
  page.on('console', (msg) => {
    const text = msg.text()
    run.lines.push(text)
    if (text.startsWith('PROBE_DONE ')) run.results = text.slice(11).split(',')
    if (text.startsWith(HTML_LIVE_BLOCKED_MARKER)) run.blocked.push(text.slice(HTML_LIVE_BLOCKED_MARKER.length))
  })
  const done = page.waitForEvent('console', { predicate: (m) => m.text().startsWith('PROBE_DONE '), timeout: 15_000 })
  await load()
  await done
  await page.waitForTimeout(500)
  return run
}

async function newPage(run: () => Run | null): Promise<Page> {
  const context = await browser!.newContext()
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (url === `${ORIGIN}/index.html`) return route.continue()
    run()?.outside.push(url)
    // Answer, so a request the CSP let through is seen to succeed.
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' })
  })
  return context.newPage()
}

/** Playwright's own Chromium, or another build named by SB_CHROMIUM. */
const executablePath = process.env.SB_CHROMIUM || chromium.executablePath()
const chromiumMissing = !existsSync(executablePath)

describe.skipIf(chromiumMissing)('phone live page sandbox (Chromium)', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true, executablePath })
  })
  afterAll(async () => {
    await browser?.close()
  })

  function expectSealed(run: Run): void {
    expect(run.outside, 'requests that left the page').toEqual([])
    expect(run.sockets, 'WebSockets opened').toEqual([])
    for (const name of [
      'fetch',
      'fetch-lan',
      'fetch-loopback',
      'fetch-file',
      'fetch-content',
      'xhr',
      'rtc',
      'rtc-webkit',
    ]) {
      expect(run.results, name).toContain(`${name}:threw`)
    }
    expect(run.blocked).toEqual(expect.arrayContaining(['https://example.com/fetch', 'https://example.com/img.png']))
  }

  it('Android: header CSP on the page origin lets nothing out', async () => {
    const holder: { run: Run | null } = { run: emptyRun() }
    const page = await newPage(() => holder.run)
    const html = htmlLivePhoneDocument(PROBE, THEME)
    await page.route(`${ORIGIN}/index.html`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': PHONE_LIVE_CSP, 'X-Content-Type-Options': 'nosniff' },
        body: html,
      }),
    )
    const run = await probe(page, () => page.goto(`${ORIGIN}/index.html`))
    expectSealed({ ...run, outside: holder.run!.outside })
    await page.context().close()
  })

  it('iOS: the meta CSP alone on an opaque page lets nothing out', async () => {
    const holder: { run: Run | null } = { run: emptyRun() }
    const page = await newPage(() => holder.run)
    const run = await probe(page, () => page.setContent(htmlLivePhoneDocument(PROBE, THEME)))
    expectSealed({ ...run, outside: holder.run.outside })
    await page.context().close()
  })

  it('iOS: a three page imports its data: module through the import map', async () => {
    const holder: { run: Run | null } = { run: emptyRun() }
    const page = await newPage(() => holder.run)
    const libraryUrl = (path: string): string =>
      `data:text/javascript;base64,${Buffer.from(`export const NAME = ${JSON.stringify(path)}`).toString('base64')}`
    const source = `<script type="module">
import { NAME } from 'three'
import { NAME as ADDON } from 'three/addons/controls/OrbitControls.js'
console.info('PROBE_DONE ' + NAME + ',' + ADDON)
</script>`
    const run = await probe(page, () => page.setContent(htmlLivePhoneDocument(source, THEME, libraryUrl)))
    expect(run.results).toEqual(['three.js', 'three/addons/controls/OrbitControls.js'])
    expect(holder.run!.outside).toEqual([])
    await page.context().close()
  })

  const FLOOD = `<p>flood</p><script>
console.error('PROBE_DONE first')
console.error(Object.create(null))
for (let i = 0; i < 60; i++) console.error('line ' + i)
</script>`

  it('Android: a page that floods the console still reports its height, and the CSP parses cleanly', async () => {
    const page = await newPage(() => null)
    const errors: string[] = []
    const heights: string[] = []
    page.on('console', (msg) => {
      // The page's own error lines are expected; an engine complaint about our CSP is not.
      if (msg.type() === 'error' && msg.text().includes('Content-Security-Policy')) errors.push(msg.text())
      if (msg.text().startsWith('__sb_live_height__:')) heights.push(msg.text())
    })
    await page.route(`${ORIGIN}/index.html`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': PHONE_LIVE_CSP },
        body: htmlLivePhoneDocument(FLOOD, THEME),
      }),
    )
    await page.goto(`${ORIGIN}/index.html`)
    await page.waitForTimeout(500)
    expect(heights.length).toBeGreaterThan(0)
    expect(errors).toEqual([])
    await page.context().close()
  })

  it('iOS: the bridge gets only report shapes, the height despite a flood, and odd log arguments do not throw', async () => {
    const page = await newPage(() => null)
    await page.addInitScript(() => {
      const posts: string[] = []
      ;(window as unknown as { __posts: string[] }).__posts = posts
      ;(window as unknown as { ReactNativeWebView: unknown }).ReactNativeWebView = {
        postMessage: (m: string) => posts.push(m),
      }
    })
    // Init scripts run on a navigation, so the document comes from the route (meta CSP only).
    await page.route(`${ORIGIN}/index.html`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: htmlLivePhoneDocument(`${FLOOD}<img src="https://example.com/x.png">`, THEME),
      }),
    )
    await page.goto(`${ORIGIN}/index.html`)
    await page.waitForTimeout(500)
    const posts = (await page.evaluate(() => (window as unknown as { __posts: string[] }).__posts)).map((m) =>
      JSON.parse(m),
    )
    expect(posts.every((m) => ['h', 'e', 'b'].includes(m.t))).toBe(true)
    expect(posts.some((m) => m.t === 'h')).toBe(true)
    expect(posts).toContainEqual({ t: 'e', v: 'PROBE_DONE first' })
    expect(posts).toContainEqual({ t: 'e', v: '[object]' })
    expect(posts).toContainEqual({ t: 'b', v: 'https://example.com/x.png' })
    // 50 page lines a second leave the page: the two above and 48 of the flood.
    expect(posts.filter((m) => m.t === 'e')).toHaveLength(50)
    await page.context().close()
  })
})
