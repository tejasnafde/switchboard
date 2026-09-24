#!/usr/bin/env node
/**
 * Records the feature-tour clips (and the README hero shot) from the REAL
 * app. Playwright drives the built Electron bundle against an isolated,
 * seeded fixture; every provider is the scripted demo adapter
 * (SB_DEMO_ADAPTER=1), so agent-driven scenes are deterministic and free.
 *
 *   node videos/capture-tour.mjs                # every scene -> videos/dist/<id>.mp4
 *   node videos/capture-tour.mjs slash-menu     # one scene
 *   node videos/capture-tour.mjs --list
 *   SB_SCREENSHOT=docs/images/hero.png node videos/capture-tour.mjs hero
 *
 * Needs `npm run build:fast` first (reads out/), ffmpeg and sqlite3 on PATH.
 * The `ide` scene borrows the code-server install from this Mac's real
 * userData (SB_TOUR_CODE_SERVER overrides the path) so it never downloads.
 * Scene ids must match `FEATURE_TOUR_STEPS` in
 * src/renderer/components/onboarding/featureRegistry.ts.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { makeDemoRepo, makeSideRepo, seedDatabase } from '../e2e/fixtures/demo-workspace.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, 'videos', 'dist')
const captureViewport = { width: 1280, height: 720 }
const captureOutput = { width: 2560, height: 1440 }
const tempPaths = []

function makeTemp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix))
  tempPaths.push(path)
  return path
}

function cleanup() {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true })
}

process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

const pause = (page, ms) => page.waitForTimeout(ms)

// ─── Fixture ─────────────────────────────────────────────────────────────

/** Point the fixture at this Mac's code-server install so `ide` never downloads. */
function linkCodeServer(userData) {
  const source = process.env.SB_TOUR_CODE_SERVER
    ?? join(homedir(), 'Library', 'Application Support', 'switchboard', 'code-server')
  if (!existsSync(source)) {
    console.warn(`code-server not found at ${source}; the ide scene will show the download state`)
    return
  }
  const target = join(userData, 'code-server')
  mkdirSync(target, { recursive: true })
  const binary = join(source, '4.127.0')
  if (existsSync(binary)) symlinkSync(binary, join(target, '4.127.0'), 'dir')
  // Link the installed extensions one by one so the Jupyter seed finds them
  // (no marketplace install on a fresh dir), but leave out anything that
  // greets the user with its own onboarding panel, and the bridge, which the
  // app copies in itself (cpSync refuses to replace a symlink with a dir).
  // No extensions.json: the bridge seeder clears it so code-server rescans.
  const extensionsFrom = join(source, 'extensions')
  const extensionsTo = join(target, 'extensions')
  mkdirSync(extensionsTo, { recursive: true })
  if (existsSync(extensionsFrom)) {
    for (const name of readdirSync(extensionsFrom)) {
      if (name === 'extensions.json' || name.startsWith('.') || /^(atlassian\.|mattpocock\.|switchboard\.sb-bridge)/.test(name)) continue
      symlinkSync(join(extensionsFrom, name), join(extensionsTo, name), 'dir')
    }
  }
  // Quiet first-run prompts that have nothing to do with the feature being
  // shown. The app merges its own defaults over this file, so extra keys stay.
  mkdirSync(join(target, 'data', 'User'), { recursive: true })
  writeFileSync(join(target, 'data', 'User', 'settings.json'), JSON.stringify({
    'update.mode': 'none',
    'extensions.ignoreRecommendations': true,
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'typescript.surveys.enabled': false,
    'workbench.enableExperiments': false,
    'workbench.tips.enabled': false,
    'git.openRepositoryInParentFolders': 'never',
    'telemetry.telemetryLevel': 'off',
  }, null, 2))
}

