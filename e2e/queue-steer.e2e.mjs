/**
 * Queue vs steer, against the built app (npm run build:fast) with the demo
 * adapter and an isolated profile: while a turn runs, the composer offers
 * Steer and Queue; Alt+Enter queues; the queued message shows as a chip and
 * is sent as its own turn once the running one ends. Temp dirs are removed.
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
const userData = mk('sb-queue-ud-')
const project = realpathSync(mk('sb-queue-proj-'))
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
    window.api.settings.set('session.defaultEnvMode', 'local'),
  ]))
  const skip = win.getByRole('button', { name: 'Skip tour' })
  if (await skip.isVisible().catch(() => false)) await skip.click()
  return { app, win }
}

let { app, win } = await launch()
await app.close()
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${project}', 'queuey', ${Date.now()}, 0);`)
;({ app, win } = await launch())

const results = []
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
try {
  await win.locator('body').click({ position: { x: 900, y: 400 } })
  await win.keyboard.press('Meta+Shift+O')
  await win.getByTestId('new-chat-project-picker').getByRole('option').first().waitFor({ timeout: 5000 })
  await win.keyboard.press('Enter')
  await win.getByTestId('draft-workspace').waitFor({ timeout: 5000 })
  await win.getByTestId('draft-workspace').selectOption('project')
  const editor = win.locator('[contenteditable="true"]').last()
  await editor.click()
  await win.keyboard.type('first message')
  await win.keyboard.press('Enter')
  await win.getByRole('button', { name: 'Steer', exact: true }).waitFor({ timeout: 15_000 })
  check('while running, the primary action is Steer', true)
  check('while running, a Queue action is offered', await win.getByRole('button', { name: 'Queue', exact: true }).count() === 1)
  await editor.click()
  await win.keyboard.type('queued message')
  await win.keyboard.press('Alt+Enter')
  await win.getByTestId('queued-sends').waitFor({ timeout: 3000 })
  check('Alt+Enter shows a Queued chip', (await win.getByTestId('queued-sends').innerText()).includes('queued message'))
  await win.getByTestId('queued-sends').waitFor({ state: 'detached', timeout: 30_000 })
  check('the chip clears once the turn ends', true)
  await win.getByText('queued message').first().waitFor({ timeout: 15_000 })
  const users = q(`SELECT count(*) FROM messages WHERE role = 'user';`)
  check('the queued text went out as its own user turn', Number(users) === 2, `user rows: ${users}`)
} catch (e) {
  check('unexpected error', false, e.message.split('\n')[0])
  await win.screenshot({ path: '/tmp/sb-queue-error.png' }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
