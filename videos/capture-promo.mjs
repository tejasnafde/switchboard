#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = join(repoRoot, 'videos', 'dist')
const scenarioNames = ['file-viewer-context', 'kanban-view', 'panes', 'remote-machines']
const requested = process.argv[2] ?? 'all'
const scenarios = requested === 'all' ? scenarioNames : [requested]
const tempPaths = []
const captureViewport = { width: 1280, height: 720 }
const captureOutput = { width: 2560, height: 1440 }

if (scenarios.some((name) => !scenarioNames.includes(name))) {
  console.error(`Unknown scenario: ${requested}`)
  process.exit(1)
}

function makeTemp(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix))
  tempPaths.push(path)
  return path
}

function cleanup() {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
}

process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

const sql = (value) => value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`
const pause = (page, ms) => page.waitForTimeout(ms)

function makeDemoRepo(projectPath) {
  mkdirSync(join(projectPath, 'src', 'api'), { recursive: true })
  mkdirSync(join(projectPath, 'src', 'components'), { recursive: true })
  mkdirSync(join(projectPath, 'tests'), { recursive: true })
  writeFileSync(join(projectPath, 'package.json'), JSON.stringify({
    name: 'acme-console',
    private: true,
    scripts: { test: 'node tests/auth.test.mjs' },
  }, null, 2))
  writeFileSync(join(projectPath, 'src', 'api', 'auth.ts'), [
    "export async function exchangeCode(code: string) {",
    "  const response = await fetch('/api/oauth/token', {",
    "    method: 'POST',",
    "    body: JSON.stringify({ code }),",
    "  })",
    "  return response.json()",
    "}",
    '',
  ].join('\n'))
  writeFileSync(join(projectPath, 'src', 'components', 'LoginButton.tsx'), [
    "export function LoginButton() {",
    "  return <button>Continue with GitHub</button>",
    "}",
    '',
  ].join('\n'))
  writeFileSync(join(projectPath, 'tests', 'auth.test.mjs'), [
    "console.log('TAP version 13')",
    "console.log('ok 1 - exchanges an OAuth code once')",
    "console.log('ok 2 - rejects an expired state token')",
    "console.log('1..2')",
    '',
  ].join('\n'))
  execFileSync('git', ['init', '-q'], { cwd: projectPath })
  execFileSync('git', ['-c', 'user.email=demo@switchboard.local', '-c', 'user.name=Switchboard Demo', 'add', '.'], { cwd: projectPath })
  execFileSync('git', ['-c', 'user.email=demo@switchboard.local', '-c', 'user.name=Switchboard Demo', 'commit', '-qm', 'Seed demo workspace'], { cwd: projectPath })
}

async function launch(userData, recordDir) {
  console.log(`launching ${recordDir ? 'recording app' : 'fixture bootstrap'}`)
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
  await win.evaluate(() => window.api.settings.set('tour.autoplay', 'false'))
  await pause(win, 650)
  if (recordDir) {
    const state = await win.evaluate(() => ({
      url: location.href,
      title: document.title,
      body: document.body?.innerText.slice(0, 1800) ?? '',
      htmlClass: document.documentElement.className,
    }))
    console.log(`renderer state: ${JSON.stringify(state)}`)
  }
  console.log('app ready')
  return { app, win }
}

async function closeApp(app) {
  await Promise.race([
    app.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Electron close timed out')), 12_000)),
  ])
}

function seedDatabase(dbPath, projectPath) {
  const now = Date.now()
  const messagePills = JSON.stringify({
    auth_file: { label: 'src/api/auth.ts:1-7', kind: 'file' },
    api_log: { label: 'api · oauth callback', kind: 'terminal' },
  })
  const snapshotA = JSON.stringify([
    { path: '/srv/checkout-api', name: 'checkout-api', sessions: [
      { id: 'remote-1', title: 'Trace webhook retries', agentType: 'claude-code' },
      { id: 'remote-2', title: 'Review deploy diff', agentType: 'codex' },
    ] },
  ])
  const snapshotB = JSON.stringify([
    { path: '/opt/acme-console', name: 'acme-console', sessions: [
      { id: 'remote-3', title: 'Run release checks', agentType: 'claude-code' },
    ] },
  ])
  const statements = [
    `INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES (${sql(projectPath)}, 'acme-console', ${now}, 0);`,
    `INSERT OR REPLACE INTO conversations (id, project_path, agent_type, title, created_at, updated_at, runtime_mode, sidebar_role) VALUES ('promo-context', ${sql(projectPath)}, 'claude-code', 'Debug auth callback', ${now - 420000}, ${now}, 'sandbox', 'managed');`,
    `INSERT OR REPLACE INTO conversations (id, project_path, agent_type, title, created_at, updated_at, runtime_mode, sidebar_role) VALUES ('promo-parallel', ${sql(projectPath)}, 'codex', 'Compare retry strategies', ${now - 720000}, ${now - 80000}, 'accept-edits', 'managed');`,
    `INSERT OR REPLACE INTO conversations (id, project_path, agent_type, title, created_at, updated_at, runtime_mode, sidebar_role) VALUES ('promo-release', ${sql(projectPath)}, 'opencode', 'Prepare release notes', ${now - 900000}, ${now - 150000}, 'plan', 'managed');`,
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp) VALUES ('promo-m1', 'promo-context', 'assistant', 'I found the callback path. The state token is validated after the exchange, which means an expired request still reaches the provider.', ${now - 210000});`,
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp, display_body, pills_meta) VALUES ('promo-m2', 'promo-context', 'user', 'Compare src/api/auth.ts lines 1 through 7 with the oauth callback terminal output.', ${now - 150000}, 'Compare [[pill:auth_file]] with [[pill:api_log]].', ${sql(messagePills)});`,
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, tool_calls, timestamp) VALUES ('promo-m3', 'promo-context', 'assistant', 'The exchange should happen only after the state token passes. I would move validation ahead of fetch and keep the callback idempotent.', ${sql(JSON.stringify([{ id: 'read-auth', name: 'Read', input: '{"file_path":"src/api/auth.ts"}', output: '7 lines' }]))}, ${now - 90000});`,
    `INSERT OR REPLACE INTO messages (id, conversation_id, role, content, timestamp) VALUES ('promo-m4', 'promo-context', 'assistant', 'Two focused tests cover it: reject an expired state before network I/O, and exchange a valid code exactly once.', ${now - 30000});`,
    `INSERT OR REPLACE INTO kanban_cards (id, project_path, title, description, tags, status, runtime_mode, worktree_path, worktree_branch, created_at, updated_at) VALUES ('card-1', ${sql(projectPath)}, 'Trace webhook retries', 'Compare backoff strategies without touching the main checkout.', '["backend","reliability"]', 'backlog', 'accept-edits', ${sql(join(projectPath, '.switchboard', 'worktrees', 'webhook-retries'))}, 'kanban/webhook-retries', ${now - 500000}, ${now - 500000});`,
    `INSERT OR REPLACE INTO kanban_cards (id, project_path, title, description, tags, status, runtime_mode, conversation_id, created_at, updated_at) VALUES ('card-2', ${sql(projectPath)}, 'Harden OAuth callback', 'Validate state before exchanging the code.', '["auth","security"]', 'in_progress', 'sandbox', 'promo-context', ${now - 420000}, ${now - 50000});`,
    `INSERT OR REPLACE INTO kanban_cards (id, project_path, title, description, tags, status, runtime_mode, created_at, updated_at) VALUES ('card-3', ${sql(projectPath)}, 'Choose empty-state copy', 'Review the two strongest product directions.', '["design"]', 'needs_input', 'plan', ${now - 300000}, ${now - 70000});`,
    `INSERT OR REPLACE INTO kanban_cards (id, project_path, title, description, tags, status, runtime_mode, completed_at, created_at, updated_at) VALUES ('card-4', ${sql(projectPath)}, 'Add rate-limit telemetry', 'Surface provider reset windows in chat.', '["agents"]', 'done', 'accept-edits', ${now - 60000}, ${now - 600000}, ${now - 60000});`,
    `INSERT OR REPLACE INTO machines (id, name, ssh_alias, ssh_host, ssh_user, ssh_port, transport_kind, sort_order, created_at, updated_at) VALUES ('promo-linux', 'Work machine', 'work', 'work.internal', 'dev', 22, 'ssh', 0, ${now}, ${now});`,
    `INSERT OR REPLACE INTO machines (id, name, ssh_alias, ssh_host, ssh_user, ssh_port, transport_kind, sort_order, created_at, updated_at) VALUES ('promo-build', 'Build server', 'build', 'build.internal', 'deploy', 22, 'ssh', 1, ${now}, ${now});`,
    `INSERT OR REPLACE INTO machine_snapshots (machine_id, data, synced_at) VALUES ('promo-linux', ${sql(snapshotA)}, ${now - 42000});`,
    `INSERT OR REPLACE INTO machine_snapshots (machine_id, data, synced_at) VALUES ('promo-build', ${sql(snapshotB)}, ${now - 95000});`,
  ]
  execFileSync('sqlite3', [dbPath, statements.join('\n')])
}

