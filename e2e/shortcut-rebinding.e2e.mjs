#!/usr/bin/env node
/**
 * Rebinding a shortcut in Settings > Keyboard, against the built app
 * (npm run build:fast first): record a new chord for the command palette,
 * check the new chord opens it and the old one no longer does, that a
 * reserved chord is refused with its reason, then Reset back to the default.
 * Temp dirs are removed on exit.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const userData = mkdtempSync(join(tmpdir(), 'sb-rebind-ud-'))
process.on('exit', () => rmSync(userData, { recursive: true, force: true }))

const app = await electron.launch({
  args: ['.'], cwd: repoRoot, timeout: 30_000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1', SHELL: '/bin/sh' },
})
const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }

try {
  const win = await app.firstWindow({ timeout: 20_000 })
  win.on('pageerror', (e) => console.error('pageerror', e.message))
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  await win.evaluate(() => Promise.all([
    window.api.settings.set('tour.autoplay', 'false'),
    window.api.settings.set('analytics.noticeSeen', 'true'),
  ]))
  await win.reload()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const palette = win.getByRole('dialog', { name: /command palette/i })
  const paletteOpens = async (keys) => {
    await win.keyboard.press(keys)
    const open = await palette.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false)
    if (open) {
      await win.keyboard.press('Escape')
      await palette.waitFor({ state: 'hidden' })
    }
    return open
  }

  await win.getByTitle('Settings').waitFor({ state: 'visible', timeout: 20_000 })
  check('default chord opens the palette', await paletteOpens(`${mod}+Shift+P`))

  await win.getByTitle('Settings').click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.getByRole('button', { name: /^Keyboard/ }).click()
  const row = settings.locator('[data-setting-row="keyboard.app.command-palette"]')
  const recorder = row.getByRole('button', { name: 'Change the shortcut for Command palette' })

  await recorder.click()
  check('recorder asks for the keys', (await recorder.textContent()) === 'Press the new shortcut')
  await win.keyboard.press(`${mod}+C`)
  const alert = row.getByRole('alert')
  check('a reserved chord is refused with the reason', /copy|interrupts/.test((await alert.textContent()) ?? ''))
  await win.keyboard.press(`${mod}+B`)
  check('a clashing chord names the other command', /Toggle sidebar/.test((await alert.textContent()) ?? ''))
  await win.keyboard.press(`${mod}+Shift+Y`)
  check('the row shows Changed', await row.getByText('Changed').waitFor({ timeout: 3000 }).then(() => true, () => false))
  check('the recorder shows the new keys', (await recorder.textContent()) !== 'Press the new shortcut')

  await win.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  check('the new chord opens the palette', await paletteOpens(`${mod}+Shift+Y`))
  check('the old chord no longer does', !(await paletteOpens(`${mod}+Shift+P`)))

  await win.getByTitle('Settings').click()
  await settings.getByRole('button', { name: /^Keyboard/ }).click()
  await row.getByRole('button', { name: 'Reset Command palette' }).click()
  await row.getByText('Changed').waitFor({ state: 'hidden', timeout: 3000 })
  const stored = await win.evaluate(() => window.api.settings.get('keyboard.overrides'))
  check('reset drops the stored override', stored === '{}', String(stored))
  await win.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  check('after reset the default chord opens the palette again', await paletteOpens(`${mod}+Shift+P`))

  // The main process rebuilds the app menu when the stored value changes.
  const settingsAccelerator = () => app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items[0]?.submenu?.items.find((i) => i.label === 'Settings')?.accelerator ?? null)
  await win.evaluate(() => window.api.settings.set('keyboard.overrides', JSON.stringify({ 'app.settings': ['Mod+Shift+.'] })))
  check('a menu accelerator follows the override', (await settingsAccelerator()) === 'CmdOrCtrl+Shift+.', String(await settingsAccelerator()))
  await win.evaluate(() => window.api.settings.set('keyboard.overrides', '{}'))
  check('and goes back on reset', (await settingsAccelerator()) === 'CmdOrCtrl+,')
} finally {
  await app.close()
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`)
process.exit(failed ? 1 : 0)