async function launch(userData, recordDir) {
  const app = await electron.launch({
    args: ['.', '--force-device-scale-factor=2'],
    cwd: repoRoot,
    env: {
      ...process.env,
      SHELL: '/bin/sh',
      PS1: 'demo@acme:$ ',
      USER: 'developer',
      LOGNAME: 'developer',
      ENV: '/dev/null',
      ELECTRON_RUN_AS_NODE: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      SB_USER_DATA: userData,
      SB_DEMO_ADAPTER: '1',
    },
    ...(recordDir ? { recordVideo: { dir: recordDir, size: captureOutput } } : null),
    timeout: 30_000,
  })
  const win = await app.firstWindow({ timeout: 20_000 })
  win.on('pageerror', (error) => console.error(`renderer error: ${error.message}`))
  win.on('console', (message) => {
    if (message.type() === 'error') console.error(`renderer console: ${message.text()}`)
  })
  await app.evaluate(({ BrowserWindow }, viewport) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 20, y: 20, ...viewport })
  }, captureViewport)
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  const skipTour = win.getByRole('button', { name: 'Skip tour' })
  if (await skipTour.isVisible().catch(() => false)) await skipTour.click()
  // Quiet the first-launch surfaces so they never appear in a clip, and make
  // sure a fixture app never posts analytics.
  await win.evaluate(() => Promise.all([
    window.api.settings.set('tour.autoplay', 'false'),
    window.api.settings.set('analytics.enabled', 'false'),
    window.api.settings.set('analytics.noticeSeen', 'true'),
  ]))
  await pause(win, 650)
  return { app, win }
}

async function closeApp(app) {
  await Promise.race([
    app.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Electron close timed out')), 12_000)),
  ])
}

async function prepareFixture() {
  const userData = makeTemp('sb-tour-data-')
  const fixtureRoot = makeTemp('sb-tour-project-')
  const projectPath = join(fixtureRoot, 'acme-console')
  const sidePath = join(fixtureRoot, 'notes-cli')
  makeDemoRepo(projectPath)
  makeSideRepo(sidePath)
  linkCodeServer(userData)

  const bootstrap = await launch(userData)
  await closeApp(bootstrap.app)
  const dbPath = join(userData, 'data', 'switchboard.db')
  if (!existsSync(dbPath)) throw new Error(`Switchboard database was not created at ${dbPath}`)
  seedDatabase(dbPath, projectPath, sidePath)
  return { userData, projectPath }
}

// ─── Shared moves ────────────────────────────────────────────────────────

async function selectConversation(win, title = 'Debug auth callback') {
  const thread = win.locator('.sidebar-thread-main').filter({ hasText: title }).first()
  try {
    await thread.waitFor({ state: 'visible', timeout: 15_000 })
  } catch (error) {
    const sidebarText = await win.locator('.sidebar-root').innerText({ timeout: 2_000 }).catch(() => '(sidebar unavailable)')
    console.error(`Sidebar at capture failure:\n${sidebarText}`)
    throw error
  }
  await thread.click()
  await win.locator('.chat-identity-title').filter({ hasText: title }).waitFor({ state: 'visible' })
}

async function glide(win, from, to, steps = 30) {
  await win.mouse.move(from.x, from.y)
  await win.mouse.move(to.x, to.y, { steps })
}

async function composer(win) {
  const editor = win.locator('[aria-label="Chat message"]').first()
  await editor.waitFor({ state: 'visible' })
  await editor.click()
  return editor
}

async function send(win, text) {
  await composer(win)
  await win.keyboard.type(text, { delay: 34 })
  await pause(win, 350)
  await win.keyboard.press('Enter')
}

async function waitForTurn(win, timeout = 25_000) {
  // The composer swaps Send for Stop while a turn runs; wait for the swap
  // both ways so a fast script cannot be mistaken for an idle one.
  const stop = win.getByRole('button', { name: 'Stop' }).first()
  await stop.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
  await stop.waitFor({ state: 'hidden', timeout }).catch(() => {})
}

// ─── Scenes ──────────────────────────────────────────────────────────────

