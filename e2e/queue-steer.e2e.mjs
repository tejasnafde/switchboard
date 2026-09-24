/**
 * Queue vs steer, against the built app (npm run build:fast) with the demo
 * adapter and an isolated profile: while a turn runs, the composer's round
 * send button steers (the default) and names Alt+Enter for queue in its
 * tooltip; Alt+Enter queues; the queued message shows as a Queued bubble and
 * is sent as its own turn once the running one ends. Then, behind a turn
 * held open on an approval: Send now steers a queued message into it, and
 * Cancel takes one back into the composer. Temp dirs are removed.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareElectronTestRuntime } from './electron-runtime.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
process.on('exit', () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })
const userData = mk('sb-queue-ud-')
const project = realpathSync(mk('sb-queue-proj-'))
const db = join(userData, 'data', 'switchboard.db')
const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim()
// An isolated copy with Electron-ABI natives, so the repo's node_modules can
// stay on the Node ABI that vitest needs.
const runtime = await prepareElectronTestRuntime({ repoRoot })
process.on('exit', () => runtime.cleanup())

async function launch() {
  const app = await electron.launch({ args: [runtime.appPath], cwd: repoRoot, timeout: 30_000,
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
  // Record turn starts and ends, to prove the order and not just the count.
  await win.evaluate(() => {
    window.__turnLog = []
    window.api.provider.onEvent((e) => {
      if (e.type === 'turn.completed') window.__turnLog.push('end')
      else if (e.type === 'status' && e.status === 'running') window.__turnLog.push('start')
    })
  })
  const editor = win.locator('[contenteditable="true"]').last()
  await editor.click()
  await win.keyboard.type('first message')
  await win.keyboard.press('Enter')
  const send = win.getByRole('button', { name: 'Steer', exact: true })
  await send.waitFor({ timeout: 15_000 })
  check('while running, the send button steers', true)
  const tooltip = await send.getAttribute('title')
  check('its tooltip names both keys', tooltip === 'Steer (Enter) · Queue (⌥Enter)', String(tooltip))
  check('a round Stop button shows while running', await win.getByRole('button', { name: 'Stop', exact: true }).count() === 1)
  check('there is no separate Queue button', await win.getByRole('button', { name: 'Queue', exact: true }).count() === 0)
  await editor.click()
  await win.keyboard.type('queued message')
  await win.keyboard.press('Alt+Enter')
  // The backend holds it: both messages show at once, and a second turn runs
  // after the first. Two turn completions in a row prove it was not steered.
  await win.getByText('queued message').first().waitFor({ timeout: 5000 })
  check('Alt+Enter posts the message at once (the backend holds it)', true)
  const queuedChip = await win.locator('[data-queued-turn]').getByText('Queued', { exact: true })
    .waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('the held message shows as a Queued bubble', queuedChip)
  // Two finished turns, polled: the button can read Send between the two.
  const twoTurns = await win.waitForFunction(() => document.body.innerText.split('Worked for').length - 1 >= 2, null, { timeout: 30_000 })
    .then(() => true, () => false)
  check('the queued message ran as its own turn after the first', twoTurns)
  // Collapse repeats: a sequential run reads start,end,start,end. Two turns
  // at once would read start,end,end.
  const order = (await win.evaluate(() => window.__turnLog)).filter((x, i, a) => x !== a[i - 1]).join(',')
  check('the second turn starts after the first one ends', order.startsWith('start,end,start,end'), order)
  await win.waitForTimeout(1000)
  const users = q(`SELECT count(*) FROM messages WHERE role = 'user';`)
  check('both user turns are recorded', Number(users) === 2, `user rows: ${users}`)
  check('the Queued bubble is gone once it ran', await win.locator('[data-queued-turn]').count() === 0)

  // A turn held open on an approval, so the queue stays put while we act on it.
  await editor.click()
  await win.keyboard.type('run the tests')
  await win.keyboard.press('Enter')
  await win.getByText('npm test').first().waitFor({ timeout: 15_000 })
  const replies = () => win.evaluate(() => document.body.innerText.split('Two focused tests cover it').length - 1)
  const repliesBefore = await replies()

  await editor.click()
  await win.keyboard.type('steer this in')
  await win.keyboard.press('Alt+Enter')
  const steerRow = win.locator('[data-queued-turn]')
  await steerRow.waitFor({ timeout: 5000 })
  await steerRow.getByRole('button', { name: 'Send now', exact: true }).click()
  const promoted = await steerRow.waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false)
  check('Send now takes the message out of the queue', promoted)
  // It runs while the approval still holds the first turn open: a steer, not a queue.
  const steered = await win.waitForFunction(
    (before) => document.body.innerText.split('Two focused tests cover it').length - 1 > before,
    repliesBefore, { timeout: 15_000 },
  ).then(() => true, () => false)
  check('the promoted message runs inside the running turn', steered)

  await editor.click()
  await win.keyboard.type('take this back')
  await win.keyboard.press('Alt+Enter')
  const cancelRow = win.locator('[data-queued-turn]')
  await cancelRow.waitFor({ timeout: 5000 })
  await cancelRow.getByRole('button', { name: 'Cancel', exact: true }).click()
  const removed = await win.locator('.message-bubble', { hasText: 'take this back' }).first()
    .waitFor({ state: 'detached', timeout: 5000 }).then(() => true, () => false)
  const composerText = (await editor.innerText()).trim()
  check('Cancel puts the text back in the composer', composerText === 'take this back', JSON.stringify(composerText))
  check('the cancelled bubble leaves the chat', await win.locator('[data-queued-turn]').count() === 0 && removed)
  await win.waitForTimeout(500)
  const cancelledRows = q(`SELECT count(*) FROM messages WHERE role = 'user' AND content = 'take this back';`)
  check('the cancelled message is not stored', Number(cancelledRows) === 0, `rows: ${cancelledRows}`)
  await win.getByRole('button', { name: /Deny/ }).first().click().catch(() => {})
} catch (e) {
  check('unexpected error', false, e.message.split('\n')[0])
  await win.screenshot({ path: '/tmp/sb-queue-error.png' }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
