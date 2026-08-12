#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'

const repoRoot = process.cwd()
const packagedExecutable = process.env.SB_PACKAGED_EXECUTABLE
if (!packagedExecutable && !existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('out/main/index.js missing - run npm run build:fast first')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-visual-e2e-'))
const artifactDir = mkdtempSync(join(tmpdir(), 'sb-visual-artifacts-'))
const screenshotPath = join(artifactDir, 'translucent.png')
const windowScreenshotPath = join(artifactDir, 'translucent-window.png')
const settingsScreenshotPath = join(artifactDir, 'update-help.png')
const nativeScreenshotPath = join(artifactDir, 'native-glass.png')
const nativeWorkspaceScreenshotPath = join(artifactDir, 'native-workspace.png')
const nativeDarkScreenshotPath = join(artifactDir, 'native-dark.png')
const organizerScreenshotPath = (theme) => join(artifactDir, `workspace-organizer-${theme.toLowerCase()}.png`)
const snapshotPath = join(repoRoot, 'e2e', 'snapshots', `visual-regressions-translucent-${process.platform}.png`)
let app

const cleanup = () => {
  rmSync(userDataDir, { recursive: true, force: true })
  if (process.env.SB_KEEP_VISUAL_ARTIFACTS !== '1') {
    rmSync(artifactDir, { recursive: true, force: true })
  }
}
process.once('exit', cleanup)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

function compareScreenshot(actual) {
  if (process.env.SB_UPDATE_VISUAL_SNAPSHOTS === '1') {
    mkdirSync(join(repoRoot, 'e2e', 'snapshots'), { recursive: true })
    writeFileSync(snapshotPath, actual)
    return
  }
  if (!existsSync(snapshotPath)) throw new Error(`missing visual baseline: ${snapshotPath}`)
  const expectedPng = PNG.sync.read(readFileSync(snapshotPath))
  const actualPng = PNG.sync.read(actual)
  if (actualPng.width !== expectedPng.width || actualPng.height !== expectedPng.height) {
    throw new Error(`visual size changed: ${actualPng.width}x${actualPng.height}`)
  }
  let changed = 0
  for (let i = 0; i < actualPng.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(actualPng.data[i] - expectedPng.data[i]),
      Math.abs(actualPng.data[i + 1] - expectedPng.data[i + 1]),
      Math.abs(actualPng.data[i + 2] - expectedPng.data[i + 2]),
      Math.abs(actualPng.data[i + 3] - expectedPng.data[i + 3]),
    )
    if (delta > 12) changed++
  }
  const ratio = changed / (actualPng.width * actualPng.height)
  if (ratio > 0.005) throw new Error(`visual mismatch: ${(ratio * 100).toFixed(2)}% of pixels changed`)
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

async function launchSwitchboard() {
  const instance = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable, args: [] } : { args: ['.'] }),
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      SB_USER_DATA: userDataDir,
    },
  })
  app = instance
  const win = await instance.firstWindow({ timeout: 20_000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
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
  for (let index = 0; index < 7; index++) {
    statements.push(`INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at) VALUES ('visual-recent-${index}', ${quote(projectPath)}, 'claude-code', 'Visual Recent ${index + 1}', ${now - index}, ${now - index});`)
  }
  execFileSync('sqlite3', [join(userDataDir, 'data', 'switchboard.db'), statements.join('\n')])
  return true
}

try {
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
    const recentRows = win.locator('.sidebar-recent-row')
    if (await recentRows.count() !== 6) throw new Error(`configured Recents baseline rendered ${await recentRows.count()} rows`)
    const showMore = win.getByRole('button', { name: 'Show 1 more' })
    await showMore.click()
    if (await recentRows.count() !== 7) throw new Error(`expanded Recents rendered ${await recentRows.count()} rows`)
    await win.getByRole('button', { name: 'Show less' }).click()
    if (await recentRows.count() !== 6) throw new Error(`collapsed Recents rendered ${await recentRows.count()} rows`)
    if (await win.locator('.sidebar-recents .pulse, .sidebar-recents .blink, .sidebar-recents .sidebar-thread-dot').count() !== 0) {
      throw new Error('Recents rendered a generic blinking status dot')
    }
  }

  if (hasSeededRecents) await assertWorkspaceOrganizer(win)

  await assertNativeGlassTransmitsColor(win)
  await assertFullscreenFallback(win)

  const runtimeMode = win.locator('.runtime-mode-select')
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

  await closeApp()
  const relaunched = await launchSwitchboard()
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

  console.log(`E2E PASSED${packagedExecutable ? ' (packaged)' : ''} - visual artifacts: ${artifactDir}`)
} catch (error) {
  console.error(`E2E FAILED - ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  await closeApp()
  cleanup()
}
