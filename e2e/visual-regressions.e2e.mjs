#!/usr/bin/env node
/**
 * Visual regression suite for the built app (npm run build:fast first).
 *
 * Two phases, both on by default (SB_VISUAL_SCOPE=behaviour|screens runs one):
 *   - behaviour: translucent-theme assertions (native glass transmission,
 *     fullscreen fallback, sidebar Recents/Saved/organizer) on its own fixture.
 *   - screens: nine key screens in Dark, Light and Translucent, captured
 *     against the seeded tour workspace with the scripted demo provider
 *     (SB_DEMO_ADAPTER=1) and pixel-compared with the baselines in
 *     e2e/snapshots/<screen>-<theme>-<platform>.png.
 *
 * Translucent: the real window shows whatever desktop is behind it, blurred by
 * native vibrancy, so an on-screen capture can never be a stable baseline.
 * Playwright's capture holds only the app's own pixels with their alpha, and
 * every screen is flattened over one fixed two-colour backdrop
 * (flattenOverBackdrop), which makes a surface that turns opaque, or one
 * that turns see-through, change pixels. The behaviour phase keeps the native
 * check that the desktop colour actually comes through (needs Screen
 * Recording permission).
 *
 * SB_UPDATE_SNAPSHOTS=1 rewrites every baseline instead of comparing. Failed
 * comparisons write <name>-actual.png and <name>-diff.png to the artifact dir
 * (SB_VISUAL_ARTIFACT_DIR, default e2e/artifacts/visual, which is emptied per
 * run).
 */

import { _electron as electron } from 'playwright'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { checkBaseline, flattenOverBackdrop } from './lib/visual-compare.mjs'
import { makeDemoRepo, makeSideRepo, seedDatabase } from './fixtures/demo-workspace.mjs'

const repoRoot = process.cwd()
const packagedExecutable = process.env.SB_PACKAGED_EXECUTABLE
if (!packagedExecutable && !existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('out/main/index.js missing - run npm run build:fast first')
  process.exit(1)
}

const scope = process.env.SB_VISUAL_SCOPE ?? 'all'
if (!['all', 'behaviour', 'screens'].includes(scope)) {
  console.error(`SB_VISUAL_SCOPE must be all, behaviour or screens (got ${scope})`)
  process.exit(1)
}
// SB_UPDATE_VISUAL_SNAPSHOTS is the name this flag had before the screens phase.
const updateSnapshots = process.env.SB_UPDATE_SNAPSHOTS === '1' || process.env.SB_UPDATE_VISUAL_SNAPSHOTS === '1'
const snapshotDir = join(repoRoot, 'e2e', 'snapshots')
const tempPaths = []
const makeTemp = (prefix) => {
  const path = mkdtempSync(join(tmpdir(), prefix))
  tempPaths.push(path)
  return path
}
const userDataDir = makeTemp('sb-visual-e2e-')
const artifactDir = resolve(process.env.SB_VISUAL_ARTIFACT_DIR ?? join(repoRoot, 'e2e', 'artifacts', 'visual'))
// Only the default dir is ours to empty; a directory passed in may hold
// anything.
if (!process.env.SB_VISUAL_ARTIFACT_DIR) rmSync(artifactDir, { recursive: true, force: true })
mkdirSync(artifactDir, { recursive: true })
const screenshotPath = join(artifactDir, 'translucent.png')
const windowScreenshotPath = join(artifactDir, 'translucent-window.png')
const settingsScreenshotPath = join(artifactDir, 'update-help.png')
const nativeScreenshotPath = join(artifactDir, 'native-glass.png')
const nativeWorkspaceScreenshotPath = join(artifactDir, 'native-workspace.png')
const nativeDarkScreenshotPath = join(artifactDir, 'native-dark.png')
const savedScreenshotPath = join(artifactDir, 'saved-sidebar.png')
const organizerScreenshotPath = (theme) => join(artifactDir, `workspace-organizer-${theme.toLowerCase()}.png`)
let app

const cleanup = () => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true })
}
process.once('exit', cleanup)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

function compareScreenshot(actual) {
  const error = checkBaseline({
    name: `visual-regressions-translucent-${process.platform}`,
    actual,
    snapshotDir,
    artifactDir,
    update: updateSnapshots,
  })
  if (error) throw new Error(`visual mismatch: ${error}`)
}

function averageColor(png, xStart, xEnd, yStart, yEnd) {
  const channels = [0, 0, 0]
  let pixels = 0
  for (let y = Math.floor(png.height * yStart); y < Math.floor(png.height * yEnd); y++) {
    for (let x = Math.floor(png.width * xStart); x < Math.floor(png.width * xEnd); x++) {
      const offset = (y * png.width + x) * 4
      channels[0] += png.data[offset]
      channels[1] += png.data[offset + 1]
      channels[2] += png.data[offset + 2]
      pixels++
    }
  }
  return channels.map((total) => total / pixels)
}