async function prepareFixture() {
  const userData = makeTemp('switchboard-capture-data-')
  const fixtureRoot = makeTemp('switchboard-capture-project-')
  const projectPath = join(fixtureRoot, 'acme-console')
  makeDemoRepo(projectPath)

  const bootstrap = await launch(userData)
  await closeApp(bootstrap.app)
  console.log('fixture bootstrap closed')
  const dbPath = join(userData, 'data', 'switchboard.db')
  if (!existsSync(dbPath)) throw new Error(`Switchboard database was not created at ${dbPath}`)
  seedDatabase(dbPath, projectPath)
  console.log('fixture database seeded')
  return { userData, projectPath }
}

async function selectConversation(win) {
  const thread = win.locator('.sidebar-thread-main').filter({ hasText: 'Debug auth callback' })
  try {
    await thread.waitFor({ state: 'visible', timeout: 15_000 })
  } catch (error) {
    const sidebarText = await win.locator('.sidebar-root').innerText({ timeout: 2_000 }).catch(() => '(sidebar unavailable)')
    await win.screenshot({ path: join(tmpdir(), 'switchboard-promo-capture-debug.png'), animations: 'disabled', timeout: 2_000 }).catch(() => {})
    console.error(`Sidebar at capture failure:\n${sidebarText}`)
    throw error
  }
  await thread.click()
  await win.locator('.chat-identity-title').filter({ hasText: 'Debug auth callback' }).waitFor({ state: 'visible' })
}