const scenes = {
  async welcome(win) {
    // Slide 1 has to prove the three regions are ONE window and all live. The
    // first cut glided the cursor over a static window and read as a
    // screenshot, so this streams a reply in the chat while a terminal prints
    // beside it. The turn is deliberately not awaited.
    await pause(win, 1200)
    await selectConversation(win)
    await pause(win, 1000)
    await composer(win)
    await win.keyboard.type('What do the tests cover?', { delay: 40 })
    await win.keyboard.press('Enter')
    await pause(win, 800)
    const terminal = win.locator('[data-terminal-pane]').first()
    await terminal.click({ position: { x: 80, y: 90 } })
    await win.keyboard.type('npm test', { delay: 60 })
    await win.keyboard.press('Enter')
    await pause(win, 3400)
  },

  async 'chats-and-board'(win) {
    await selectConversation(win)
    await pause(win, 900)
    await win.getByRole('button', { name: 'Board', exact: true }).click()
    const card = win.getByText('Trace webhook retries', { exact: true }).locator('xpath=ancestor::div[@role="button"][1]')
    await card.waitFor({ state: 'visible' })
    await pause(win, 1200)
    const target = win.getByText('In progress', { exact: true })
    const [from, to] = await Promise.all([card.boundingBox(), target.boundingBox()])
    if (from && to) {
      await win.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await win.mouse.down()
      await win.mouse.move(to.x + to.width / 2, to.y + to.height + 100, { steps: 24 })
      await pause(win, 450)
      await win.mouse.up()
    }
    await pause(win, 1600)
    await win.getByRole('button', { name: 'Chats', exact: true }).click()
    await pause(win, 1200)
  },

  async 'slash-menu'(win) {
    await selectConversation(win)
    await pause(win, 800)
    await composer(win)
    await win.keyboard.type('/', { delay: 60 })
    await win.getByRole('listbox', { name: 'Slash commands' }).waitFor({ state: 'visible' })
    await pause(win, 900)
    for (let i = 0; i < 3; i++) {
      await win.keyboard.press('ArrowDown')
      await pause(win, 420)
    }
    await pause(win, 500)
    await win.keyboard.type('re', { delay: 120 })
    await pause(win, 1400)
    await win.keyboard.press('Escape')
    await pause(win, 300)
    await win.keyboard.press('Meta+A')
    await win.keyboard.press('Backspace')
    await pause(win, 600)
  },

  async 'runtime-modes'(win) {
    await selectConversation(win)
    await pause(win, 800)
    const select = win.locator('.runtime-mode-select').first()
    await select.hover()
    await pause(win, 500)
    await select.selectOption('plan')
    await pause(win, 900)
    await send(win, 'Refactor the auth callback so it validates state first.')
    await waitForTurn(win)
    await pause(win, 2200)
  },

  async panes(win) {
    await selectConversation(win)
    await pause(win, 1400)
    const terminal = win.locator('[data-terminal-pane]').first()
    await terminal.waitFor({ state: 'visible', timeout: 12_000 })
    await terminal.click({ position: { x: 80, y: 90 } })
    await win.keyboard.press('Meta+Shift+T')
    await pause(win, 800)
    const latest = win.locator('[data-terminal-pane]').last()
    await latest.click({ position: { x: 80, y: 90 } })
    await win.keyboard.type('npm test', { delay: 70 })
    await win.keyboard.press('Enter')
    await pause(win, 3400)
  },

  async 'dual-chat'(win) {
    // Open beside offers only chats that are already loaded, so load the
    // second one first and come back.
    await selectConversation(win, 'Compare retry strategies')
    await pause(win, 500)
    await selectConversation(win)
    await pause(win, 900)
    await win.getByRole('button', { name: 'Open beside' }).click()
    await pause(win, 700)
    await win.locator('.sb-floating-surface').getByRole('button').filter({ hasText: 'Compare retry strategies' }).first().click()
    await pause(win, 1400)
    await glide(win, { x: 500, y: 400 }, { x: 900, y: 400 }, 30)
    await pause(win, 2200)
  },

  async ide(win) {
    await selectConversation(win)
    await pause(win, 2200)
    // Flip the right pane to the workbench (it has been prewarming since the
    // session became active), give it time to paint, then open a file from
    // the chat: backticked repo paths in agent messages are clickable chips
    // that open at that line in the editor.
    await win.keyboard.press('Meta+Shift+E')
    await pause(win, 7500)
    const chip = win.locator('[data-context-source="file-chip"]').first()
    if (await chip.isVisible().catch(() => false)) {
      await chip.hover()
      await pause(win, 700)
      await chip.click()
    }
    await pause(win, 4500)
  },

  async 'diff-review'(win) {
    await selectConversation(win)
    await pause(win, 800)
    await send(win, 'Move the state check ahead of the token exchange.')
    await waitForTurn(win)
    const rejectAll = win.getByRole('button', { name: 'Reject all' }).first()
    await rejectAll.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    await rejectAll.scrollIntoViewIfNeeded().catch(() => {})
    await pause(win, 2600)
  },

  async 'launch-config'(win) {
    await selectConversation(win)
    await pause(win, 1000)
    const chip = win.getByTitle('Switch launch config for this chat')
    await chip.hover()
    await pause(win, 500)
    await chip.click()
    await pause(win, 900)
    // Switching kills panes that printed in the last 30s, so the app asks
    // first. Answer yes, as a user would.
    win.once('dialog', (dialog) => void dialog.accept())
    await win.getByRole('button').filter({ hasText: /^backend$/ }).first().click()
    await pause(win, 3600)
  },

  async 'switch-agent'(win) {
    await selectConversation(win)
    await pause(win, 900)
    const trigger = win.locator('.chat-composer button[title*="Claude"]').first()
    await trigger.hover()
    await pause(win, 500)
    await trigger.click()
    const dialog = win.getByRole('dialog', { name: 'Provider, instance, and model picker' })
    await dialog.waitFor({ state: 'visible' })
    await pause(win, 1200)
    await dialog.getByRole('button').filter({ hasText: /^Codex$/ }).first().click()
    await pause(win, 1400)
    await win.keyboard.press('Escape')
    await pause(win, 1500)
  },

  async 'resume-search'(win) {
    await selectConversation(win, 'Prepare release notes')
    await pause(win, 900)
    await win.keyboard.press('Meta+Shift+F')
    const input = win.getByPlaceholder('Search across all conversations...')
    await input.waitFor({ state: 'visible' })
    await pause(win, 500)
    await win.keyboard.type('state token', { delay: 80 })
    await pause(win, 1500)
    const hit = win.locator('.cmdk-item').first()
    await hit.hover()
    await pause(win, 600)
    await hit.click()
    await pause(win, 2400)
  },

  async 'remote-machines'(win) {
    await selectConversation(win)
    await pause(win, 900)
    const sidebarHandle = win.locator('[data-handle-id="sidebar"]')
    const sidebarBox = await sidebarHandle.boundingBox()
    if (sidebarBox) {
      await win.mouse.move(sidebarBox.x + sidebarBox.width / 2, sidebarBox.y + 120)
      await win.mouse.down()
      await win.mouse.move(470, sidebarBox.y + 120, { steps: 24 })
      await win.mouse.up()
    }
    const local = win.locator('.sidebar-machine-toggle').filter({ hasText: 'This Mac' }).first()
    if (await local.getAttribute('aria-expanded') === 'true') await local.click()
    await pause(win, 650)
    const offline = win.locator('.sidebar-machine-toggle').filter({ hasText: 'Remote machines' }).first()
    if (await offline.getAttribute('aria-expanded') === 'false') await offline.click()
    await pause(win, 650)
    const linux = win.locator('.sidebar-machine-toggle').filter({ hasText: 'Work machine' }).first()
    await linux.scrollIntoViewIfNeeded()
    const build = win.locator('.sidebar-machine-toggle').filter({ hasText: 'Build server' }).first()
    if (await linux.getAttribute('aria-expanded') === 'true') await linux.click()
    if (await build.getAttribute('aria-expanded') === 'true') await build.click()
    await pause(win, 650)
    await linux.click()
    await pause(win, 900)
    await build.scrollIntoViewIfNeeded()
    await build.click()
    await pause(win, 1700)
  },

  async workspaces(win) {
    await selectConversation(win)
    await pause(win, 900)
    const work = win.locator('.sidebar-workspace-header').filter({ hasText: 'Work' }).first()
    await work.hover()
    await pause(win, 700)
    const personal = win.locator('.sidebar-workspace-header').filter({ hasText: 'Personal' }).first()
    await personal.hover()
    await pause(win, 700)
    const filter = win.getByPlaceholder(/filter chats/i).first()
    await filter.click()
    await win.keyboard.type('retry', { delay: 110 })
    await pause(win, 1800)
    await win.keyboard.press('Meta+A')
    await win.keyboard.press('Backspace')
    await pause(win, 1200)
  },

  /** README hero. Not a tour step; used with SB_SCREENSHOT. */
  async hero(win) {
    await selectConversation(win)
    await pause(win, 900)
    const terminal = win.locator('[data-terminal-pane]').first()
    await terminal.waitFor({ state: 'visible', timeout: 12_000 })
    await terminal.click({ position: { x: 80, y: 90 } })
    await win.keyboard.press('Meta+Shift+T')
    await pause(win, 800)
    await win.locator('[data-terminal-pane]').last().click({ position: { x: 80, y: 90 } })
    await win.keyboard.type('npm test', { delay: 70 })
    await win.keyboard.press('Enter')
    await pause(win, 2400)
  },
}

