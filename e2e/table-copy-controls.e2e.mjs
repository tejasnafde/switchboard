#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('out/main/index.js missing - run npm run build:fast first')
  process.exit(1)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'tablecopy-e2e-'))
const userDataDir = join(tempRoot, 'user-data')
const isolatedHome = join(tempRoot, 'home')
const projectPath = join(tempRoot, 'project')
const conversationId = 'table-copy-e2e-thread'
const title = 'Table Copy E2E'
let app

for (const path of [userDataDir, isolatedHome, projectPath, join(tempRoot, 'tmp')]) {
  mkdirSync(path, { recursive: true })
}

const cleanup = () => rmSync(tempRoot, { recursive: true, force: true })
process.once('exit', cleanup)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

function isolatedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/i.test(key)) delete env[key]
  }
  delete env.SWITCHBOARD_BACKEND_URL
  delete env.SWITCHBOARD_DATA_DIR
  return {
    ...env,
    HOME: isolatedHome,
    TMPDIR: join(tempRoot, 'tmp'),
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local/share'),
    CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude'),
    CODEX_HOME: join(isolatedHome, '.codex'),
    OPENCODE_CONFIG_DIR: join(isolatedHome, '.config/opencode'),
    SB_USER_DATA: userDataDir,
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }
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

async function launch() {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: isolatedEnv(),
  })
  const win = await app.firstWindow({ timeout: 20_000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  await win.waitForTimeout(550)
  const skipTour = win.getByRole('button', { name: 'Skip tour' })
  if (await skipTour.isVisible()) await skipTour.click()
  return win
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

const screenshotDir = process.env.SB_TABLE_COPY_SCREENSHOTS

// The table from the report that asked for this control.
const tableMarkdown = [
  '| Check | Match rate |',
  '| --- | --- |',
  "| `roster_adherence_pct` = % of staff with `roster_adherence = 'Compliant'` | 39,426 / 39,459 (99.9%) |",
  "| **roster_compliant** = count, with a comma | 38,236 / 39,459 (97%) |",
].join('\n')

function seedConversation() {
  const now = Date.now()
  const historical = `BigQuery check (\`ssg_dev_marts\`, 14-27 Sep):\n\n${tableMarkdown}\n\nhistorical_table_marker`
  const sql = [
    `INSERT INTO projects (path, name, added_at) VALUES (${quote(projectPath)}, 'Table Copy Fixture', ${now});`,
    `INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at, sidebar_role) VALUES (${quote(conversationId)}, ${quote(projectPath)}, 'codex', ${quote(title)}, ${now}, ${now}, 'managed');`,
    `INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('historical-table', ${quote(conversationId)}, 'assistant', ${quote(historical)}, ${now});`,
  ].join('\n')
  execFileSync('sqlite3', [join(userDataDir, 'data', 'switchboard.db'), sql])
}

async function emit(event) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.getTitle() === 'Switchboard')
    if (!win) throw new Error('Switchboard BrowserWindow not found')
    win.webContents.send('provider:event', payload)
  }, event)
}

// The real system clipboard, read from the main process: this is what Slack,
// Sheets or Docs would receive on paste.
async function readClipboard() {
  return app.evaluate(({ clipboard }) => ({ html: clipboard.readHTML(), text: clipboard.readText(), formats: clipboard.availableFormats() }))
}

async function waitForText(locator, text) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (await locator.textContent() === text) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

async function clipboardWhen(predicate) {
  const deadline = Date.now() + 3_000
  let value = await readClipboard()
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    value = await readClipboard()
  }
  if (!predicate(value)) console.log('  clipboard:', JSON.stringify(value))
  return value
}

function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`✓ ${message}`)
}

