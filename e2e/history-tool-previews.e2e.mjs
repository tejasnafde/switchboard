/**
 * A long tool call in history arrives as a preview and loads in full when it
 * is expanded, against the built app (npm run build:fast) with the demo
 * adapter and an isolated profile. The chat is SQLite-only: one assistant
 * row whose Bash call has 20,000 characters of output ending in a marker.
 * Takes ~20s. Temp dirs are removed.
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

const results = []
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }

const userData = mk('sb-toolpreview-ud-')
const project = realpathSync(mk('sb-toolpreview-proj-'))
const db = join(userData, 'data', 'switchboard.db')
const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim()

async function launch() {
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1', SHELL: '/bin/sh' } })
  const win = await app.firstWindow({ timeout: 20_000 })
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  await win.evaluate(() => Promise.all([
    window.api.settings.set('tour.autoplay', 'false'),
    window.api.settings.set('analytics.enabled', 'false'),
    window.api.settings.set('analytics.noticeSeen', 'true'),
  ]))
  const skip = win.getByRole('button', { name: 'Skip tour' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  return { app, win }
}

let { app, win } = await launch()
await app.close()
const now = Date.now()
const output = `${'line of build output\n'.repeat(1000)}END-OF-OUTPUT`
const toolCalls = JSON.stringify([{ id: 'tool-1', name: 'Bash', input: JSON.stringify({ command: 'npm run build' }), output }])
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${project}', 'toolpreview', ${now}, 0);`)
q(`INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at) VALUES ('preview-chat', '${project}', 'claude-code', 'Long build output', ${now}, ${now});`)
q(`INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('u1', 'preview-chat', 'user', 'build it', ${now - 3000});`)
q(`INSERT INTO messages (id, conversation_id, role, content, tool_calls, timestamp) VALUES ('a1', 'preview-chat', 'assistant', '', '${toolCalls.replace(/'/g, "''")}', ${now - 2000});`)
q(`INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('a2', 'preview-chat', 'assistant', 'The build passed.', ${now - 1000});`)
;({ app, win } = await launch())

try {
  await win.getByTestId('app-sidebar').getByText('Long build output', { exact: true }).first().click()
  await win.getByText('The build passed.').first().waitFor({ timeout: 10_000 })
  const panel = win.locator('[data-chat-panel]').first()
  const activity = panel.locator('.turn-activity > summary').first()
  if (await activity.isVisible().catch(() => false)) await activity.click()
  const trigger = panel.locator('.tool-call-trigger').first()
  await trigger.waitFor({ timeout: 5000 })
  await trigger.click()
  const loaded = await panel.getByText('END-OF-OUTPUT').first().waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('expanding the call loads its whole output', loaded)
} catch (e) {
  check('unexpected error', false, e.message.split('\n').slice(0, 3).join(' / '))
  await win.screenshot({ path: join(tmpdir(), 'sb-toolpreview-error.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}

const failed = results.filter((r) => !r.ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