const tourSceneIds = Object.keys(scenes).filter((id) => id !== 'hero')

// ─── Encode ──────────────────────────────────────────────────────────────

function encodeClip(rawPath, outputPath, startSeconds) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', startSeconds.toFixed(2), '-i', rawPath,
    '-vf', 'fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x090b0d',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '21',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outputPath,
  ], { stdio: 'inherit' })
}

async function screenshot(name, outputPath) {
  const fixture = await prepareFixture()
  const { app, win } = await launch(fixture.userData)
  try {
    await scenes[name](win)
    mkdirSync(dirname(outputPath), { recursive: true })
    await win.screenshot({ path: outputPath, animations: 'disabled' })
    console.log(`captured ${name} -> ${outputPath}`)
  } finally {
    await closeApp(app)
  }
}

async function capture(name) {
  console.log(`preparing ${name}`)
  const fixture = await prepareFixture()
  const recordDir = makeTemp(`sb-tour-video-${name}-`)
  const launchedAt = Date.now()
  const { app, win } = await launch(fixture.userData, recordDir)
  const video = win.video()
  if (!video) throw new Error('Playwright did not attach a video recorder')
  // Trim everything before the scene begins (window sizing, tour skip).
  const sceneStartedAt = Date.now()
  try {
    await scenes[name](win)
  } catch (error) {
    const shot = join(tmpdir(), `sb-tour-failure-${name}.png`)
    await win.screenshot({ path: shot, animations: 'disabled', timeout: 3_000 }).catch(() => {})
    console.error(`scene ${name} failed; window state saved to ${shot}`)
    throw error
  } finally {
    await closeApp(app)
  }
  const rawPath = await video.path()
  mkdirSync(distDir, { recursive: true })
  const outputPath = join(distDir, `${name}.mp4`)
  encodeClip(rawPath, outputPath, Math.max(0, (sceneStartedAt - launchedAt) / 1000 - 0.3))
  console.log(`captured ${name} -> ${outputPath}`)
}

// ─── Main ────────────────────────────────────────────────────────────────

const requested = process.argv[2] ?? 'all'
if (requested === '--list') {
  console.log(tourSceneIds.join('\n'))
  process.exit(0)
}
if (!existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js is missing; run npm run build:fast first')
  process.exit(1)
}
const targets = requested === 'all' ? tourSceneIds : [requested]
if (targets.some((name) => !scenes[name])) {
  console.error(`Unknown scene: ${requested}. Known: ${Object.keys(scenes).join(', ')}`)
  process.exit(1)
}
try {
  if (process.env.SB_SCREENSHOT) {
    await screenshot(targets[0], resolve(process.env.SB_SCREENSHOT))
  } else {
    const failed = []
    for (const name of targets) {
      try {
        await capture(name)
      } catch (error) {
        console.error(error)
        failed.push(name)
      }
    }
    if (failed.length) {
      console.error(`failed scenes: ${failed.join(', ')}`)
      process.exitCode = 1
    }
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