let savedClipboard
try {
  await launch()
  await closeApp()
  seedConversation()

  const win = await launch()
  savedClipboard = await readClipboard()
  const pageErrors = []
  win.on('pageerror', (error) => pageErrors.push(error.message))
  win.on('console', (msg) => { if (msg.type() === 'warning' || msg.type() === 'error') console.log(`  [renderer ${msg.type()}] ${msg.text()}`) })
  await win.bringToFront()

  const recent = win.locator('.sidebar-recent-row').filter({ hasText: title })
  await recent.waitFor({ state: 'visible', timeout: 15_000 })
  await recent.click()

  const message = win.locator('.markdown-content').filter({ hasText: 'historical_table_marker' })
  await message.waitFor({ state: 'visible', timeout: 15_000 })
  const box = message.locator('.markdown-table')
  const controls = box.locator('.table-copy-controls')
  const copyButton = box.locator('.table-copy-btn')
  const menuButton = box.locator('.table-copy-menu-btn')
  check(await copyButton.count() === 1 && await menuButton.count() === 1, 'a settled table has one copy button and one menu button')

  await win.mouse.move(0, 0)
  await win.waitForTimeout(200)
  check(await controls.evaluate((el) => getComputedStyle(el).opacity) === '0', 'controls stay out of the way until hover')
  await box.hover()
  await win.waitForTimeout(200)
  check(await controls.evaluate((el) => getComputedStyle(el).opacity) === '1', 'hovering the table shows the controls')
  const boxRect = await box.boundingBox()
  const controlsRect = await controls.boundingBox()
  check(!!boxRect && !!controlsRect && Math.abs(boxRect.x + boxRect.width - (controlsRect.x + controlsRect.width)) < 8 && controlsRect.y - boxRect.y < 8, 'controls sit at the top-right of the table box')
  if (screenshotDir) await box.screenshot({ path: join(screenshotDir, 'table-hover.png') })

  await copyButton.click()
  check(await waitForText(copyButton, 'Copied'), 'copy feedback becomes Copied')
  const copied = await clipboardWhen((c) => c.html.includes('<table>'))
  check(copied.html.includes('<table><thead><tr><th>Check</th><th>Match rate</th></tr></thead>'), 'clipboard HTML is a clean table with a header')
  check(copied.html.includes('<code>roster_adherence_pct</code>') && copied.html.includes('<strong>roster_compliant</strong>'), 'clipboard HTML keeps code and bold')
  check(!/class=|style=/.test(copied.html.replace(/^[\s\S]*?<table>/, '<table>')), 'clipboard HTML table has no classes or styles')
  check(copied.text === [
    'Check\tMatch rate',
    "roster_adherence_pct = % of staff with roster_adherence = 'Compliant'\t39,426 / 39,459 (99.9%)",
    'roster_compliant = count, with a comma\t38,236 / 39,459 (97%)',
  ].join('\n'), 'clipboard plain text is TSV of the same item')
  await win.waitForTimeout(1_650)
  check(await waitForText(copyButton, 'Copy'), 'copy feedback resets')

  await menuButton.click()
  const menu = win.getByRole('dialog', { name: 'Copy table as' })
  await menu.waitFor({ state: 'visible', timeout: 3_000 })
  check(await menuButton.getAttribute('aria-expanded') === 'true', 'menu button reports expanded')
  if (screenshotDir) await win.screenshot({ path: join(screenshotDir, 'table-menu.png') })
  await menu.getByRole('button', { name: /Copy as CSV/ }).click()
  await menu.waitFor({ state: 'hidden', timeout: 3_000 })
  const csv = await clipboardWhen((c) => c.text.startsWith('Check,'))
  check(csv.text.startsWith('Check,Match rate\r\n') && csv.text.includes('"roster_compliant = count, with a comma","38,236 / 39,459 (97%)"'), 'Copy as CSV writes RFC 4180 CSV')
  check(!csv.formats.includes('text/html'), 'Copy as CSV writes plain text only')
  check(await waitForText(copyButton, 'Copied'), 'menu choices show the same Copied feedback')
  check(await menuButton.evaluate((el) => document.activeElement === el), 'focus returns to the menu button after a choice')
  check(await menuButton.getAttribute('aria-expanded') === 'false', 'menu button reports collapsed')

  await menuButton.press('Enter')
  await menu.waitFor({ state: 'visible', timeout: 3_000 })
  await win.keyboard.press('Tab')
  await win.keyboard.press('Enter')
  await menu.waitFor({ state: 'hidden', timeout: 3_000 })
  const md = await clipboardWhen((c) => c.text.startsWith('| Check'))
  check(md.text.startsWith('| Check | Match rate |\n| --- | --- |\n'), 'keyboard reaches Copy as Markdown and writes a pipe table')

  await menuButton.press('Enter')
  await menu.waitFor({ state: 'visible', timeout: 3_000 })
  await win.keyboard.press('Escape')
  await menu.waitFor({ state: 'hidden', timeout: 3_000 })
  check(await menuButton.evaluate((el) => document.activeElement === el), 'Escape closes the menu and returns focus')

  await menuButton.click()
  await menu.waitFor({ state: 'visible', timeout: 3_000 })
  await menuButton.click()
  await menu.waitFor({ state: 'hidden', timeout: 3_000 })
  check(true, 'the menu button toggles the menu closed')

  const partial = 'Streaming table:\n\n| Name | Rows |\n| --- | --- |\n| alpha | 1 |\n| beta | 2'
  await emit({ type: 'content', threadId: conversationId, messageId: 'stream-1', text: partial, streamKind: 'assistant' })
  const streaming = win.locator('.markdown-content').filter({ hasText: 'Streaming table:' })
  await streaming.locator('.markdown-table').waitFor({ state: 'attached', timeout: 5_000 })
  await streaming.locator('.markdown-table').hover()
  check(await streaming.locator('.markdown-table[data-table-state="provisional"]').count() === 1, 'a table that may still grow is provisional')
  check(!(await streaming.locator('.table-copy-btn').isVisible()), 'a provisional table offers no copy')
  await emit({ type: 'content', threadId: conversationId, messageId: 'stream-1', text: `${partial} |\n\nAfter the table.`, streamKind: 'assistant' })
  await streaming.locator('.markdown-table[data-table-state="settled"]').waitFor({ state: 'attached', timeout: 5_000 })
  await streaming.locator('.markdown-table').hover()
  check(await streaming.locator('.table-copy-btn').isVisible(), 'the table settles once content follows it')

  await streaming.locator('.table-copy-btn').focus()
  await emit({ type: 'content', threadId: conversationId, messageId: 'stream-1', text: `${partial} |\n\nAfter the table. More prose.`, streamKind: 'assistant' })
  await streaming.getByText('More prose.', { exact: false }).waitFor({ state: 'visible' })
  check(await streaming.locator('.table-copy-btn').evaluate((el) => document.activeElement === el), 'keyboard focus survives later streaming commits')

  await emit({ type: 'turn.completed', threadId: conversationId, durationMs: 200 })
  check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`)

  console.log('\nTABLE COPY CONTROLS E2E PASSED')
} catch (error) {
  console.error('\nTABLE COPY CONTROLS E2E FAILED')
  console.error(error)
  process.exitCode = 1
} finally {
  if (app && savedClipboard) {
    await app.evaluate(({ clipboard }, saved) => {
      clipboard.write({ text: saved.text, ...(saved.html ? { html: saved.html } : {}) })
    }, savedClipboard).catch((error) => console.error('could not restore the clipboard', error))
  }
  await closeApp()
}
