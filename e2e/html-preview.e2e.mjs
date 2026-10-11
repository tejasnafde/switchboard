#!/usr/bin/env node
/**
 * HTML preview e2e against the real Electron sandbox: the demo agent writes an
 * .html file, its card opens the preview pane, and a probe page written over
 * it (live reload) tries to reach the network, open a window, read a file
 * outside its folder and reach Node or the app. Every attempt must fail.
 *
 *   npm run build:fast && node e2e/html-preview.e2e.mjs
 *
 * SB_HTML_PREVIEW_SHOTS=<dir> also saves screenshots of the pane there.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeDemoRepo, makeSideRepo, seedDatabase } from './fixtures/demo-workspace.mjs'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build:fast` first')
  process.exit(1)
}
const shots = process.env.SB_HTML_PREVIEW_SHOTS || null

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

const userData = makeTemp('sb-html-preview-e2e-data-')
const projectRoot = makeTemp('sb-html-preview-e2e-project-')
const projectPath = join(projectRoot, 'acme-console')
const sidePath = join(projectRoot, 'notes-cli')
makeDemoRepo(projectPath)
makeSideRepo(sidePath)
writeFileSync(join(projectPath, 'secret.txt'), 'not for the preview')

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

const PROBE = `<!doctype html><meta charset="utf-8"><title>probe</title>
<h1>probe</h1>
<script>
const report = (m) => console.error(m)
const attempt = (label, run) => run().then((ok) => report((ok ? 'LEAK ' : 'BLOCKED ') + label), () => report('BLOCKED ' + label))
attempt('network', () => fetch('https://example.com/x').then(() => true))
attempt('loopback', () => fetch('http://127.0.0.1:9/x').then(() => true))
attempt('parent-file', () => fetch('../secret.txt').then((r) => r.ok))
attempt('encoded-parent-file', () => fetch('%2e%2e/secret.txt').then((r) => r.ok))
attempt('file-url', () => fetch(${JSON.stringify(`file://${join(projectPath, 'secret.txt')}`)}).then(() => true))
fetch('assets/ok.css').then((r) => report(r.ok ? 'ALLOWED sibling' : 'MISSING sibling'), () => report('MISSING sibling'))
const w = window.open('https://example.com/popup')
report(w ? 'LEAK window' : 'BLOCKED window')
report(typeof require === 'undefined' && typeof process === 'undefined' ? 'BLOCKED node' : 'LEAK node')
report(typeof window.api === 'undefined' ? 'BLOCKED app' : 'LEAK app')
// The IDE webviews get a window.open hook that opens URLs in the browser; the preview must not.
setTimeout(() => report(window.__sbOpenHooked ? 'LEAK ide-hook' : 'BLOCKED ide-hook'), 1000)
</script>`

let app
let win
try {
  // First launch creates the database; then seed the tour workspace into it.
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
  await win.getByText('Two focused tests cover it').first().waitFor({ timeout: 20_000 })
  await win.getByRole('button', { name: 'Send', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const editor = win.locator('.chat-composer [aria-label="Chat message"]').first()
  await editor.click()
  await win.keyboard.type('Mock up the pricing page as one HTML file.')
  await win.keyboard.press('Enter')

  const card = win.locator('[data-html-file-card]').last()
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  check((await card.textContent())?.includes('pricing-mock.html'), 'the Write call shows a card for the .html file')
  await win.getByRole('button', { name: 'Send', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  const chip = win.locator('.file-chip', { hasText: 'design/pricing-mock.html' }).last()
  await chip.waitFor({ state: 'visible', timeout: 10_000 })
  check((await chip.getAttribute('title'))?.startsWith('Preview'), 'the inline .html chip opens the preview')
  if (shots) await win.screenshot({ path: join(shots, 'before-open.png') })

  await card.getByRole('button', { name: 'Preview', exact: true }).click()
  const pane = win.locator('[data-html-preview-pane]')
  await pane.waitFor({ state: 'visible', timeout: 10_000 })
  await card.getByText('In pane').waitFor({ state: 'visible', timeout: 10_000 })
  check(true, 'Preview opens the pane and the card reads "In pane"')
  await win.locator('[data-html-preview-pane]:not([data-loading])').waitFor({ timeout: 10_000 })
  await win.waitForTimeout(500)
  // The guest fills the pane exactly: wider would push the page off-screen.
  const fit = await pane.evaluate((el) => {
    const frame = el.querySelector('webview')
    const box = frame?.parentElement
    return frame && box
      ? { frame: frame.getBoundingClientRect().width, box: box.clientWidth, scroll: box.scrollLeft + box.scrollTop }
      : null
  })
  check(
    fit !== null && Math.abs(fit.frame - fit.box) < 1 && fit.scroll === 0,
    `the preview fits its pane (${JSON.stringify(fit)})`,
  )
  // The guest's own frame, captured in main: a window screenshot composites a
  // guest of a background window at a stale size, so it cannot show this.
  const guest = await app.evaluate(async ({ webContents }) => {
    const contents = webContents
      .getAllWebContents()
      .find((w) => w.getType() === 'webview' && w.getURL().startsWith('sb-preview:'))
    if (!contents) return null
    const image = await contents.capturePage()
    return { size: image.getSize(), png: image.toPNG().toString('base64') }
  })
  check(
    guest !== null && Math.abs(guest.size.width - (fit?.box ?? 0)) <= 1,
    `the page renders at the pane width (${JSON.stringify(guest?.size)})`,
  )
  if (shots && guest) writeFileSync(join(shots, 'guest-default-width.png'), Buffer.from(guest.png, 'base64'))
  // Widen the right pane to about 660 px, as in the approved mock.
  const handle = await win.locator('[data-handle-id="terminal"]').boundingBox()
  if (handle) {
    const x = handle.x + handle.width / 2
    const y = handle.y + handle.height / 2
    await win.mouse.move(x, y)
    await win.mouse.down()
    await win.mouse.move(x - 260, y, { steps: 8 })
    await win.mouse.up()
  }
  await pane.getByText('Sandboxed. No network, no access to the app or your files.').waitFor({ timeout: 10_000 })
  const partition = await pane.locator('webview').getAttribute('partition')
  check(partition === 'sb-html-preview', `the preview uses its own partition (${partition})`)
  await win.waitForTimeout(1500)
  if (shots) await win.screenshot({ path: join(shots, 'preview-open.png') })

  await pane.getByRole('button', { name: 'More', exact: true }).click()
  const menu = win.getByRole('menu')
  await menu.waitFor({ state: 'visible', timeout: 5000 })
  check((await menu.getByRole('menuitemradio').count()) === 7, 'the menu offers 3 page themes and 4 widths')
  if (shots) await win.screenshot({ path: join(shots, 'preview-menu.png') })
  await menu.getByRole('menuitemradio', { name: 'Light' }).click()
  await win.waitForTimeout(500)
  if (shots) await win.screenshot({ path: join(shots, 'preview-light.png') })

  // Live reload: the probe replaces the page on disk.
  const design = join(projectPath, 'design')
  mkdirSync(join(design, 'assets'), { recursive: true })
  writeFileSync(join(design, 'assets', 'ok.css'), 'h1{color:teal}')
  writeFileSync(join(design, 'pricing-mock.html'), PROBE)
  const consoleText = async () => (await pane.textContent()) ?? ''
  const deadline = Date.now() + 15_000
  const expected = [
    'BLOCKED network',
    'BLOCKED loopback',
    'BLOCKED parent-file',
    'BLOCKED encoded-parent-file',
    'BLOCKED file-url',
    'BLOCKED window',
    'BLOCKED node',
    'BLOCKED app',
    'ALLOWED sibling',
    'BLOCKED ide-hook',
  ]
  while (Date.now() < deadline) {
    const text = await consoleText()
    if (expected.every((line) => text.includes(line))) break
    await win.waitForTimeout(250)
  }
  const text = await consoleText()
  check(text.includes('BLOCKED network') && text.includes('BLOCKED loopback'), 'the preview cannot reach the network')
  check(text.includes('BLOCKED window'), 'the preview cannot open a window')
  check(
    text.includes('BLOCKED parent-file') &&
      text.includes('BLOCKED encoded-parent-file') &&
      text.includes('BLOCKED file-url'),
    'the preview cannot read a file outside its folder',
  )
  check(text.includes('BLOCKED node') && text.includes('BLOCKED app'), 'the preview has no Node and no app API')
  check(text.includes('BLOCKED ide-hook'), 'the IDE popup hook skips the preview')
  check(text.includes('ALLOWED sibling'), 'the preview loads files in its own folder')
  check(!text.includes('LEAK'), `nothing leaked${text.includes('LEAK') ? `: ${text}` : ''}`)
  check(/\d+ blocked/.test(text), 'the toolbar counts blocked requests')
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
  check(windows === 1, `no window was opened (${windows})`)
  if (shots) await win.screenshot({ path: join(shots, 'preview-probe.png') })

  rmSync(join(design, 'pricing-mock.html'))
  await pane.getByText('File not found').waitFor({ state: 'visible', timeout: 10_000 })
  check(true, 'a deleted file shows "File not found"')
  if (shots) await win.screenshot({ path: join(shots, 'preview-missing.png') })

  await pane.getByRole('button', { name: 'Close preview' }).click()
  await pane.waitFor({ state: 'hidden', timeout: 5000 })
  check((await pane.locator('webview').count()) === 0, 'Close destroys the preview webview')
} catch (err) {
  console.error(err)
  failures++
  if (shots && win) await win.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
} finally {
  await app?.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