function colorDelta(png) {
  const left = averageColor(png, 0.18, 0.38, 0.25, 0.75)
  const right = averageColor(png, 0.62, 0.82, 0.25, 0.75)
  return {
    left,
    right,
    delta: left.reduce((total, channel, index) => total + Math.abs(channel - right[index]), 0),
  }
}

function meanPixelDelta(left, right) {
  if (left.width !== right.width || left.height !== right.height) {
    throw new Error('native captures have different dimensions')
  }
  let delta = 0
  let channels = 0
  for (let y = Math.floor(left.height * 0.15); y < Math.floor(left.height * 0.85); y += 2) {
    for (let x = Math.floor(left.width * 0.1); x < Math.floor(left.width * 0.9); x += 2) {
      const offset = (y * left.width + x) * 4
      delta += Math.abs(left.data[offset] - right.data[offset])
      delta += Math.abs(left.data[offset + 1] - right.data[offset + 1])
      delta += Math.abs(left.data[offset + 2] - right.data[offset + 2])
      channels += 3
    }
  }
  return delta / channels
}

function captureNative(bounds, path) {
  try {
    execFileSync('/usr/sbin/screencapture', [
      '-x',
      `-R${bounds.x},${bounds.y},${bounds.width},${bounds.height}`,
      path,
    ])
  } catch (error) {
    throw new Error(`native capture failed; grant Screen Recording access to the terminal running Playwright: ${error}`)
  }
  return PNG.sync.read(readFileSync(path))
}

async function assertNativeGlassTransmitsColor(win, suffix = '') {
  if (process.platform !== 'darwin') return
  const checkpoint = suffix || 'live'
  const { bounds, nativeState } = await app.evaluate(async ({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
    if (!main) throw new Error('Switchboard BrowserWindow not found')
    const background = new BrowserWindow({
      ...main.getBounds(),
      frame: false,
      focusable: false,
      show: false,
      skipTaskbar: true,
    })
    const html = '<body style="margin:0;width:100vw;height:100vh;background:linear-gradient(90deg,#ff165d 0 50%,#00d9ff 50%)"></body>'
    await background.loadURL(`data:text/html,${encodeURIComponent(html)}`)
    background.showInactive()
    background.setAlwaysOnTop(true, 'floating', 1)
    main.setAlwaysOnTop(true, 'floating', 2)
    main.moveTop()
    globalThis.__switchboardVisualBackground = background
    return {
      bounds: main.getBounds(),
      nativeState: {
        backgroundColor: main.getBackgroundColor(),
        fullscreen: main.isFullScreen(),
      },
    }
  })

  await win.waitForTimeout(500)
  const glassCapture = captureNative(bounds, suffix ? join(artifactDir, `native-glass-${suffix}.png`) : nativeScreenshotPath)
  const backing = colorDelta(glassCapture)

  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
    if (!main) throw new Error('Switchboard BrowserWindow not found')
    main.setVibrancy(null)
  })
  await win.waitForTimeout(300)
  const plainCapture = captureNative(bounds, join(artifactDir, `native-plain-${suffix || 'live'}.png`))
  const materialDelta = meanPixelDelta(glassCapture, plainCapture)
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
    if (!main) throw new Error('Switchboard BrowserWindow not found')
    main.setVibrancy('sidebar')
  })
  await win.waitForTimeout(300)

  await win.getByTitle('Settings').click()
  await win.getByRole('button', { name: /Dark/ }).click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  const dark = colorDelta(captureNative(bounds, suffix ? join(artifactDir, `native-dark-${suffix}.png`) : nativeDarkScreenshotPath))

  await win.getByTitle('Settings').click()
  await win.getByRole('button', { name: /Translucent/ }).click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
  const workspace = colorDelta(captureNative(bounds, suffix ? join(artifactDir, `native-workspace-${suffix}.png`) : nativeWorkspaceScreenshotPath))
  const surfaceStack = await win.evaluate(() => {
    const x = window.innerWidth * 0.7
    const y = window.innerHeight * 0.5
    return document.elementsFromPoint(x, y).slice(0, 8).map((element) => ({
      element: `${element.tagName.toLowerCase()}.${element.className}`,
      background: getComputedStyle(element).backgroundColor,
    }))
  })

  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
    if (main && !main.isDestroyed()) main.setAlwaysOnTop(false)
    const background = globalThis.__switchboardVisualBackground
    if (background instanceof BrowserWindow && !background.isDestroyed()) background.close()
    delete globalThis.__switchboardVisualBackground
  })

  if (backing.delta < 45) {
    throw new Error(`${checkpoint}: native glass did not transmit the background colors: left=${backing.left.map(Math.round)} right=${backing.right.map(Math.round)} state=${JSON.stringify(nativeState)}`)
  }
  if (materialDelta < 8) {
    throw new Error(`${checkpoint}: native glass was indistinguishable from plain transparency: mean pixel delta=${materialDelta.toFixed(2)}`)
  }
  if (workspace.delta - dark.delta < 45) {
    throw new Error(`${checkpoint}: theme switch did not change background transmission: dark=${dark.delta.toFixed(1)} translucent=${workspace.delta.toFixed(1)} surfaces=${JSON.stringify(surfaceStack)}`)
  }
}

