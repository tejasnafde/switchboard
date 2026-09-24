/**
 * A finished turn's tool row and "Changed N files" group survive reopening
 * the thread, against the built app (npm run build:fast) with the demo
 * adapter and an isolated profile.
 *
 * The demo "state check" turn runs one Edit that really changes
 * src/api/auth.ts in a git repo, so the registry's checkpoint emits a
 * genuine file.edited. The chat is then reopened twice: a switch away and
 * back (the idle chat is evicted and reloaded from history) and a full app
 * restart. Both run once with a Claude-shaped transcript on disk and once
 * with SQLite as the only history, which is what OpenCode (and any provider
 * whose transcript is gone) reloads from. Takes ~60s. Temp dirs are removed.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
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

function makeRepo(cwd) {
  mkdirSync(join(cwd, 'src', 'api'), { recursive: true })
  writeFileSync(join(cwd, 'src', 'api', 'auth.ts'), 'export async function exchangeCode(code: string) {\n  return code\n}\n')
  const identity = ['-c', 'user.email=e2e@switchboard.local', '-c', 'user.name=e2e']
  execFileSync('git', ['init', '-q'], { cwd })
  execFileSync('git', [...identity, 'add', '.'], { cwd })
  execFileSync('git', [...identity, 'commit', '-qm', 'init'], { cwd })
}

async function scenario(mode) {
  const userData = mk('sb-toolrow-ud-')
  const project = realpathSync(mk('sb-toolrow-proj-'))
  const claudeDir = mode === 'transcript' ? realpathSync(mk('sb-toolrow-claude-')) : null
  makeRepo(project)
  const db = join(userData, 'data', 'switchboard.db')
  const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim()

  async function launch() {
    const app = await electron.launch({ args: ['.'], cwd: repoRoot, timeout: 30_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1',
        ...(claudeDir ? { SB_DEMO_CLAUDE_TRANSCRIPT_DIR: claudeDir } : {}), SHELL: '/bin/sh' } })
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
  q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${project}', 'toolrow', ${Date.now()}, 0);`)
  if (claudeDir) {
    // History scans every enabled oauth_dir, so this is where it finds the transcript.
    q(`INSERT OR REPLACE INTO provider_instances (id, agent_type, display_name, auth_mode, oauth_dir, enabled)
       VALUES ('claude-code-e2e', 'claude-code', 'e2e', 'oauth_dir', '${claudeDir}', 1);`)
  }
  ;({ app, win } = await launch())

  /** Tool and changed-files summaries in the focused chat, in DOM order. */
  const summaries = () => win.evaluate(() => {
    const panel = document.querySelector('[data-chat-panel]')
    if (!panel) return ''
    return [...panel.querySelectorAll('.turn-activity > summary, .turn-files-toggle, .turn-files > header')]
      .map((el) => el.textContent.replace(/ · .*$/, '').trim())
      .join(',')
  })
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
  const expected = 'Used 1 tool,Changed 1 file'
  const settle = async () => {
    await win.getByText('Review the diff below').first().waitFor({ timeout: 10_000 })
    const until = Date.now() + 5000
    while ((await summaries()) !== expected && Date.now() < until) await win.waitForTimeout(250)
    return summaries()
  }

  try {
    await newChat('fix the state check')
    await replied('Done. The callback', 30_000)
    const live = await settle()
    check(`[${mode}] the live turn shows its tool row and changed files`, live === expected, live)

    await newChat('hello there')
    await replied('Two focused tests', 30_000)
    // A -> B evicts A's messages (idle), B -> A reloads them from history.
    await open('fix the state check')
    await open('hello there')
    await open('fix the state check')
    const switched = await settle()
    check(`[${mode}] after switching away and back, both rows are still there`, switched === expected, switched)

    await app.close()
    ;({ app, win } = await launch())
    await open('fix the state check')
    const restarted = await settle()
    check(`[${mode}] after a restart, both rows are still there`, restarted === expected, restarted)
  } catch (e) {
    check(`[${mode}] unexpected error`, false, e.message.split('\n')[0])
    await win.screenshot({ path: join(tmpdir(), `sb-toolrow-error-${mode}.png`) }).catch(() => {})
  } finally {
    await app.close().catch(() => {})
  }
}

await scenario('transcript')
await scenario('sqlite')
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
