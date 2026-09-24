#!/usr/bin/env node
/**
 * The overlays that moved onto Radix keep their keyboard contract, against the
 * built app (npm run build:fast first) on the seeded tour workspace with the
 * scripted demo provider: where focus lands on open, that Escape closes only
 * the top overlay, that focus returns on close, and the list keys each one
 * had before. Temp dirs are removed on exit.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeDemoRepo, makeSideRepo, seedDatabase } from './fixtures/demo-workspace.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (prefix) => { const dir = mkdtempSync(join(tmpdir(), prefix)); scratch.push(dir); return dir }
process.on('exit', () => { for (const dir of scratch) rmSync(dir, { recursive: true, force: true }) })

const userData = mk('sb-overlays-ud-')
const projectRoot = mk('sb-overlays-proj-')
const projectPath = join(projectRoot, 'acme-console')
const sidePath = join(projectRoot, 'notes-cli')
makeDemoRepo(projectPath)
makeSideRepo(sidePath)

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
seedDatabase(join(userData, 'data', 'switchboard.db'), projectPath, sidePath)
;({ app, win } = await launch())

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
const focused = () => win.evaluate(() => {
  const el = document.activeElement
  return el ? { tag: el.tagName, title: el.getAttribute('title'), placeholder: el.getAttribute('placeholder') } : null
})
// Radix restores focus a task after the overlay unmounts, so poll for it.
const focusSettlesOn = (predicate) => win.waitForFunction(predicate, null, { timeout: 2000 }).then(() => true, () => false)
const focusIsTrigger = (title) => focusSettlesOn(`document.activeElement?.getAttribute('title')?.includes(${JSON.stringify(title)})`)
const hidden = async (locator) => locator.waitFor({ state: 'hidden', timeout: 3000 }).then(() => true, () => false)

async function openConversation(title) {
  await win.locator('.sidebar-recent-row').filter({ hasText: title }).first().click()
  await win.locator('.chat-identity-title').filter({ hasText: title }).waitFor({ state: 'visible' })
}

async function providerPicker() {
  const trigger = win.locator('.chat-composer button[title*="Claude"]').first()
  await trigger.click()
  const picker = win.getByRole('dialog', { name: 'Provider, instance, and model picker' })
  await picker.waitFor({ state: 'visible' })
  check('provider picker: model search has focus', (await focused())?.placeholder === 'Search models...')
  const pickerBox = await picker.boundingBox()
  const triggerBox = await trigger.boundingBox()
  check('provider picker: opens upward', !!pickerBox && !!triggerBox && pickerBox.y + pickerBox.height <= triggerBox.y)
  await win.keyboard.type('no-such-model')
  check('provider picker: search filters', await picker.getByText('No matches.').isVisible())
  await win.keyboard.press('Escape')
  check('provider picker: Escape closes it', await hidden(picker))
  check('provider picker: focus returns to the trigger', await focusIsTrigger('Claude'))

  await trigger.click()
  await picker.waitFor({ state: 'visible' })
  await picker.getByRole('button').filter({ hasText: /^Custom model id/ }).click()
  await win.keyboard.type('acme/model-x')
  await win.keyboard.press('Enter')
  check('provider picker: custom model id closes it', await hidden(picker))
  check('provider picker: custom model id is shown', (await trigger.getAttribute('title'))?.includes('acme/model-x') ?? false)
  await trigger.click()
  await picker.getByRole('button').filter({ hasText: /^Default/ }).first().click()
  await hidden(picker)

  await trigger.click()
  await picker.waitFor({ state: 'visible' })
  await win.locator('.chat-identity-title').click()
  check('provider picker: an outside click closes it', await hidden(picker))
}

async function branchPicker() {
  const trigger = win.locator('button[title="Switch branch"]').first()
  await trigger.click()
  const popover = win.getByRole('dialog', { name: 'Switch branch' })
  await popover.waitFor({ state: 'visible' })
  check('branch picker: search has focus', (await focused())?.placeholder === 'Search branches…')
  const options = popover.getByRole('option')
  await options.first().waitFor({ state: 'visible' })
  const count = await options.count()
  check('branch picker: lists branches', count > 0, `(${count})`)
  check('branch picker: first row highlighted', await options.first().getAttribute('aria-selected') === 'true')
  if (count > 1) {
    await win.keyboard.press('ArrowDown')
    check('branch picker: ArrowDown moves the highlight', await options.nth(1).getAttribute('aria-selected') === 'true')
  }
  await win.keyboard.type('no-such-branch')
  check('branch picker: search filters', await popover.getByText('No branches match').isVisible())
  await win.keyboard.press('Escape')
  check('branch picker: Escape closes it', await hidden(popover))
  check('branch picker: focus returns to the trigger', await focusIsTrigger('Switch branch'))
}

await openConversation('Debug auth callback')
await providerPicker()
await branchPicker()

await app.close()
const failed = results.filter((ok) => !ok).length
console.log(failed ? `E2E FAILED - ${failed} check(s)` : `E2E PASSED - ${results.length} checks`)
process.exit(failed ? 1 : 0)
