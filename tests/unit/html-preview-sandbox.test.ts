/**
 * HTML preview sandbox: the page cannot reach the network, cannot open a
 * window, cannot leave its file and cannot read a file outside its folder.
 * Real tmp directories; the guest WebContents is a recording fake.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  PreviewController,
  PREVIEW_CSP,
  PREVIEW_RELOAD_DEBOUNCE_MS,
  resolvePreviewAsset,
} from '../../src/main/preview/preview-controller'
import { PREVIEW_MAX_BYTES, type PreviewEvent } from '../../src/shared/html-preview'

function fakeGuest() {
  const listeners = new Map<string, (event: { preventDefault(): void }, url: string) => void>()
  let openHandler: ((details: { url: string }) => { action: 'deny' }) | null = null
  return {
    contents: {
      setWindowOpenHandler: (handler: (details: { url: string }) => { action: 'deny' }) => {
        openHandler = handler
      },
      on: (event: string, listener: (event: { preventDefault(): void }, url: string) => void) => {
        listeners.set(event, listener)
      },
    },
    open: (url: string) => openHandler?.({ url }),
    navigate: (event: 'will-navigate' | 'will-redirect', url: string): boolean => {
      let prevented = false
      listeners.get(event)?.({ preventDefault: () => (prevented = true) }, url)
      return prevented
    },
  }
}

describe('html preview sandbox', () => {
  let base: string
  let folder: string
  let events: PreviewEvent[]
  let ctl: PreviewController

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'sb-html-preview-')))
    folder = join(base, 'design')
    mkdirSync(join(folder, 'assets'), { recursive: true })
    writeFileSync(join(folder, 'page.html'), '<h1>hi</h1>')
    writeFileSync(join(folder, 'assets', 'app.css'), 'h1{color:red}')
    writeFileSync(join(base, 'secret.txt'), 'secret')
    mkdirSync(join(base, 'design-other'))
    writeFileSync(join(base, 'design-other', 'x.css'), 'x')
    events = []
    ctl = new PreviewController((event) => events.push(event))
  })

  afterEach(() => {
    ctl.close()
    rmSync(base, { recursive: true, force: true })
  })

  async function openPage() {
    const result = await ctl.open({ kind: 'file', root: base, filePath: join(folder, 'page.html') })
    if (!result.ok) throw new Error(`open failed: ${result.error}`)
    return result
  }

  it('blocks every network request and reports it', async () => {
    const { token } = await openPage()
    for (const url of [
      'https://cdn.example.net/chart.js',
      'http://127.0.0.1:8080/api',
      'wss://example.com/socket',
      `file://${join(base, 'secret.txt')}`,
      'sb-favicon://favicon?path=/',
    ]) {
      expect(ctl.shouldCancelRequest({ url })).toBe(true)
    }
    expect(events.filter((e) => e.type === 'blocked')).toHaveLength(5)
    expect(events.every((e) => e.token === token)).toBe(true)
  })

  it('allows only the current document origin and inline data', async () => {
    const first = await openPage()
    expect(ctl.shouldCancelRequest({ url: first.url })).toBe(false)
    expect(ctl.shouldCancelRequest({ url: 'data:text/css,h1{}' })).toBe(false)
    const second = await openPage()
    // A page from the previous open can no longer load anything.
    expect(ctl.shouldCancelRequest({ url: first.url })).toBe(true)
    expect(ctl.shouldCancelRequest({ url: second.url })).toBe(false)
  })

  it('cannot open a window', async () => {
    await openPage()
    const guest = fakeGuest()
    ctl.attachGuards(guest.contents)
    expect(guest.open('https://example.com')).toEqual({ action: 'deny' })
    expect(guest.open('sb-preview://x/page.html')).toEqual({ action: 'deny' })
  })

  it('cannot navigate away from the file', async () => {
    const { url, token } = await openPage()
    const guest = fakeGuest()
    ctl.attachGuards(guest.contents)
    expect(guest.navigate('will-navigate', 'https://example.com')).toBe(true)
    expect(guest.navigate('will-navigate', `sb-preview://${token}/other.html`)).toBe(true)
    expect(guest.navigate('will-redirect', 'file:///etc/hosts')).toBe(true)
    expect(guest.navigate('will-navigate', url)).toBe(false)
    expect(guest.navigate('will-navigate', `${url}#plans`)).toBe(false)
  })

  it('serves the file and the files in its folder with a locked-down CSP', async () => {
    const { url, token } = await openPage()
    const page = await ctl.serve(url)
    expect(page.status).toBe(200)
    expect(await page.text()).toBe('<h1>hi</h1>')
    expect(page.headers.get('content-security-policy')).toBe(PREVIEW_CSP)
    const css = await ctl.serve(`sb-preview://${token}/assets/app.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
  })

  it('cannot read a file outside its folder', async () => {
    const { token } = await openPage()
    symlinkSync(join(base, 'secret.txt'), join(folder, 'link.txt'))
    for (const path of [
      '../secret.txt',
      '%2e%2e/secret.txt',
      '..%2fsecret.txt',
      '%2e%2e%5csecret.txt',
      '../design-other/x.css',
      'link.txt',
      `${encodeURIComponent(join(base, 'secret.txt'))}`,
    ]) {
      const res = await ctl.serve(`sb-preview://${token}/${path}`)
      expect(res.status, path).toBe(404)
    }
    expect(await resolvePreviewAsset(folder, '../secret.txt')).toBeNull()
    expect(await resolvePreviewAsset(folder, 'link.txt')).toBeNull()
  })

  it('serves nothing for another token', async () => {
    await openPage()
    const res = await ctl.serve('sb-preview://0123456789abcdef01234567/page.html')
    expect(res.status).toBe(404)
  })

  it('serves remote content alone, never by path', async () => {
    const result = await ctl.open({ kind: 'content', fileName: '../../etc/page.html', html: '<p>remote</p>' })
    if (!result.ok) throw new Error('open failed')
    expect(result.url).toBe(`sb-preview://${result.token}/page.html`)
    expect(await (await ctl.serve(result.url)).text()).toBe('<p>remote</p>')
    expect((await ctl.serve(`sb-preview://${result.token}/style.css`)).status).toBe(404)
  })

  it('refuses a file outside the chat folder', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sb-html-preview-out-')))
    try {
      writeFileSync(join(outside, 'x.html'), '<p>x</p>')
      symlinkSync(join(outside, 'x.html'), join(folder, 'linked.html'))
      for (const filePath of [join(outside, 'x.html'), join(folder, 'linked.html')]) {
        expect(await ctl.open({ kind: 'file', root: base, filePath })).toMatchObject({ ok: false, error: 'failed' })
      }
      expect(ctl.currentToken).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses missing, oversized and non-html files', async () => {
    expect(await ctl.open({ kind: 'file', root: base, filePath: join(folder, 'gone.html') })).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(await ctl.open({ kind: 'file', root: base, filePath: join(base, 'secret.txt') })).toEqual({
      ok: false,
      error: 'not-html',
    })
    const big = join(folder, 'big.html')
    writeFileSync(big, Buffer.alloc(PREVIEW_MAX_BYTES + 1, 'a'))
    expect(await ctl.open({ kind: 'file', root: base, filePath: big })).toMatchObject({ ok: false, error: 'too-large' })
    expect(
      await ctl.open({ kind: 'content', fileName: 'big.html', html: 'a'.repeat(PREVIEW_MAX_BYTES + 1) }),
    ).toMatchObject({ ok: false, error: 'too-large' })
  })

  it('reports a change on disk once per burst of writes', async () => {
    const { token } = await openPage()
    const changed = { type: 'changed', token }
    const quietMs = PREVIEW_RELOAD_DEBOUNCE_MS * 2
    const poll = { timeout: 10_000, interval: quietMs }

    // fs.watch can return before macOS delivers notifications. Observe a setup
    // asset write before measuring the page writes, without retrying either burst.
    await expect
      .poll(() => {
        if (events.some((e) => e.type === 'changed')) return true
        writeFileSync(join(folder, 'ready.css'), 'h1{color:blue}')
        return false
      }, poll)
      .toBe(true)
    await delay(quietMs)
    events.length = 0

    for (const burst of [1, 2]) {
      writeFileSync(join(folder, 'page.html'), `<h1>v${burst * 2}</h1>`)
      writeFileSync(join(folder, 'page.html'), `<h1>v${burst * 2 + 1}</h1>`)
      await expect.poll(() => events.length, poll).toBe(burst)
      await delay(quietMs)
      expect(events).toEqual(Array(burst).fill(changed))
    }

    rmSync(join(folder, 'page.html'))
    await expect.poll(() => events.length, poll).toBe(3)
    await delay(quietMs)
    expect(events).toEqual([changed, changed, { type: 'missing', token }])
  }, 45_000)
})