async function assertFullscreenFallback(win) {
  if (process.platform !== 'darwin') return
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
    if (!main) throw new Error('Switchboard BrowserWindow not found')
    main.setFullScreen(true)
  })
  await win.waitForFunction(() => document.documentElement.dataset.fullscreen === 'true', null, { timeout: 10_000 })
  await win.waitForTimeout(500)
  const fullscreen = await win.evaluate(() => ({
    html: getComputedStyle(document.documentElement).backgroundColor,
    body: getComputedStyle(document.body).backgroundColor,
    root: getComputedStyle(document.querySelector('#root')).backgroundColor,
    sidebar: getComputedStyle(document.querySelector('.sidebar-root')).backgroundColor,
  }))
  for (const [surface, color] of Object.entries(fullscreen)) {
    if (color === 'rgba(0, 0, 0, 0)' || color === 'transparent') {
      throw new Error(`fullscreen ${surface} stayed transparent`)
    }
  }

  await win.reload()
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  await win.waitForFunction(() => document.documentElement.dataset.fullscreen === 'true', null, { timeout: 10_000 })
  const reloadedRoot = await win.evaluate(() => getComputedStyle(document.querySelector('#root')).backgroundColor)
  if (reloadedRoot === 'rgba(0, 0, 0, 0)' || reloadedRoot === 'transparent') {
    throw new Error('fullscreen renderer reload lost the solid fallback')
  }

  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
    if (!main) throw new Error('Switchboard BrowserWindow not found')
    main.setFullScreen(false)
  })
  await win.waitForFunction(() => document.documentElement.dataset.fullscreen === 'false', null, { timeout: 10_000 })
  await win.waitForTimeout(1_000)
  const restored = await win.evaluate(() => ({
    root: getComputedStyle(document.querySelector('#root')).backgroundColor,
    primary: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
  }))
  if (restored.root !== 'rgba(0, 0, 0, 0)' || restored.primary !== 'transparent') {
    throw new Error(`fullscreen exit did not restore translucent surfaces: ${JSON.stringify(restored)}`)
  }
}

async function chooseTheme(win, themeName) {
  await win.getByTitle('Settings').click()
  await win.getByRole('button', { name: new RegExp(themeName) }).click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(150)
}

