#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('out/main/index.js missing - run npm run build:fast first')
  process.exit(1)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'codecopy-e2e-'))
const userDataDir = join(tempRoot, 'user-data')
const isolatedHome = join(tempRoot, 'home')
const projectPath = join(tempRoot, 'project')
const conversationId = 'code-copy-e2e-thread'
const title = 'Code Copy E2E'
let app

for (const path of [userDataDir, isolatedHome, projectPath, join(tempRoot, 'tmp')]) {
  mkdirSync(path, { recursive: true })
}
mkdirSync(join(projectPath, 'src/main'), { recursive: true })
writeFileSync(join(projectPath, 'src/main/index.ts'), 'export const fixture = true\n')

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

function seedConversation() {
  const now = Date.now()
  const historical = [
    'Historical file `src/main/index.ts:1`.',
    '',
    '```sql',
    "select 'historical_sql_marker';",
    '```',
    '',
    '```',
    'historical_untagged_marker',
    '```',
  ].join('\n')
  const sql = [
    `INSERT INTO projects (path, name, added_at) VALUES (${quote(projectPath)}, 'Code Copy Fixture', ${now});`,
    `INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at, sidebar_role) VALUES (${quote(conversationId)}, ${quote(projectPath)}, 'codex', ${quote(title)}, ${now}, ${now}, 'managed');`,
    `INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('historical-code', ${quote(conversationId)}, 'assistant', ${quote(historical)}, ${now});`,
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

function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`✓ ${message}`)
}

