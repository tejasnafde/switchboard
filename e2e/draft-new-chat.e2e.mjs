/**
 * Draft-first new chat, end to end against the built app (npm run build:fast):
 * cmd+shift+O picker, draft chips, no row before the first send, project
 * checkout, new worktree, existing worktree, a path the backend canonicalises,
 * and a failed worktree that gives the draft its text back. Uses the scripted
 * demo adapter and an isolated profile; temp dirs are removed on exit.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const repoRoot = new URL('..', import.meta.url).pathname
const scratch = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
process.on('exit', () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })

const userData = mk('sb-draft-ud-')
const rawProject = mk('sb-draft-proj-')
const project = realpathSync(rawProject)
const notGit = realpathSync(mk('sb-draft-nogit-'))
execFileSync('git', ['init', '-q', '-b', 'main', project])
writeFileSync(join(project, 'README.md'), 'hi\n')
execFileSync('git', ['-C', project, '-c', 'user.email=a@b', '-c', 'user.name=t', 'add', '.'])
execFileSync('git', ['-C', project, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'init'])
const db = join(userData, 'data', 'switchboard.db')
const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim()

async function launch() {
  const app = await electron.launch({
    args: ['.'], cwd: repoRoot, timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1', SHELL: '/bin/sh' },
  })
  const win = await app.firstWindow({ timeout: 20_000 })
  win.on('pageerror', (e) => console.error('pageerror', e.message))
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
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${project}', 'drafty', ${Date.now()}, 0);`)
// Same repo under the /var symlink: the backend canonicalises it to the drafty path.
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${rawProject}', 'aliased', ${Date.now()}, 1);`)
// Not a git repo: a worktree cannot be created, so the draft must come back.
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${notGit}', 'notgit', ${Date.now()}, 2);`)
;({ app, win } = await launch())

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }

async function run(checkout) {
  const before = Number(q('SELECT count(*) FROM conversations;'))
  await win.locator('body').click({ position: { x: 900, y: 400 } })
  await win.keyboard.press('Meta+Shift+O')
  const picker = win.getByTestId('new-chat-project-picker')
  await picker.waitFor({ timeout: 5000 })
  check(`${checkout}: picker opens on cmd+shift+O`, true)
  await picker.getByRole('option').first().waitFor({ timeout: 5000 })
  await win.keyboard.press('Enter')
  await win.getByTestId('draft-workspace').waitFor({ timeout: 5000 })
  check(`${checkout}: draft opens with workspace chip`, true)
  await win.getByTestId('draft-workspace').selectOption(checkout)
  await win.waitForTimeout(300)
  check(`${checkout}: no conversation row while drafting`, Number(q('SELECT count(*) FROM conversations;')) === before)
  await win.screenshot({ path: `/tmp/sb-draft-${checkout}-before.png` })
  const editor = win.locator('[contenteditable="true"]').last()
  await editor.click()
  await win.keyboard.type(`hello from a ${checkout} draft`)
  await win.keyboard.press('Enter')
  await win.waitForFunction(() => !document.querySelector('[data-testid="draft-workspace"]'), null, { timeout: 45_000 })
  check(`${checkout}: draft chips gone after send`, true)
  await win.getByText(`hello from a ${checkout} draft`).first().waitFor({ timeout: 20_000 })
  check(`${checkout}: first message is in the new chat`, true)
  const after = Number(q('SELECT count(*) FROM conversations;'))
  check(`${checkout}: exactly one conversation row created`, after === before + 1, `${before} -> ${after}`)
  const stored = win.evaluate(() => window.__sbStores?.agent?.getState?.().sessions.filter((s) => s.id.startsWith('draft:')).length)
  const drafts = await stored.catch(() => 'n/a')
  check(`${checkout}: draft session removed from store`, drafts === 0 || drafts === 'n/a' || drafts === undefined, String(drafts))
  if (checkout === 'worktree') {
    const wt = q(`SELECT worktree_path FROM conversations ORDER BY created_at DESC LIMIT 1;`)
    check('worktree: conversation has a worktree path', wt.length > 0, wt)
  }
  await win.waitForTimeout(1500)
  await win.screenshot({ path: `/tmp/sb-draft-${checkout}-after.png` })
}

try {
  await run('project')
  await run('worktree')
  async function draftIn(filter, checkout, text) {
    await win.locator('body').click({ position: { x: 900, y: 400 } })
    await win.keyboard.press('Meta+Shift+O')
    const picker = win.getByTestId('new-chat-project-picker')
    await picker.getByRole('option').first().waitFor({ timeout: 5000 })
    await win.keyboard.type(filter)
    await win.keyboard.press('Enter')
    await win.getByTestId('draft-workspace').waitFor({ timeout: 5000 })
    await win.getByTestId('draft-workspace').selectOption(checkout)
    await win.locator('[contenteditable="true"]').last().click()
    await win.keyboard.type(text)
    await win.keyboard.press('Enter')
  }
  // Existing worktree: join the one the worktree run created, create no new one.
  const existingPath = q(`SELECT worktree_path FROM conversations WHERE worktree_path IS NOT NULL ORDER BY created_at DESC LIMIT 1;`)
  const worktreesBefore = execFileSync('git', ['-C', project, 'worktree', 'list']).toString().trim().split('\n').length
  await win.locator('body').click({ position: { x: 900, y: 400 } })
  await win.keyboard.press('Meta+Shift+O')
  await win.getByTestId('new-chat-project-picker').getByRole('option').first().waitFor({ timeout: 5000 })
  await win.keyboard.type('drafty')
  await win.keyboard.press('Enter')
  await win.getByTestId('draft-workspace').waitFor({ timeout: 5000 })
  await win.getByTestId('draft-workspace').selectOption('existing')
  await win.getByTestId('draft-existing-worktree').waitFor({ timeout: 5000 })
  check('existing: worktree picker offers the worktree on disk', (await win.getByTestId('draft-existing-worktree').locator('option').count()) >= 1)
  await win.locator('[contenteditable="true"]').last().click()
  await win.keyboard.type('join the existing worktree')
  await win.keyboard.press('Enter')
  await win.getByText('join the existing worktree').first().waitFor({ timeout: 20_000 })
  const joined = q(`SELECT worktree_path FROM conversations ORDER BY created_at DESC LIMIT 1;`)
  check('existing: new chat runs in the existing worktree', realpathSync(joined) === realpathSync(existingPath), `${joined}`)
  const worktreesAfter = execFileSync('git', ['-C', project, 'worktree', 'list']).toString().trim().split('\n').length
  check('existing: no new worktree created', worktreesAfter === worktreesBefore, `${worktreesBefore} -> ${worktreesAfter}`)

  // Regression: the backend canonicalises the aliased path; the message must still arrive.
  const beforeAlias = Number(q('SELECT count(*) FROM conversations;'))
  await draftIn('aliased', 'project', 'aliased path message')
  await win.getByText('aliased path message').first().waitFor({ timeout: 20_000 }).then(() => true, () => false)
    .then((ok) => check('aliased: first message arrives despite a canonicalised path', ok))
  check('aliased: one conversation row', Number(q('SELECT count(*) FROM conversations;')) === beforeAlias + 1)
  // Failure: no worktree possible outside git; the draft and its text come back.
  const beforeFail = Number(q('SELECT count(*) FROM conversations;'))
  await draftIn('notgit', 'worktree', 'this text must survive')
  await win.waitForTimeout(6000)
  check('failure: draft chips still shown', await win.getByTestId('draft-workspace').count() === 1)
  check('failure: draft text restored', (await win.locator('[contenteditable="true"]').last().innerText()).includes('this text must survive'))
  check('failure: no conversation row left behind', Number(q('SELECT count(*) FROM conversations;')) === beforeFail)
  await win.screenshot({ path: '/tmp/sb-draft-failure.png' })
} catch (e) {
  check('unexpected error', false, `after [${results.at(-1)?.name ?? 'start'}]: ${e.message.split('\n')[0]}`)
  await win.screenshot({ path: '/tmp/sb-draft-error.png' }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
const failed = results.filter((r) => !r.ok)
console.log(failed.length ? `FAILED ${failed.length}` : 'ALL PASS')
process.exit(failed.length ? 1 : 0)
