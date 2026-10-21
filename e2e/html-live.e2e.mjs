#!/usr/bin/env node
/**
 * Inline live pages (```html-live) e2e against the real Electron sandbox: the
 * demo agent answers with a probe page that tries to reach the network, open
 * a window, navigate away, read files and load an unknown /_sb/ name, and
 * checks for Node and the app API. Every attempt must fail, and only the
 * bundled /_sb/ libraries load. Then Open in pane moves the page (one running
 * copy), at most two frames run at once, the still image is stored, and a
 * frame at the top edge of a chat scrolled to the bottom does not jitter.
 *
 *   npm run build:fast && SB_E2E_BACKGROUND=1 node e2e/html-live.e2e.mjs
 *
 * SB_HTML_LIVE_SHOTS=<dir> also saves screenshots there.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeDemoRepo, makeSideRepo, seedDatabase } from './fixtures/demo-workspace.mjs'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build:fast` first')
  process.exit(1)
}
const shots = process.env.SB_HTML_LIVE_SHOTS || null

let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const tempDirs = []
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort on exit */
    }
  }
})
const makeTemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

const userData = makeTemp('sb-html-live-e2e-data-')
const projectRoot = makeTemp('sb-html-live-e2e-project-')
const projectPath = join(projectRoot, 'acme-console')
const sidePath = join(projectRoot, 'notes-cli')
makeDemoRepo(projectPath)
makeSideRepo(sidePath)
writeFileSync(join(projectPath, 'secret.txt'), 'not for the page')

async function launch() {
  const app = await electron.launch({
    args: ['.', '--force-device-scale-factor=1'],
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      SB_USER_DATA: userData,
      SB_DEMO_ADAPTER: '1',
      SB_E2E_BACKGROUND: '1',
    },
  })
  const win = await app.firstWindow({ timeout: 20_000 })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1440, height: 900 }),
  )
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  await win.evaluate(() =>
    Promise.all([
      window.api.settings.set('tour.autoplay', 'false'),
      window.api.settings.set('analytics.enabled', 'false'),
      window.api.settings.set('analytics.noticeSeen', 'true'),
    ]),
  )
  return { app, win }
}

/** The inline guests (sb-preview webviews), as main sees them. */
const liveGuests = (app) =>
  app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getType() === 'webview' && w.getURL().startsWith('sb-preview:'))
      .map((w) => w.getURL()),
  )

