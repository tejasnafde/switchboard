#!/usr/bin/env node
/**
 * End-to-end probe for main-pane resizing (sidebar + terminal dividers).
 *
 * Boots the *built* app under Playwright/Electron and drives the real DOM to
 * verify the two things the unit tests can't (real pointer capture + real
 * layout):
 *   1. The max-width cap is gone - the sidebar can be dragged well past the
 *      old 500px limit (terminal hidden so the viewport-relative cap is high).
 *   2. The divider never gets stuck in resize mode: after a normal release,
 *      and after a mid-drag `blur` (the "cursor wandered off / capture lost"
 *      case), the drag overlay is removed and body cursor/userSelect reset.
 *
 * Opt-in: SB_RESIZE_E2E=1 node e2e/resize.e2e.mjs
 * Requires `npx electron-vite build` first and a display.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.SB_RESIZE_E2E !== '1') {
  console.log('skipped - set SB_RESIZE_E2E=1 to run')
  process.exit(0)
}

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npx electron-vite build` first')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-resize-e2e-'))
// MANDATORY cleanup (see CLAUDE.md - e2e temp dirs have filled the disk before).
process.on('exit', () => { try { rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ } })

let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

const centerOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
const overlayPresent = (win) => win.evaluate(() => !!document.querySelector('[data-drag-overlay]'))
const bodyCursor = (win) => win.evaluate(() => document.body.style.cursor)

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api, null, { timeout: 20_000 })
  await win.bringToFront()
  check(true, 'app booted')

  const sidebar = win.locator('[data-handle-id="sidebar"]')
  await sidebar.waitFor({ state: 'visible', timeout: 10_000 })

  // Hide the terminal (⌘J) so the sidebar's viewport-relative cap is high
  // regardless of the e2e window size, then let layout + focus settle.
  await win.keyboard.press('Meta+j')
  await win.waitForTimeout(400)

  // Warm-up: the very first pointer interaction after boot can be dropped
  // before the window is fully focused/hovered. Hover the handle first.
  await sidebar.hover()
  await win.waitForTimeout(100)

  // ── 1. Max cap removed + overlay lifecycle on a real drag ──
  const start = (await sidebar.boundingBox()).x // handle.x ≈ sidebar width
  const c = centerOf(await sidebar.boundingBox())
  await win.mouse.move(c.x, c.y)
  await win.mouse.down()
  await win.waitForTimeout(50)
  const midOverlay = await overlayPresent(win)
  const midCursor = await bodyCursor(win)
  await win.mouse.move(c.x + 500, c.y, { steps: 12 }) // drag past the old 500px cap
  await win.waitForTimeout(50)
  await win.mouse.up()
  await win.waitForTimeout(150)

  const end = (await sidebar.boundingBox()).x
  check(midOverlay, 'drag overlay present during drag')
  check(midCursor === 'col-resize', `body cursor is col-resize during drag (got "${midCursor}")`)
  check(end > 520, `sidebar grew past the old 500px cap (${Math.round(start)} → ${Math.round(end)})`)

  // ── 2a. No stuck state after a normal release ──
  check(!(await overlayPresent(win)), 'overlay removed after release')
  check((await bodyCursor(win)) === '', `body cursor reset after release (got "${await bodyCursor(win)}")`)
  check((await win.evaluate(() => document.body.style.userSelect)) === '', 'body userSelect reset after release')

  // ── 2b. No stuck state when the drag is interrupted (blur / capture lost) ──
  const c2 = centerOf(await sidebar.boundingBox())
  await win.mouse.move(c2.x, c2.y)
  await win.mouse.down()
  await win.waitForTimeout(50)
  await win.mouse.move(c2.x - 120, c2.y, { steps: 6 })
  await win.waitForTimeout(50)
  check(await overlayPresent(win), 'overlay present during interrupted drag')
  // Simulate focus loss - the same endDrag path the real lostpointercapture
  // (pointer wandered into the IDE webview) recovery uses.
  await win.evaluate(() => window.dispatchEvent(new Event('blur')))
  await win.waitForTimeout(80)
  check(!(await overlayPresent(win)), 'overlay removed after interrupted drag (blur)')
  check((await bodyCursor(win)) === '', `body cursor reset after interrupted drag (got "${await bodyCursor(win)}")`)
  await win.mouse.up() // release Playwright's synthetic button state

  console.log(failures === 0 ? '\nALL RESIZE E2E CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
} catch (err) {
  console.error('✗ resize e2e threw:', err)
  failures++
} finally {
  await app.close()
}

process.exit(failures === 0 ? 0 : 1)
