/**
 * Chat render order survives a switch away and back, against the built app
 * (npm run build:fast) with the demo adapter and an isolated profile.
 *
 * The demo turn streams reasoning, interim text, a tool that runs past the
 * reload merge's 60s window, then the final text, and writes a Claude-shaped
 * transcript the way the CLI does. Switching chats evicts the idle chat, so
 * coming back reloads it from that transcript merged with SQLite. The interim
 * text used to come back a second time, below the final answer. Takes ~90s.
 * Temp dirs are removed.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
process.on('exit', () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })
const userData = mk('sb-order-ud-')
const project = realpathSync(mk('sb-order-proj-'))
const claudeDir = realpathSync(mk('sb-order-claude-'))
const db = join(userData, 'data', 'switchboard.db')
const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim()

async function launch() {
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1',
      SB_DEMO_CLAUDE_TRANSCRIPT_DIR: claudeDir, SHELL: '/bin/sh' } })
  const win = await app.firstWindow({ timeout: 20_000 })
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  await win.evaluate(() => Promise.all([
    window.api.settings.set('tour.autoplay', 'false'),
    window.api.settings.set('analytics.enabled', 'false'),
    window.api.settings.set('analytics.noticeSeen', 'true'),
    window.api.settings.set('session.defaultEnvMode', 'local'),
  ]))
  const skip = win.getByRole('button', { name: 'Skip tour' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  return { app, win }
}

let { app, win } = await launch()
await app.close()
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${project}', 'ordery', ${Date.now()}, 0);`)
// History scans every enabled oauth_dir, so this is where it finds the transcript.
q(`INSERT OR REPLACE INTO provider_instances (id, agent_type, display_name, auth_mode, oauth_dir, enabled)
   VALUES ('claude-code-e2e', 'claude-code', 'e2e', 'oauth_dir', '${claudeDir}', 1);`)
;({ app, win } = await launch())

const results = []
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
const MARKERS = { 'Interim note': 'interim', 'Final answer': 'final' }
/** Every marker occurrence in the focused chat, in DOM order. */
const markerOrder = () => win.evaluate((markers) => {
  const text = document.querySelector('[data-chat-panel]')?.innerText ?? ''
  const hits = []
  for (const [needle, name] of Object.entries(markers)) {
    for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) hits.push([i, name])
  }
  return hits.sort((a, b) => a[0] - b[0]).map(([, name]) => name).join(',')
}, MARKERS)
/** The registry mirrors a turn's text to SQLite at turn end, so a row means the turn is over. */
const replied = async (prefix, timeout) => {
  const until = Date.now() + timeout
  while (!q(`SELECT 1 FROM messages WHERE role = 'assistant' AND content LIKE '${prefix}%';`)) {
    if (Date.now() > until) throw new Error(`no finished turn ending in "${prefix}"`)
    await win.waitForTimeout(500)
  }
}
async function newChat(text) {
  await win.locator('body').click({ position: { x: 900, y: 400 } })
  await win.keyboard.press('Meta+Shift+O')
  await win.getByTestId('new-chat-project-picker').getByRole('option').first().waitFor({ timeout: 5000 })
  await win.keyboard.press('Enter')
  await win.getByTestId('draft-workspace').waitFor({ timeout: 5000 })
  await win.getByTestId('draft-workspace').selectOption('project')
  await win.locator('[contenteditable="true"]').last().click()
  await win.keyboard.type(text)
  await win.keyboard.press('Enter')
}
const open = async (title) => {
  await win.getByTestId('app-sidebar').getByText(title, { exact: true }).first().click()
  await win.waitForTimeout(1500)
}

try {
  await newChat('check the render order')
  await replied('Final answer', 120_000)
  const live = await markerOrder()
  check('the live turn ends with the final answer', live.endsWith('final'), live)

  await newChat('hello there')
  await replied('Two focused tests', 30_000)
  // A -> B evicts A's messages (idle), B -> A reloads them from history.
  await open('check the render order')
  await open('hello there')
  await open('check the render order')
  await win.getByText('Final answer').first().waitFor({ timeout: 10_000 })
  const reloaded = await markerOrder()
  check('after switching away and back, the order is unchanged', reloaded === live, `live=${live} reloaded=${reloaded}`)

  // A 61s tool separates them. Rows stamped at turn end land within a few ms.
  const at = (prefix) => Number(q(`SELECT timestamp FROM messages WHERE role = 'assistant' AND content LIKE '${prefix}%';`))
  const interimAt = at('Interim note')
  const finalAt = at('Final answer')
  check('the mirrored interim text keeps its own time, before the tool call', interimAt > 0 && finalAt - interimAt > 30_000, `${interimAt} < ${finalAt}`)
} catch (e) {
  check('unexpected error', false, e.message.split('\n')[0])
  await win.screenshot({ path: join(tmpdir(), 'sb-order-error.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