async function assertWorkspaceOrganizer(win) {
  const create = win.getByRole('button', { name: 'Create', exact: true })
  await create.click()
  const createMenu = win.getByRole('menu')
  await createMenu.waitFor({ state: 'visible' })
  for (const label of ['New project', 'New workspace', 'New machine']) {
    if (!await win.getByRole('menuitem', { name: new RegExp(label) }).isVisible()) {
      throw new Error(`Create menu is missing ${label}`)
    }
  }
  await win.keyboard.press('Escape')
  await createMenu.waitFor({ state: 'hidden' })

  let reordered = false
  for (const themeName of ['Dark', 'Light', 'Translucent']) {
    await chooseTheme(win, themeName)
    await win.getByRole('button', { name: 'Organize workspaces and projects' }).click()
    const dialog = win.getByRole('dialog', { name: 'Organize sidebar' })
    await dialog.waitFor({ state: 'visible' })
    const metrics = await win.evaluate(() => {
      const root = document.querySelector('#root')
      const dialog = document.querySelector('.workspace-organizer')
      const nav = document.querySelector('.workspace-organizer-nav')
      const detail = document.querySelector('.workspace-organizer-detail')
      if (!root || !dialog || !nav || !detail) return null
      const dialogBox = dialog.getBoundingClientRect()
      const navBox = nav.getBoundingClientRect()
      const detailBox = detail.getBoundingClientRect()
      return {
        rootBackground: getComputedStyle(root).backgroundColor,
        dialogRight: dialogBox.right,
        viewportWidth: window.innerWidth,
        navRight: navBox.right,
        detailLeft: detailBox.left,
        navWidth: navBox.width,
        detailWidth: detailBox.width,
        overflow: dialog.scrollWidth - dialog.clientWidth,
      }
    })
    if (!metrics || metrics.navWidth < 150 || metrics.detailWidth < 280) {
      throw new Error(`${themeName} organizer panes collapsed: ${JSON.stringify(metrics)}`)
    }
    if (Math.abs(metrics.navRight - metrics.detailLeft) > 1 || metrics.dialogRight > metrics.viewportWidth || metrics.overflow > 1) {
      throw new Error(`${themeName} organizer alignment overflowed: ${JSON.stringify(metrics)}`)
    }
    if (themeName === 'Translucent' && metrics.rootBackground !== 'rgba(0, 0, 0, 0)') {
      throw new Error(`organizer obscured the translucent root: ${metrics.rootBackground}`)
    }

    if (!reordered) {
      const workspaceGrip = win.getByRole('button', { name: 'Reorder Visual Alpha' })
      await workspaceGrip.focus()
      await win.keyboard.press('Alt+ArrowDown')
      const workspaceNames = await win.locator('.workspace-organizer-nav-name').allTextContents()
      if (workspaceNames.join('|') !== 'Visual Beta|Visual Alpha') {
        throw new Error(`workspace keyboard reorder failed: ${workspaceNames.join('|')}`)
      }

      const projectGrip = win.getByRole('button', { name: 'Reorder Visual Recents' })
      await projectGrip.focus()
      await win.keyboard.press('Alt+ArrowDown')
      const projectNames = await win.locator('.workspace-organizer-project-name').allTextContents()
      if (projectNames.join('|') !== 'Visual Extra|Visual Recents') {
        throw new Error(`project keyboard reorder failed: ${projectNames.join('|')}`)
      }
      reordered = true
    }

    await dialog.screenshot({ path: organizerScreenshotPath(themeName) })
    await win.getByRole('button', { name: 'Done' }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
}

async function assertWorkspaceOrderPersisted(win) {
  await win.getByRole('button', { name: 'Organize workspaces and projects' }).click()
  const dialog = win.getByRole('dialog', { name: 'Organize sidebar' })
  await dialog.waitFor({ state: 'visible' })
  const workspaceNames = await win.locator('.workspace-organizer-nav-name').allTextContents()
  if (workspaceNames.join('|') !== 'Visual Beta|Visual Alpha') {
    throw new Error(`workspace order did not persist across relaunch: ${workspaceNames.join('|')}`)
  }
  await win.locator('.workspace-organizer-nav-main').filter({ hasText: 'Visual Alpha' }).click()
  const projectNames = await win.locator('.workspace-organizer-project-name').allTextContents()
  if (projectNames.join('|') !== 'Visual Extra|Visual Recents') {
    throw new Error(`project order did not persist across relaunch: ${projectNames.join('|')}`)
  }
  await win.getByRole('button', { name: 'Done' }).click()
}

async function closeApp() {
  if (!app) return
  const closing = app
  app = undefined
  const closed = await Promise.race([
    closing.close().then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!closed) closing.process().kill('SIGKILL')
}

// ─── Theme screens ───────────────────────────────────────────────────────

const THEMES = ['Dark', 'Light', 'Translucent']
const SCREEN_SIZE = { width: 1280, height: 720 }
const FINISHED_CHAT = 'Debug auth callback'
const RUNNING_CHAT = 'Compare retry strategies'
// Seeded ages count back from this instant and the renderer clock is pinned
// to it (in UTC), so relative ages ("12m") and message times ("10:28") read
// the same on every run and every machine.
const FROZEN_NOW = Date.parse('2026-03-02T10:30:00Z')
// Two runs on one machine match exactly, so this only absorbs antialiasing
// jitter. A surface that changes colour or opacity moves far more pixels.
const SCREEN_MAX_CHANGED_RATIO = 0.001
// Leaves every pixel at its final state: no animation or transition mid-way,
// no blinking caret, no spinner frame that depends on when the shot fired.
const FREEZE_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
    scroll-behavior: auto !important;
  }
`

async function openConversation(win, title) {
  await win.locator('.sidebar-recent-row').filter({ hasText: title }).first().click()
  await win.locator('.chat-identity-title').filter({ hasText: title }).waitFor({ state: 'visible' })
}

async function settle(win) {
  // Park the pointer where nothing has a hover state, then wait for fonts
  // and two frames so layout and paint have caught up.
  await win.mouse.move(SCREEN_SIZE.width / 2, 2)
  await win.evaluate(() => document.fonts.ready.then(() => new Promise((done) => {
    requestAnimationFrame(() => requestAnimationFrame(done))
  })))
  await win.waitForTimeout(250)
}

async function snapScreen(win, screen, theme, target, mask = []) {
  await settle(win)
  const shot = await target.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', mask, maskColor: '#808080' })
  const error = checkBaseline({
    name: `${screen}-${theme.toLowerCase()}-${process.platform}`,
    actual: flattenOverBackdrop(shot),
    snapshotDir,
    artifactDir,
    update: updateSnapshots,
    maxChangedRatio: SCREEN_MAX_CHANGED_RATIO,
  })
  if (error) screenFailures.push(error)
}

/**
 * Seed the tour workspace once and keep a pristine copy of it. Each theme
 * restores that copy before it launches, because its turns edit the repo and
 * the database, and the next theme must start from the same content.
 */
async function prepareScreensFixture() {
  const live = { userData: makeTemp('sb-visual-screens-data-'), project: makeTemp('sb-visual-screens-project-') }
  const projectPath = join(live.project, 'acme-console')
  const sidePath = join(live.project, 'notes-cli')
  makeDemoRepo(projectPath)
  makeSideRepo(sidePath)
  await launchSwitchboard({ userData: live.userData, demo: true })
  await closeApp()
  seedDatabase(join(live.userData, 'data', 'switchboard.db'), projectPath, sidePath, { now: FROZEN_NOW, showFileDiffs: false, expandLocalTree: false })
  const pristine = makeTemp('sb-visual-screens-pristine-')
  for (const [key, path] of Object.entries(live)) cpSync(path, join(pristine, key), { recursive: true })
  return {
    userData: live.userData,
    restore() {
      for (const [key, path] of Object.entries(live)) {
        rmSync(path, { recursive: true, force: true })
        cpSync(join(pristine, key), path, { recursive: true })
      }
    },
  }
}

async function captureThemeScreens(win, theme) {
  await chooseTheme(win, theme)
  // Each turn's time is stamped by the main process when it is saved, and
  // the main clock is real. The renderer's frozen clock cannot reach it.
  const turnTimes = win.locator('.turn-timestamp')
  const editor = win.locator('.chat-composer [aria-label="Chat message"]').first()

  // A finished turn: text, an Edit tool call and the collapsed "Changed 1
  // file" group. Captured before switching threads, since reopening a thread
  // reloads it from the database.
  await openConversation(win, FINISHED_CHAT)
  await editor.click()
  await win.keyboard.type('Move the state check ahead of the token exchange.')
  await win.keyboard.press('Enter')
  await win.getByRole('button', { name: /Changed 1 file/ }).waitFor({ state: 'visible', timeout: 20_000 })
  await win.getByRole('button', { name: 'Send', exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  // The sidebar has baselines of its own, so the full-window screens mask
  // it: a sidebar change then moves only the sidebar baselines.
  const sidebar = win.locator('.sidebar-root')
  await snapScreen(win, 'chat', theme, win, [turnTimes, sidebar])
  await snapScreen(win, 'sidebar', theme, sidebar)

  await win.keyboard.press('Meta+Shift+P')
  const palette = win.locator('.palette-modal-content')
  await palette.waitFor({ state: 'visible' })
  await snapScreen(win, 'command-palette', theme, palette)
  await win.keyboard.press('Escape')
  await palette.waitFor({ state: 'hidden' })

  await win.locator('.chat-composer button[title*="Claude"]').first().click()
  const picker = win.getByRole('dialog', { name: 'Provider, instance, and model picker' })
  await picker.waitFor({ state: 'visible' })
  await snapScreen(win, 'provider-picker', theme, picker)
  await win.keyboard.press('Escape')
  await picker.waitFor({ state: 'hidden' })

  await win.getByTitle('Settings').click()
  const settings = win.locator('.settings-modal-content')
  await settings.waitFor({ state: 'visible' })
  await snapScreen(win, 'settings', theme, settings)
  await win.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })

  await win.getByRole('button', { name: 'Board', exact: true }).click()
  await win.getByText('Trace webhook retries', { exact: true }).first().waitFor({ state: 'visible' })
  await snapScreen(win, 'kanban', theme, win, [sidebar])
  await win.getByRole('button', { name: 'Chats', exact: true }).click()

  // A turn held open on an approval, with a draft in the composer so it
  // offers Stop, Queue and Steer.
  await openConversation(win, RUNNING_CHAT)
  await editor.click()
  await win.keyboard.type('Run the auth tests.')
  await win.keyboard.press('Enter')
  await win.getByText('Approval needed', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 })
  await editor.click()
  await win.keyboard.type('Also cover the retry path.')
  await win.getByRole('button', { name: 'Steer', exact: true }).waitFor({ state: 'visible' })
  await snapScreen(win, 'approval', theme, win.locator('[data-chat-panel]').first(), [turnTimes])
  // The chat held on that approval heads the sidebar under "Needs you".
  await sidebar.locator('.sidebar-recent-group[data-group="needs-you"]').waitFor({ state: 'visible' })
  await snapScreen(win, 'sidebar-needs-you', theme, sidebar)
  await snapScreen(win, 'composer-running', theme, win.locator('.chat-composer').first())
}

async function runThemeScreens() {
  const fixture = await prepareScreensFixture()
  for (const theme of THEMES) {
    fixture.restore()
    const { win } = await launchSwitchboard({ userData: fixture.userData, demo: true })
    win.on('pageerror', (error) => console.error(`renderer error: ${error.message}`))
    // The fixed clock applies from the next navigation, so reload: every
    // label, memoised or not, is then first computed from FROZEN_NOW.
    // Playwright registers the clock as init scripts before it evaluates in
    // the current page, and that evaluate can hit a page mid-navigation
    // ("reading 'controller'"). The reload runs the init scripts anyway and
    // the wait below proves the clock took.
    await win.clock.setFixedTime(FROZEN_NOW).catch((error) => {
      console.warn(`clock not applied to the current page, the reload applies it: ${error.message}`)
    })
    await win.reload()
    await win.waitForFunction((now) => !!window.api?.settings && Date.now() === now, FROZEN_NOW, { timeout: 20_000 })
    await win.addStyleTag({ content: FREEZE_CSS })
    await captureThemeScreens(win, theme)
    await closeApp()
  }
}

async function launchSwitchboard({ userData = userDataDir, demo = false } = {}) {
  // The screens phase pins what changes pixels between machines: a 1x device
  // scale (Retina or not), sRGB output whatever the display's colour profile,
  // the window size, the terminal's shell prompt and the time zone.
  const demoEnv = demo
    ? { SB_DEMO_ADAPTER: '1', TZ: 'UTC', SHELL: '/bin/sh', PS1: 'demo@acme:$ ', ENV: '/dev/null', USER: 'developer', LOGNAME: 'developer' }
    : {}
  const args = demo ? ['--force-device-scale-factor=1', '--force-color-profile=srgb'] : []
  const instance = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable, args } : { args: ['.', ...args] }),
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      SB_USER_DATA: userData,
      ...demoEnv,
    },
  })
  app = instance
  const win = await instance.firstWindow({ timeout: 20_000 })
  // Electron shows window.confirm as a native macOS alert, which Playwright can
  // neither see nor click, so a run that reaches one hangs for ever. Accept it.
  const acceptConfirm = () => { window.confirm = () => true }
  await instance.context().addInitScript(acceptConfirm)
  await win.evaluate(acceptConfirm)
  if (demo) {
    await instance.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, ...size })
    }, SCREEN_SIZE)
  }
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  // The first-launch analytics notice sits over the bottom of the sidebar and
  // swallows clicks meant for it.
  await win.evaluate(() => Promise.all([
    window.api.settings.set('tour.autoplay', 'false'),
    window.api.settings.set('analytics.enabled', 'false'),
    window.api.settings.set('analytics.noticeSeen', 'true'),
  ]))
  return { instance, win }
}

function seedRecentConversations() {
  if (process.platform !== 'darwin') return false
  const projectPath = join(userDataDir, 'recent-project')
  const extraPath = join(userDataDir, 'extra-project')
  const betaPath = join(userDataDir, 'beta-project')
  mkdirSync(projectPath, { recursive: true })
  mkdirSync(extraPath, { recursive: true })
  mkdirSync(betaPath, { recursive: true })
  const now = Date.now()
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
  const statements = [
    `INSERT INTO project_workspaces (id, name, color, sort_order, created_at) VALUES ('visual-alpha', 'Visual Alpha', 'var(--workspace-color-2)', 0, ${now});`,
    `INSERT INTO project_workspaces (id, name, color, sort_order, created_at) VALUES ('visual-beta', 'Visual Beta', 'var(--workspace-color-5)', 1, ${now + 1});`,
    `INSERT INTO projects (path, name, added_at, workspace_id) VALUES (${quote(projectPath)}, 'Visual Recents', ${now}, 'visual-alpha');`,
    `INSERT INTO projects (path, name, added_at, workspace_id) VALUES (${quote(extraPath)}, 'Visual Extra', ${now - 1}, 'visual-alpha');`,
    `INSERT INTO projects (path, name, added_at, workspace_id) VALUES (${quote(betaPath)}, 'Visual Beta Project', ${now - 2}, 'visual-beta');`,
  ]
  for (let index = 0; index < 18; index++) {
    statements.push(`INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at, sidebar_role) VALUES ('visual-recent-${index}', ${quote(projectPath)}, 'claude-code', 'Visual Recent ${index + 1}', ${now - index}, ${now - index}, 'managed');`)
  }
  statements.push(`INSERT INTO bookmarks (id, session_id, project_path, session_title, agent_type, message_role, content_excerpt, message_timestamp, saved_at) VALUES ('visual-bookmark', 'visual-recent-0', ${quote(projectPath)}, 'Visual Recent 1', 'claude-code', 'assistant', 'Saved visual regression message', ${now - 5}, ${now});`)
  execFileSync('sqlite3', [join(userDataDir, 'data', 'switchboard.db'), statements.join('\n')])
  return true
}

async function runBehaviourChecks() {
  const bootstrap = await launchSwitchboard()
  await bootstrap.win.waitForTimeout(600)
  const bootstrapTour = bootstrap.win.getByRole('button', { name: 'Skip tour' })
  if (await bootstrapTour.isVisible()) await bootstrapTour.click()
  await closeApp()
  const hasSeededRecents = seedRecentConversations()

  const launched = await launchSwitchboard()
  const { win } = launched

  await win.waitForTimeout(600)
  const skipTour = win.getByRole('button', { name: 'Skip tour' })
  if (await skipTour.isVisible()) await skipTour.click()
  await win.getByTitle('Settings').waitFor({ state: 'visible' })
  await win.getByTitle('Settings').click()
  const recentLimit = win.locator('select[aria-label="Recent conversations"]')
  await recentLimit.selectOption('6')
  const translucent = win.getByRole('button', { name: /Translucent/ })
  await translucent.waitFor({ state: 'visible' })
  await translucent.click()
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)

  if (hasSeededRecents) {
    await win.waitForFunction(
      () => document.querySelectorAll('.sidebar-recent-row').length === 6,
      null,
      { timeout: 10_000 },
    )
    const recentRows = win.locator('.sidebar-recent-row')
    if (await recentRows.count() !== 6) throw new Error(`configured Recents baseline rendered ${await recentRows.count()} rows`)
    const showFiveMore = win.getByRole('button', { name: 'Show 5 more' })
    await showFiveMore.click()
    if (await recentRows.count() !== 11) throw new Error(`first Recents page rendered ${await recentRows.count()} rows`)
    await showFiveMore.click()
    if (await recentRows.count() !== 16) throw new Error(`second Recents page rendered ${await recentRows.count()} rows`)
    await win.getByRole('button', { name: 'Show 2 more' }).click()
    if (await recentRows.count() !== 18) throw new Error(`final Recents page rendered ${await recentRows.count()} rows`)
    await win.getByRole('button', { name: 'Show less' }).click()
    if (await recentRows.count() !== 6) throw new Error(`collapsed Recents rendered ${await recentRows.count()} rows`)
    if (await win.locator('.sidebar-recents .pulse, .sidebar-recents .blink, .sidebar-recents .sidebar-thread-dot').count() !== 0) {
      throw new Error('Recents rendered a generic blinking status dot')
    }
    await win.locator('.sidebar-recent-row').filter({ hasText: 'Visual Recent 1' }).click()
    await win.locator('.chat-identity-title').filter({ hasText: 'Visual Recent 1' }).waitFor({ state: 'visible' })

    await win.getByRole('button', { name: 'Open saved messages' }).click()
    await win.getByRole('button', { name: 'Back to threads' }).waitFor({ state: 'visible' })
    if (await win.locator('.sidebar-saved-item').count() !== 1) {
      throw new Error(`Saved view rendered ${await win.locator('.sidebar-saved-item').count()} rows`)
    }
    if (await win.locator('.sidebar-recent-row').count() !== 0) {
      throw new Error('Saved view left Recents mounted in the sidebar body')
    }
    await win.locator('.sidebar-root').screenshot({ path: savedScreenshotPath })
    await win.locator('.sidebar-saved-main').filter({ hasText: 'Saved visual regression message' }).click()
    if (!await win.getByRole('button', { name: 'Back to threads' }).isVisible()) {
      throw new Error('opening a saved message left the Saved view')
    }
    await win.getByRole('button', { name: 'Back to threads' }).click()
    await win.locator('.sidebar-recent-row').first().waitFor({ state: 'visible' })
  }

  if (hasSeededRecents) await assertWorkspaceOrganizer(win)

  await assertNativeGlassTransmitsColor(win)
  await assertFullscreenFallback(win)

  const runtimeMode = win.locator('.runtime-mode-select').first()
  await runtimeMode.evaluate((element) => { element.dataset.runtimeMode = 'full-access' })

  const theme = await win.evaluate(() => {
    const root = document.querySelector('#root')
    const sidebar = document.querySelector('.sidebar-root')
    const rootStyle = root ? getComputedStyle(root) : null
    return {
      className: document.documentElement.className,
      primary: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
      rootBackground: rootStyle?.backgroundColor ?? null,
      sidebarBackground: sidebar ? getComputedStyle(sidebar).backgroundColor : null,
      composerShadow: getComputedStyle(document.querySelector('.chat-composer')).boxShadow,
      modeBorder: getComputedStyle(document.querySelector('.runtime-mode-select')).borderTopColor,
      modeShadow: getComputedStyle(document.querySelector('.runtime-mode-select')).boxShadow,
    }
  })

  const toolLayout = await win.evaluate(() => {
    const fixture = document.createElement('details')
    fixture.className = 'turn-activity'
    fixture.open = true
    fixture.dataset.visualFixture = 'tool-summary'
    fixture.style.cssText = 'position:fixed;left:20px;top:20px;width:440px;height:104px;margin:0;padding:12px;background:rgb(8,10,14);z-index:99999'
    fixture.innerHTML = `
      <summary><span data-summary-label>Used 3 tools</span></summary>
      <div class="turn-activity-body">
        <div class="message-bubble-row"><div class="message-bubble">
          <div class="tool-call-row"><button class="tool-call-trigger" type="button">
            <span data-tool-icon style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg></span>
            <span>Edit</span>
          </button></div>
        </div></div>
      </div>`
    document.body.append(fixture)
    const summary = fixture.querySelector('summary')
    const summaryLabel = fixture.querySelector('[data-summary-label]')
    const icon = fixture.querySelector('[data-tool-icon]')
    const row = fixture.querySelector('.message-bubble-row')
    const result = {
      summaryDisplay: getComputedStyle(summary).display,
      summaryAlign: getComputedStyle(summary).alignItems,
      rowPaddingLeft: getComputedStyle(row).paddingLeft,
      alignmentDelta: Math.abs(summaryLabel.getBoundingClientRect().left - icon.getBoundingClientRect().left),
    }
    return result
  })

  const screenshot = await win.locator('[data-visual-fixture="tool-summary"]').screenshot({ path: screenshotPath })
  compareScreenshot(screenshot)

  if (theme.className !== 'theme-translucent') throw new Error(`theme class: ${theme.className}`)
  if (theme.primary !== 'transparent') throw new Error(`primary tint: ${theme.primary}`)
  if (theme.rootBackground !== 'rgba(0, 0, 0, 0)') {
    throw new Error(`root background: ${theme.rootBackground}`)
  }
  const sidebarAlpha = Number(theme.sidebarBackground?.match(/[\d.]+\)$/)?.[0]?.slice(0, -1))
  if (!Number.isFinite(sidebarAlpha) || sidebarAlpha > 0.4) {
    throw new Error(`sidebar background: ${theme.sidebarBackground}`)
  }
  if (theme.composerShadow !== 'none') throw new Error(`composer shadow: ${theme.composerShadow}`)
  if (theme.modeBorder === 'rgb(210, 153, 34)' || theme.modeShadow !== 'none') {
    throw new Error(`full access warning glow: border=${theme.modeBorder} shadow=${theme.modeShadow}`)
  }
  if (toolLayout.summaryDisplay !== 'flex' || toolLayout.summaryAlign !== 'center') {
    throw new Error(`tool summary alignment: ${JSON.stringify(toolLayout)}`)
  }
  if (toolLayout.rowPaddingLeft !== '0px' || toolLayout.alignmentDelta > 2) {
    throw new Error(`tool tree padding: ${JSON.stringify(toolLayout)}`)
  }
  await win.evaluate(() => document.querySelector('[data-visual-fixture="tool-summary"]')?.remove())
  await win.screenshot({ path: windowScreenshotPath })

  await win.getByTitle('Settings').click()
  await win.getByRole('button', { name: 'About' }).click()
  const updateHelp = win.getByRole('button', { name: 'About unsigned updates' })
  await updateHelp.click()
  const tooltip = win.getByRole('tooltip')
  await tooltip.waitFor({ state: 'visible' })
  const tooltipBox = await tooltip.boundingBox()
  const modalBox = await win.locator('.settings-modal-content').boundingBox()
  if (!tooltipBox || !modalBox || tooltipBox.y < modalBox.y || tooltipBox.y + tooltipBox.height > modalBox.y + modalBox.height) {
    throw new Error(`update tooltip clipped: tooltip=${JSON.stringify(tooltipBox)} modal=${JSON.stringify(modalBox)}`)
  }
  const checkButtonBox = await win.getByRole('button', { name: 'Check for updates' }).boundingBox()
  const overlaps = (a, b) => a && b && a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  if (overlaps(tooltipBox, checkButtonBox)) {
    throw new Error(`update tooltip overlaps controls: tooltip=${JSON.stringify(tooltipBox)} check=${JSON.stringify(checkButtonBox)}`)
  }
  await win.screenshot({ path: settingsScreenshotPath })
  await win.keyboard.press('Escape')
  await tooltip.waitFor({ state: 'hidden' })
  if (!await win.locator('.settings-modal-content').isVisible()) {
    throw new Error('Escape closed Settings instead of only dismissing update help')
  }
  await win.keyboard.press('Escape')
  await win.locator('.settings-modal-content').waitFor({ state: 'hidden' })

  // This Mac starts folded behind its summary row; expanding it must stick.
  const localMachine = win.locator('.sidebar-machine-toggle').filter({ hasText: 'This Mac' })
  if (await localMachine.getAttribute('aria-expanded') !== 'false') {
    throw new Error('This Mac did not start collapsed')
  }
  await localMachine.click()
  if (await localMachine.getAttribute('aria-expanded') !== 'true') {
    throw new Error('This Mac did not expand before relaunch')
  }

  await closeApp()
  const relaunched = await launchSwitchboard()
  const relaunchedLocalMachine = relaunched.win.locator('.sidebar-machine-toggle').filter({ hasText: 'This Mac' })
  // hydrateSidebarCollapse restores the saved state after first paint, so
  // the button can be visible and still collapsed for a moment.
  await relaunchedLocalMachine.and(relaunched.win.locator('[aria-expanded="true"]'))
    .waitFor({ state: 'visible', timeout: 10_000 })
    .catch(() => { throw new Error('machine disclosure did not persist across relaunch') })
  if (hasSeededRecents) {
    await relaunched.win.waitForFunction(
      () => document.querySelectorAll('.sidebar-recent-row').length === 6,
      null,
      { timeout: 10_000 },
    )
    if (await relaunched.win.locator('.sidebar-recent-row').count() !== 6) {
      throw new Error('Recents baseline did not persist across relaunch')
    }
    await assertWorkspaceOrderPersisted(relaunched.win)
  }
  await assertNativeGlassTransmitsColor(relaunched.win, 'relaunch')
}

const screenFailures = []
try {
  if (scope !== 'screens') await runBehaviourChecks()
  if (scope !== 'behaviour') await runThemeScreens()
  if (screenFailures.length) {
    throw new Error(`${screenFailures.length} screen(s) changed; actual + diff PNGs in ${artifactDir}\n  ${screenFailures.join('\n  ')}`)
  }
  console.log(`E2E PASSED${packagedExecutable ? ' (packaged)' : ''}${updateSnapshots ? ' (baselines rewritten)' : ''} - visual artifacts: ${artifactDir}`)
} catch (error) {
  console.error(`E2E FAILED - ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
  const failurePath = join(artifactDir, 'failure.png')
  await app?.windows()[0]?.screenshot({ path: failurePath, timeout: 3_000 }).then(
    () => console.error(`window at failure: ${failurePath}`),
    (shotError) => console.error(`could not capture the window at failure: ${shotError}`),
  )
} finally {
  await closeApp()
  cleanup()
}
