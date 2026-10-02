#!/usr/bin/env node
/**
 * Project scopes in Settings, against the built app (npm run build:fast
 * first): a new chat opened right after launch already starts in its
 * project's stored override (the renderer's cache is cold then); then pick
 * a project in the Chat & agents Scope combobox, override its runtime mode,
 * check a new chat in that project starts in it and a new chat
 * in another project does not, check the Projects page counts it and its
 * Open returns to that scope, then Reset. Uses the demo adapter and an
 * isolated profile; temp dirs are removed on exit.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openLandingProjectPicker } from './lib/new-chat.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); scratch.push(dir); return dir }
process.on('exit', () => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

const userData = mk('sb-scopes-ud-')
const alpha = realpathSync(mk('sb-scopes-alpha-'))
const beta = realpathSync(mk('sb-scopes-beta-'))
const gamma = realpathSync(mk('sb-scopes-gamma-'))
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
  return { app, win }
}

let { app, win } = await launch()
await app.close()
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${alpha}', 'alpha', ${Date.now()}, 0);`)
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${beta}', 'beta', ${Date.now()}, 1);`)
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${gamma}', 'gamma', ${Date.now()}, 2);`)
// An override from an earlier run. The tmp paths are already real, so each is its own pathKey on macOS.
q(`INSERT OR REPLACE INTO settings (key, value) VALUES ('project:${gamma}:chat.defaultRuntimeMode', 'full-access');`)
;({ app, win } = await launch())

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
const overrideRow = () => q(`SELECT value FROM settings WHERE key = 'project:${alpha}:chat.defaultRuntimeMode';`)

try {
  const settings = win.getByRole('dialog', { name: 'Settings' })
  const runtimeRow = settings.locator('[data-setting-row="chat.runtimeMode"]')

  async function openChatPage() {
    await win.getByTitle('Settings').click()
    await settings.getByRole('button', { name: /^Chat & agents/ }).click()
  }
  async function pickScope(name) {
    await settings.getByRole('combobox', { name: 'Scope' }).click()
    await win.getByRole('option', { name: new RegExp(`^${name}`) }).click()
  }
  async function closeSettings() {
    await win.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
  }
  async function newChatMode(projectName) {
    await win.locator('body').click({ position: { x: 900, y: 400 } })
    await openLandingProjectPicker(win)
    await win.keyboard.type(projectName)
    await win.keyboard.press('Enter')
    await win.getByTestId('draft-workspace').waitFor({ timeout: 5000 })
    const composer = win.locator('.chat-composer:visible').last()
    return composer.getAttribute('data-runtime-mode')
  }

  // First thing after launch, before anything else reads the overrides.
  const first = await newChatMode('gamma')
  check('the first new chat after launch starts in the stored override', first === 'full-access', String(first))

  await win.getByTitle('Settings').waitFor({ state: 'visible', timeout: 20_000 })
  await openChatPage()
  await pickScope('alpha')
  check('the scope note names the project', await settings.getByTestId('settings-scope-note').getByText('alpha').isVisible())
  check('a row that is not scopable is disabled with its reason',
    await settings.locator('[data-setting-row="chat.streaming"]').getByText('Applies to all projects.').isVisible())

  await runtimeRow.getByRole('combobox', { name: 'Runtime mode' }).click()
  await win.getByRole('option', { name: 'Plan' }).click()
  await runtimeRow.getByText('Overridden').waitFor({ timeout: 3000 })
  check('the row shows Overridden', true)
  check('the override is stored for the project', overrideRow() === 'plan', overrideRow())
  check('the global default is untouched', q(`SELECT count(*) FROM settings WHERE key = 'chat.defaultRuntimeMode' AND value = 'plan';`) === '0')

  await pickScope('All projects')
  check('All projects shows no override marker', !(await runtimeRow.getByText('Overridden').isVisible()))
  await closeSettings()

  check('a new chat in the project uses the override', (await newChatMode('alpha')) === 'plan')
  const other = await newChatMode('beta')
  check('a new chat in another project does not', other !== 'plan', String(other))

  await openChatPage()
  await settings.getByRole('button', { name: /^Projects/ }).click()
  const alphaRow = settings.locator(`[data-project-row="${alpha}"]`)
  check('the Projects page counts the override', /1 override/.test((await alphaRow.textContent()) ?? ''), (await alphaRow.textContent()) ?? '')
  await alphaRow.getByRole('button', { name: 'Open alpha overrides' }).click()
  check('Open shows that project\'s scope', await settings.getByTestId('settings-scope-note').getByText('alpha').isVisible())

  await runtimeRow.getByRole('button', { name: 'Reset Runtime mode override' }).click()
  await runtimeRow.getByText('Overridden').waitFor({ state: 'hidden', timeout: 3000 })
  check('Reset removes the override', overrideRow() === '', overrideRow())
  await closeSettings()
} finally {
  await app.close()
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