let app
let win
try {
  ;({ app } = await launch())
  await app.close()
  seedDatabase(join(userData, 'data', 'switchboard.db'), projectPath, sidePath, {
    now: Date.now(),
    showFileDiffs: false,
    expandLocalTree: false,
    linkPullRequest: false,
  })
  const launched = await launch()
  app = launched.app
  win = launched.win

  await win.locator('.sidebar-recent-row').filter({ hasText: 'Debug auth callback' }).first().click()
  await win.locator('.chat-identity-title').filter({ hasText: 'Debug auth callback' }).waitFor({ timeout: 20_000 })
  await win.getByRole('button', { name: 'Send', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const editor = win.locator('.chat-composer [aria-label="Chat message"]').first()
  const send = async (text) => {
    await editor.click()
    await win.keyboard.type(text)
    await win.keyboard.press('Enter')
    await win.getByRole('button', { name: 'Send', exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  }

  // ── The sandbox, from inside an inline frame ──
  await send('Show me a live probe page.')
  const probe = win.locator('[data-html-live]').filter({ hasText: 'Sandbox probe' }).last()
  await probe.scrollIntoViewIfNeeded()
  const expected = [
    'BLOCKED network',
    'BLOCKED loopback',
    'BLOCKED parent-file',
    'BLOCKED file-url',
    'BLOCKED unknown-library',
    'BLOCKED library-folder',
    'ALLOWED library',
    'BLOCKED window',
    'BLOCKED node',
    'BLOCKED app',
    'BLOCKED navigate',
  ]
  const deadline = Date.now() + 20_000
  let text = ''
  while (Date.now() < deadline) {
    text = (await probe.textContent()) ?? ''
    if (expected.every((line) => text.includes(line))) break
    await win.waitForTimeout(250)
  }
  check(
    text.includes('BLOCKED network') && text.includes('BLOCKED loopback'),
    'an inline page cannot reach the network',
  )
  check(text.includes('BLOCKED window'), 'an inline page cannot open a window')
  check(text.includes('BLOCKED navigate'), 'an inline page cannot navigate away')
  check(
    text.includes('BLOCKED parent-file') && text.includes('BLOCKED file-url'),
    'an inline page cannot read files outside its page',
  )
  check(text.includes('BLOCKED node') && text.includes('BLOCKED app'), 'an inline page has no Node and no app API')
  check(
    text.includes('ALLOWED library') &&
      text.includes('BLOCKED unknown-library') &&
      text.includes('BLOCKED library-folder'),
    'only the bundled /_sb/ libraries load',
  )
  check(!text.includes('LEAK'), `nothing leaked${text.includes('LEAK') ? `: ${text}` : ''}`)
  check(/\d+ blocked/.test(text), 'the header counts blocked requests')
  const partition = await probe.locator('webview').getAttribute('partition')
  check(partition === 'sb-html-preview', `the frame uses the preview partition (${partition})`)
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  check(windows === 1, `no window was opened (${windows})`)
  if (shots) await probe.screenshot({ path: join(shots, 'probe.png') })

  // ── Open in pane moves the page: one running copy ──
  await probe.getByRole('button', { name: 'Open in pane', exact: true }).click()
  const pane = win.locator('[data-html-preview-pane]')
  await pane.waitFor({ state: 'visible', timeout: 10_000 })
  await probe.getByText('In pane').waitFor({ state: 'visible', timeout: 10_000 })
  await win.locator('[data-html-preview-pane]:not([data-loading])').waitFor({ timeout: 10_000 })
  check((await probe.locator('webview').count()) === 0, 'the message stops its copy while the pane runs it')
  check((await liveGuests(app)).length === 1, 'one running copy of the page')
  await pane.getByRole('button', { name: 'Close preview' }).click()
  await probe.locator('webview').waitFor({ state: 'attached', timeout: 10_000 })
  check(true, 'closing the pane brings the page back into the message')

  // ── At most two frames run per window; the still image is stored ──
  await send('Show the latency live page.')
  const chart = win.locator('[data-html-live]').filter({ hasText: 'p95 latency, Mon to Wed' }).last()
  const queue = win.locator('[data-html-live]').filter({ hasText: 'Queue depth simulation' }).last()
  await chart.scrollIntoViewIfNeeded()
  await chart.locator('webview').waitFor({ state: 'attached', timeout: 20_000 })
  await queue.scrollIntoViewIfNeeded()
  await queue.getByText('1 error').waitFor({ timeout: 20_000 })
  check((await queue.textContent())?.includes('is not a function'), 'a page that throws shows its error')
  check((await queue.getByRole('button', { name: 'Send to agent' }).count()) === 1, 'the error offers Send to agent')
  // The chart's still image is stored under its source hash once it is quiet.
  await chart.scrollIntoViewIfNeeded()
  await chart.getByRole('button', { name: 'Source', exact: true }).click()
  const chartSource = (await chart.locator('pre').textContent()) ?? ''
  await chart.getByRole('button', { name: 'Source', exact: true }).click()
  const stored = await win.evaluate(async (source) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
    const key = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    for (let i = 0; i < 40; i++) {
      const state = await window.api.htmlLive.load(null, key)
      if (state.image) return state.image.slice(0, 22)
      await new Promise((r) => setTimeout(r, 250))
    }
    return null
  }, chartSource)
  check(stored === 'data:image/png;base64,', `the still image is stored with the chat's backend (${stored})`)
  const unknown = await win.evaluate(() => window.api.htmlLive.load(null, '0'.repeat(64)))
  check(unknown.image === null, 'an unknown page has no still image')

  // Run on the probe, now scrolled away and paused: it displaces the frame that has run longest.
  await probe.scrollIntoViewIfNeeded()
  const run = probe.getByRole('button', { name: 'Run', exact: true })
  if (await run.isVisible().catch(() => false)) await run.click()
  await win.waitForTimeout(1500)
  const running = (await liveGuests(app)).length
  check(running <= 2, `at most two frames run (${running})`)
  await chart.scrollIntoViewIfNeeded()
  await queue.scrollIntoViewIfNeeded()
  await win.waitForTimeout(1000)
  check((await liveGuests(app)).length <= 2, 'still at most two with three frames in view')
  if (shots) await win.screenshot({ path: join(shots, 'frames.png') })

  // ── Save as file, under More in the pane: the block becomes the file card ──
  await chart.scrollIntoViewIfNeeded()
  await chart.getByRole('button', { name: 'Open in pane', exact: true }).click()
  await pane.waitFor({ state: 'visible', timeout: 10_000 })
  await pane.getByRole('button', { name: 'More', exact: true }).click()
  await win.getByRole('menuitem', { name: 'Save as file' }).click()
  const savedName = 'p95-latency-mon-to-wed.html'
  const savedCard = win.locator('[data-html-file-card]').filter({ hasText: savedName }).last()
  await savedCard.waitFor({ state: 'visible', timeout: 10_000 })
  check(existsSync(join(projectPath, savedName)), 'Save as file writes the page into the chat folder')
  check((await savedCard.textContent())?.includes('In pane'), 'the pane now shows the saved file')
  await win.locator('[data-html-preview-pane]:not([data-loading])').waitFor({ timeout: 10_000 })
  await win.waitForTimeout(1500)
  const paneText = (await pane.textContent()) ?? ''
  check(!/error|blocked/.test(paneText), `the saved page still loads its library (${paneText.slice(0, 120)})`)
  if (shots) await win.screenshot({ path: join(shots, 'saved.png') })
  await pane.getByRole('button', { name: 'Close preview' }).click()

  // ── A frame at the top edge of a chat scrolled to the bottom holds still ──
  // Scrolling it out swaps the page for its still image; the size must not
  // change, or the scroll correction brings it back into view and it swaps again.
  await send('Show the tall live page.')
  const tall = win.locator('[data-html-live]').filter({ hasText: 'Incident timeline' }).last()
  await tall.scrollIntoViewIfNeeded()
  await tall.locator('webview').waitFor({ state: 'attached', timeout: 20_000 })
  await tall.getByRole('button', { name: /^Show all/ }).waitFor({ timeout: 10_000 })
  await win.waitForTimeout(2500)
  const list = win.locator('[data-chat-panel] [data-message-list-scroll]')
  for (const edge of [0, -1, -6, -12]) {
    // Size the list so that, scrolled to the bottom, the frame's bottom sits `edge` px below its top.
    await list.evaluate(async (el, edge) => {
      el.style.maxHeight = ''
      el.scrollTop = el.scrollHeight
      await new Promise((r) => setTimeout(r, 300))
      const frame = [...el.querySelectorAll('[data-html-live]')].findLast((f) =>
        f.textContent.includes('Incident timeline'),
      )
      const bottom = frame.getBoundingClientRect().bottom - el.getBoundingClientRect().top
      el.style.maxHeight = `${el.clientHeight - (bottom - edge)}px`
      el.scrollTop = el.scrollHeight - el.clientHeight - 600
    }, edge)
    await win.waitForTimeout(800)
    const box = await list.boundingBox()
    await win.mouse.move(box.x + box.width / 2, box.y + 40)
    const sampled = list.evaluate(async (el) => {
      const samples = []
      const t0 = performance.now()
      while (performance.now() - t0 < 4000) {
        await new Promise((r) => requestAnimationFrame(r))
        const frame = [...el.querySelectorAll('[data-html-live]')].findLast((f) =>
          f.textContent.includes('Incident timeline'),
        )
        samples.push({
          top: el.scrollTop,
          gap: el.scrollHeight - el.scrollTop - el.clientHeight,
          height: Math.round(frame.getBoundingClientRect().height),
          state: frame.getAttribute('data-html-live'),
        })
      }
      return samples
    })
    for (let i = 0; i < 12; i++) {
      await win.mouse.wheel(0, 80)
      await win.waitForTimeout(30)
    }
    const samples = await sampled
    const heights = new Set(samples.map((x) => x.height))
    const settled = samples.slice(-60)
    const last = samples[samples.length - 1]
    check(heights.size === 1, `edge ${edge}: the frame keeps its size across the swap (${[...heights].join(', ')})`)
    check(
      new Set(settled.map((x) => x.top)).size === 1 && last.gap <= 1,
      `edge ${edge}: the list settles at the bottom (gap ${Math.round(last.gap)}, ${last.state})`,
    )
  }
  await list.evaluate((el) => (el.style.maxHeight = ''))
} catch (err) {
  console.error(err)
  failures++
  if (shots && win) await win.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
} finally {
  await app?.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
