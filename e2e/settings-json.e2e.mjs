#!/usr/bin/env node
/**
 * Open settings as JSON, against the built app (npm run build:fast first):
 * Open writes settings.json and its schema; an edit on disk changes the
 * Settings page and names what it skipped, and a UI change then leaves it
 * alone until the save is clean; a change in the UI rewrites a clean file; a file that is not valid JSON applies nothing and is not rewritten.
 * The system editor is stubbed, so nothing opens on the desktop. Uses the
 * demo adapter and an isolated profile; temp dirs are removed on exit.
 */
import { _electron as electron } from 'playwright'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); scratch.push(dir); return dir }
process.on('exit', () => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

const userData = mk('sb-settings-json-ud-')
const file = join(userData, 'settings.json')
const readJson = () => JSON.parse(readFileSync(file, 'utf8'))

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
// No chat is open, so Open falls back to the system editor: record the call instead of opening one.
await app.evaluate(({ shell }) => {
  globalThis.__openedPaths = []
  shell.openPath = async (path) => { globalThis.__openedPaths.push(path); return '' }
})

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout
  for (;;) {
    try { if (await predicate()) return true } catch { /* the file may be mid-write */ }
    if (Date.now() > end) return false
    await new Promise((r) => setTimeout(r, 100))
  }
}

try {
  const settings = win.getByRole('dialog', { name: 'Settings' })
  const banner = settings.getByTestId('settings-file-banner')
  await win.getByTitle('Settings').waitFor({ state: 'visible', timeout: 20_000 })
  await win.getByTitle('Settings').click()
  await settings.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: /^About/ }).click()
  await settings.locator('[data-setting-row="about.settingsJson"]').getByRole('button', { name: 'Open' }).click()

  check('Open writes the file', await until(() => existsSync(file)))
  check('with the schema beside it', existsSync(join(userData, 'settings.schema.json')))
  const opened = await app.evaluate(() => globalThis.__openedPaths)
  check('and hands it to the system editor with no chat open', opened.length === 1 && opened[0] === file, JSON.stringify(opened))
  const initial = readJson()
  check('the file holds only changed values, and no secrets', initial.settings['analytics.enabled'] === false
    && initial.settings['tour.autoplay'] === false && !('analytics.noticeSeen' in initial.settings), JSON.stringify(initial.settings))

  // Edit on disk: a valid theme and follow-up, plus a shortcut refused on every platform (a bare letter types text).
  writeFileSync(file, JSON.stringify({
    ...initial,
    settings: { ...initial.settings, theme: 'light', 'chat.followUpDefault': 'queue' },
    keyboard: { 'app.search': ['A'] },
  }, null, 2))
  check('the theme applies from the file', await until(() => win.evaluate(() => document.documentElement.className === 'theme-light')))
  await settings.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: /^Appearance/ }).click()
  check('the Settings page shows it', await until(() => settings.getByRole('button', { name: 'Light', pressed: true }).isVisible()))
  await banner.waitFor({ timeout: 5000 })
  const bannerText = (await banner.textContent()) ?? ''
  check('the banner names the skipped shortcut', /keyboard\.app\.search/.test(bannerText), bannerText)
  await settings.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: /^Chat & agents/ }).click()
  check('the follow-up row changed', await until(() => settings.locator('[data-setting-row="chat.followUp"]').getByRole('button', { name: 'Queue', pressed: true }).isVisible()))

  // The file still asks for a shortcut it did not get, so a UI change leaves it alone.
  const refused = readFileSync(file, 'utf8')
  await settings.locator('[data-setting-row="chat.fileDiffs"]').getByRole('switch').click()
  check('a UI change does not erase a refused entry', await until(async () => /was not written/.test((await banner.textContent()) ?? '')))
  check('the file with the refused entry is untouched', readFileSync(file, 'utf8') === refused)

  // Once the save is clean, a change in the UI reaches the file.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(refused), keyboard: {} }, null, 2))
  await banner.waitFor({ state: 'hidden', timeout: 5000 })
  // The clean file leaves file diffs out, so the save put them back to the default (off).
  const diffs = settings.locator('[data-setting-row="chat.fileDiffs"]').getByRole('switch')
  check('the clean save resets a key it leaves out', await until(async () => (await diffs.getAttribute('aria-checked')) === 'false'))
  await diffs.click()
  check('a UI change rewrites the file', await until(() => readJson().settings['chat.showFileDiffs'] === true))
  check('keeping what the file set', readJson().settings.theme === 'light')

  // Invalid JSON: nothing applies, and the file is left alone.
  writeFileSync(file, '{ "settings": { "theme": ')
  check('the banner reports the parse error', await until(async () => /not applied/.test((await banner.textContent()) ?? '')))
  await settings.locator('[data-setting-row="chat.streaming"]').getByRole('switch').click()
  check('a UI change does not overwrite the broken file', await until(async () => /was not written/.test((await banner.textContent()) ?? '')))
  check('the broken file is untouched', readFileSync(file, 'utf8') === '{ "settings": { "theme": ')
  check('and the theme is still light', await win.evaluate(() => document.documentElement.className === 'theme-light'))
} finally {
  await app.close()
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