try {
  await launch()
  await closeApp()
  seedConversation()

  const win = await launch()
  const pageErrors = []
  win.on('pageerror', (error) => pageErrors.push(error.message))

  const recent = win.locator('.sidebar-recent-row').filter({ hasText: title })
  await recent.waitFor({ state: 'visible', timeout: 15_000 })
  await recent.click()

  const historical = win.locator('.markdown-content').filter({ hasText: 'historical_sql_marker' })
  await historical.waitFor({ state: 'visible', timeout: 15_000 })
  const historicalButtons = historical.locator('.code-copy-btn')
  check(await historicalButtons.count() === 2, 'historical tagged and untagged blocks have one control each')
  check(await historicalButtons.first().isVisible(), 'historical controls are settled on initial render')
  const restingStyle = await historicalButtons.first().evaluate((button) => {
    const style = getComputedStyle(button)
    return { opacity: style.opacity, visibility: style.visibility }
  })
  check(restingStyle.opacity === '1' && restingStyle.visibility === 'visible', 'resting desktop affordance is visibly discoverable')
  await historical.locator('.file-chip').waitFor({ state: 'visible', timeout: 5_000 })
  check(true, 'inline file-pill enhancement remains active beside Markdown code blocks')

  await win.evaluate(() => {
    window.__codeCopyE2E = { writes: [], reject: false, flashes: 0, unhandled: [] }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (window.__codeCopyE2E.reject) throw new Error('denied by E2E fixture')
          window.__codeCopyE2E.writes.push(text)
        },
      },
    })
    addEventListener('unhandledrejection', (event) => {
      window.__codeCopyE2E.unhandled.push(String(event.reason))
      event.preventDefault()
    })
    const inspect = () => {
      for (const button of document.querySelectorAll('[data-code-state="provisional"] .code-copy-btn')) {
        if (getComputedStyle(button).visibility !== 'hidden') window.__codeCopyE2E.flashes++
      }
    }
    new MutationObserver(inspect).observe(document.body, { childList: true, subtree: true, attributes: true })
  })

  await historicalButtons.first().click()
  check(await historicalButtons.first().textContent() === 'Copied', 'copy feedback becomes Copied')
  const firstWrite = await win.evaluate(() => window.__codeCopyE2E.writes[0])
  check(firstWrite === "select 'historical_sql_marker';\n", 'clipboard receives exact code text only')
  await win.waitForTimeout(1_650)
  check(await historicalButtons.first().textContent() === 'Copy', 'copy feedback resets cleanly')

  const firstSnapshot = "```sql\nselect 'stream_marker'"
  await emit({ type: 'content', threadId: conversationId, messageId: 'stream-1', text: firstSnapshot, streamKind: 'assistant' })
  const streaming = win.locator('.markdown-content').filter({ hasText: 'stream_marker' })
  await streaming.waitFor({ state: 'attached', timeout: 5_000 })
  let streamingButton = streaming.locator('.code-copy-btn')
  check(await streamingButton.count() === 1 && !(await streamingButton.isVisible()), 'unfinished fenced block keeps one hidden provisional control')

  await emit({
    type: 'content',
    threadId: conversationId,
    messageId: 'stream-1',
    text: `${firstSnapshot}\nfrom generated_rows`,
    streamKind: 'assistant',
  })
  await streaming.getByText('from generated_rows', { exact: false }).waitFor({ state: 'visible' })
  check(!(await streamingButton.isVisible()), 'additional cumulative chunks do not flash the provisional control')

  const closedSnapshot = `${firstSnapshot}\nfrom generated_rows\n\`\`\``
  await emit({ type: 'content', threadId: conversationId, messageId: 'stream-1', text: closedSnapshot, streamKind: 'assistant' })
  await streaming.locator('[data-code-state="settled"]').waitFor({ state: 'visible' })
  streamingButton = streaming.locator('.code-copy-btn')
  check(await streamingButton.isVisible(), 'closed code block becomes available once while later content may stream')

  await streamingButton.focus()
  await emit({
    type: 'content',
    threadId: conversationId,
    messageId: 'stream-1',
    text: `${closedSnapshot}\n\nLater streaming prose marker.`,
    streamKind: 'assistant',
  })
  await streaming.getByText('Later streaming prose marker.', { exact: true }).waitFor({ state: 'visible' })
  check(await streamingButton.evaluate((button) => document.activeElement === button), 'keyboard focus survives later prose commits')
  check(await historicalButtons.first().isVisible(), 'completed historical blocks stay visible during another message update')

  await emit({ type: 'turn.completed', threadId: conversationId, durationMs: 200 })
  check(await streaming.locator('.code-copy-btn').count() === 1, 'turn completion leaves exactly one control')

  await emit({ type: 'tool.started', threadId: conversationId, toolId: 'tool-e2e', toolName: 'Bash', input: { command: 'printf fixture' } })
  await emit({ type: 'tool.completed', threadId: conversationId, toolId: 'tool-e2e', output: Array.from({ length: 80 }, (_, index) => `tool output ${index}`).join('\n') })
  const activity = win.locator('details.turn-activity').last()
  await activity.locator('summary').click()
  const toolTrigger = win.locator('.tool-call-trigger').filter({ hasText: 'Bash' }).last()
  await toolTrigger.click()
  const toolBlock = win.locator('.tool-code-block').last()
  const toolbar = toolBlock.locator('.tool-code-toolbar')
  const toolPre = toolBlock.locator('pre')
  await toolbar.waitFor({ state: 'visible' })
  const beforeScroll = await toolbar.boundingBox()
  const preBox = await toolPre.boundingBox()
  check(!!beforeScroll && !!preBox && beforeScroll.y + beforeScroll.height <= preBox.y + 1, 'tool copy toolbar does not overlap code')
  await toolPre.evaluate((pre) => { pre.scrollTop = pre.scrollHeight })
  const afterScroll = await toolbar.boundingBox()
  check(!!beforeScroll && !!afterScroll && Math.abs(beforeScroll.y - afterScroll.y) < 1, 'tool copy control remains reachable while output scrolls')

  await emit({ type: 'content', threadId: conversationId, messageId: 'stream-2', text: '```\ninterrupted_marker', streamKind: 'assistant' })
  const interrupted = win.locator('.markdown-content').filter({ hasText: 'interrupted_marker' })
  await interrupted.waitFor({ state: 'attached' })
  check(!(await interrupted.locator('.code-copy-btn').isVisible()), 'new unfinished block is hidden while mutable')
  await emit({ type: 'error', threadId: conversationId, message: 'isolated E2E interruption' })
  await interrupted.locator('[data-code-state="settled"]').waitFor({ state: 'visible' })
  check(await interrupted.locator('.code-copy-btn').isVisible(), 'error path settles an unfinished visible block')

  await win.evaluate(() => { window.__codeCopyE2E.reject = true })
  await historicalButtons.first().click()
  await win.waitForTimeout(100)
  const rejected = await win.evaluate(() => ({
    unhandled: window.__codeCopyE2E.unhandled,
    flashes: window.__codeCopyE2E.flashes,
  }))
  check(rejected.unhandled.length === 0 && pageErrors.length === 0, 'clipboard rejection produces no unhandled rejection')
  check(rejected.flashes === 0, 'no provisional copy control became visible during observed streaming mutations')

  await win.evaluate(() => { window.__codeCopyE2E.reject = false })
  await historicalButtons.first().focus()
  await historicalButtons.first().press('Enter')
  const keyboardWrite = await win.evaluate(() => window.__codeCopyE2E.writes.at(-1))
  check(keyboardWrite === "select 'historical_sql_marker';\n", 'keyboard activation copies exact code text')

  console.log('\nCODE COPY CONTROLS E2E PASSED')
} catch (error) {
  console.error('\nCODE COPY CONTROLS E2E FAILED')
  console.error(error)
  process.exitCode = 1
} finally {
  await closeApp()
}