async function playScenario(name, win) {
  if (name === 'file-viewer-context') {
    await pause(win, 900)
    await selectConversation(win)
    await pause(win, 1000)
    const pills = win.locator('[data-pill-chip="true"]')
    if (await pills.count()) {
      await pills.first().hover({ force: true })
      await pause(win, 900)
      if (await pills.count() > 1) await pills.nth(1).hover({ force: true })
    }
    await pause(win, 1800)
    return
  }

  if (name === 'kanban-view') {
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
    await pause(win, 2000)
    return
  }

  if (name === 'panes') {
    await selectConversation(win)
    await pause(win, 900)
    const terminal = win.locator('[data-terminal-pane]').first()
    await terminal.waitFor({ state: 'visible', timeout: 12_000 })
    await terminal.click({ position: { x: 80, y: 90 } })
    await win.keyboard.press('Meta+Shift+T')
    await pause(win, 800)
    const latest = win.locator('[data-terminal-pane]').last()
    await latest.click({ position: { x: 80, y: 90 } })
    await win.keyboard.type('npm test', { delay: 70 })
    await win.keyboard.press('Enter')
    await pause(win, 2400)
    return
  }

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
}

function encodeClip(rawPath, outputPath) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-sseof', '-6.5', '-i', rawPath, '-t', '6.5',
    '-vf', 'fps=30,scale=2560:1440:force_original_aspect_ratio=decrease,pad=2560:1440:(ow-iw)/2:(oh-ih)/2:color=0x090b0d',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', outputPath,
  ], { stdio: 'inherit' })
}

// ponytail: SB_SCREENSHOT=<path> takes one PNG of the scenario's end state instead of a clip
async function screenshot(name, outputPath) {
  const fixture = await prepareFixture()
  const { app, win } = await launch(fixture.userData)
  try {
    await playScenario(name, win)
    mkdirSync(dirname(outputPath), { recursive: true })
    await win.screenshot({ path: outputPath, animations: 'disabled' })
    console.log(`captured ${name} -> ${outputPath}`)
  } finally {
    await closeApp(app)
  }
}

async function capture(name) {
  if (process.env.SB_SCREENSHOT) return screenshot(name, resolve(process.env.SB_SCREENSHOT))
  console.log(`preparing ${name}`)
  const fixture = await prepareFixture()
  const recordDir = makeTemp(`switchboard-capture-video-${name}-`)
  const { app, win } = await launch(fixture.userData, recordDir)
  const video = win.video()
  if (!video) throw new Error('Playwright did not attach a video recorder')

  try {
    console.log(`playing ${name}`)
    await playScenario(name, win)
    console.log(`finished ${name}`)
  } finally {
    await closeApp(app)
  }

  const rawPath = await video.path()
  mkdirSync(distDir, { recursive: true })
  const outputPath = join(distDir, `${name}.mp4`)
  encodeClip(rawPath, outputPath)
  console.log(`captured ${name} -> ${outputPath}`)
}

if (!existsSync(join(repoRoot, 'out', 'main', 'index.js'))) {
  console.error('out/main/index.js is missing; run npm run build:fast first')
  process.exit(1)
}

try {
  for (const name of scenarios) await capture(name)
} finally {
  cleanup()
}
