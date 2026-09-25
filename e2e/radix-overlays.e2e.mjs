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
// Radix attaches its outside-pointer listener a task after the layer mounts;
// a click that lands sooner than a person could click is not "outside" yet.
const clickOutside = async (x, y) => { await win.waitForTimeout(100); await win.mouse.click(x, y) }
const composerHasFocus = () => focusSettlesOn(`document.activeElement?.getAttribute('aria-label') === 'Chat message'`)
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
  await win.keyboard.press('Escape')
  check('provider picker: Escape leaves the custom model field, not the picker',
    await picker.isVisible() && await picker.getByPlaceholder('provider/model-id').count() === 0)
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

async function commandPalette() {
  const editor = win.locator('.chat-composer [aria-label="Chat message"]').first()
  await editor.click()
  await win.keyboard.press('Meta+Shift+P')
  const palette = win.getByRole('dialog', { name: 'Command Palette' })
  await palette.waitFor({ state: 'visible' })
  check('palette: input has focus', (await focused())?.placeholder === 'Type a command...')
  await win.keyboard.type('toggle sideb')
  check('palette: fuzzy filter keeps the match selected',
    await palette.locator('[cmdk-item][data-selected="true"]').textContent().then((t) => t?.includes('Toggle Sidebar')))
  await win.keyboard.press('Escape')
  check('palette: Escape closes it', await hidden(palette))
  check('palette: focus returns to the composer', await focusSettlesOn(`document.activeElement?.getAttribute('aria-label') === 'Chat message'`))

  await win.keyboard.press('Meta+Shift+P')
  await palette.waitFor({ state: 'visible' })
  await win.keyboard.press('Meta+Shift+P')
  check('palette: its shortcut toggles it closed', await hidden(palette))

  for (let i = 0; i < 2; i++) {
    await win.keyboard.press('Meta+Shift+P')
    await palette.waitFor({ state: 'visible' })
    await win.keyboard.type('toggle terminal')
    await win.keyboard.press('Enter')
    await hidden(palette)
  }
  check('palette: focus returns to the composer after a command that opens nothing', await composerHasFocus())

  await win.keyboard.press('Meta+Shift+P')
  await palette.waitFor({ state: 'visible' })
  await win.keyboard.type('open settings')
  await win.keyboard.press('Enter')
  const settings = win.locator('.settings-page')
  await settings.waitFor({ state: 'visible' })
  check('palette: a command that opens Settings does not pull focus back to the composer',
    await win.waitForTimeout(300).then(() => win.evaluate(() => document.activeElement?.getAttribute('aria-label') !== 'Chat message')))
  await win.keyboard.press('Escape')
  check('palette: Escape then closes Settings', await hidden(settings))
  check('palette: closing Settings opened from it returns focus to the composer', await composerHasFocus())
}

async function sessionPicker() {
  // Open beside offers only chats that are already loaded.
  await openConversation('Compare retry strategies')
  await openConversation('Debug auth callback')
  const primary = win.locator('[data-chat-panel]').first()
  const openBeside = primary.getByRole('button', { name: 'Open beside' })
  await openBeside.click()
  const picker = win.getByRole('dialog', { name: 'Open a loaded chat beside this one' })
  await picker.waitFor({ state: 'visible' })
  const rows = picker.getByRole('button')
  check('session picker: lists the other loaded chat', await rows.filter({ hasText: 'Compare retry strategies' }).count() === 1)
  await win.keyboard.press('Escape')
  check('session picker: Escape closes it', await hidden(picker))
  check('session picker: focus returns to Open beside', await focusSettlesOn(`document.activeElement?.textContent?.includes('Open beside') || document.activeElement?.getAttribute('aria-label') === 'Open beside'`))

  await openBeside.click()
  await picker.waitFor({ state: 'visible' })
  check('session picker: the dialog, not a row, has focus', await win.evaluate(() => document.activeElement?.getAttribute('role') === 'dialog'))
  await win.keyboard.press('ArrowDown')
  await win.keyboard.press('ArrowUp')
  await win.keyboard.press(' ')
  check('session picker: Space picks the highlighted chat', await hidden(picker))
  check('session picker: the pick opens beside', await win.locator('.chat-identity-title').filter({ hasText: 'Compare retry strategies' }).first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))
}

async function searchModal() {
  await win.locator('.chat-composer [aria-label="Chat message"]').first().click()
  await win.keyboard.press('Meta+Shift+F')
  const search = win.getByRole('dialog', { name: 'Search across all conversations' })
  await search.waitFor({ state: 'visible' })
  check('search: input has focus', (await focused())?.placeholder === 'Search across all conversations...')
  await win.keyboard.type('retry')
  const hit = search.locator('.cmdk-item').first()
  check('search: finds a message', await hit.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))
  await win.keyboard.press('Escape')
  check('search: Escape closes it', await hidden(search))
  check('search: focus returns to the composer', await composerHasFocus())
  await win.keyboard.press('Meta+Shift+F')
  await search.waitFor({ state: 'visible' })
  await win.keyboard.type('backoff with jitter')
  await search.locator('.cmdk-item').first().click()
  check('search: a hit opens its chat', await win.locator('.chat-identity-title').filter({ hasText: 'Compare retry strategies' }).first()
    .waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false))
  check('search: a hit closes it', await hidden(search))
}

async function quickPrompt() {
  await win.locator('.chat-composer [aria-label="Chat message"]').first().click()
  await win.keyboard.press('Meta+K')
  const prompt = win.getByRole('dialog', { name: 'Quick prompt' })
  await prompt.waitFor({ state: 'visible' })
  check('quick prompt: textarea has focus', await win.evaluate(() => document.activeElement?.tagName === 'TEXTAREA'))
  await win.keyboard.press('Escape')
  check('quick prompt: Escape closes it', await hidden(prompt))
  check('quick prompt: focus returns to the composer', await composerHasFocus())
  await win.keyboard.press('Meta+K')
  await prompt.waitFor({ state: 'visible' })
  await clickOutside(8, 400)
  check('quick prompt: an outside click closes it', await hidden(prompt))
}

async function kanbanModals() {
  await win.getByRole('button', { name: 'Board', exact: true }).click()
  await win.getByText('Trace webhook retries', { exact: true }).first().click()
  const card = win.getByRole('dialog', { name: 'Edit card' })
  await card.waitFor({ state: 'visible' })
  check('card: title has focus', (await focused())?.placeholder === 'What needs doing?')
  const surface = await card.evaluate((el) => getComputedStyle(el).backgroundColor)
  check('card: surface is opaque', !/rgba\(.*, 0\)$/.test(surface) && surface !== 'transparent', surface)

  // Cancelling this confirm changes nothing, so it is safe to open.
  await card.getByRole('button', { name: 'Detach', exact: true }).dispatchEvent('click')
  const confirmDialog = win.getByRole('alertdialog', { name: 'Delete this worktree?' })
  await confirmDialog.waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  check('card: Escape answers only the confirm on top', await hidden(confirmDialog) && await card.isVisible())

  await win.keyboard.press('Escape')
  check('card: Escape closes it', await hidden(card))

  await win.getByText('Choose empty-state copy', { exact: true }).first().click()
  await card.waitFor({ state: 'visible' })
  await win.keyboard.press('Meta+A')
  await win.keyboard.type('Pick the empty-state copy')
  await win.keyboard.press('Meta+Enter')
  check('card: Cmd+Enter saves and closes it', await hidden(card))
  check('card: the saved title shows on the board', await win.getByText('Pick the empty-state copy', { exact: true }).first()
    .waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false))

  await win.getByTitle(/^Create card/).click()
  const newCard = win.getByRole('dialog', { name: 'New card' })
  await newCard.waitFor({ state: 'visible' })
  await clickOutside(8, 400)
  check('card: an outside click closes it', await hidden(newCard))

  await win.locator('select[title="Filter by project"]').selectOption({ label: 'acme-console' })
  await win.getByTitle('Manage git worktrees for this project').click()
  const worktrees = win.getByRole('dialog', { name: /^Worktrees - / })
  await worktrees.waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  check('worktrees: Escape closes it', await hidden(worktrees))
  check('worktrees: focus returns to its button', await focusIsTrigger('Manage git worktrees'))
  await win.locator('select[title="Filter by project"]').selectOption({ index: 0 })
  await win.getByRole('button', { name: 'Chats', exact: true }).click()
}

async function workspaceOrganizer() {
  const opener = win.getByRole('button', { name: 'Organize workspaces and projects' })
  await opener.click()
  const organizer = win.getByRole('dialog', { name: 'Organize sidebar' })
  await organizer.waitFor({ state: 'visible' })
  check('organizer: the selected workspace has focus',
    await focusSettlesOn(`!!document.activeElement?.closest('.workspace-organizer-nav-row[data-selected], .workspace-organizer-ungrouped[data-selected]')`))
  await organizer.getByRole('button', { name: 'New', exact: true }).click()
  check('organizer: New focuses the name field', await focusSettlesOn(`document.activeElement?.getAttribute('name') === 'workspace-name'`))
  await win.keyboard.press('Escape')
  check('organizer: Escape backs out of the name field first',
    await organizer.getByLabel('Workspace name').waitFor({ state: 'hidden', timeout: 2000 }).then(() => true, () => false) && await organizer.isVisible())
  await win.keyboard.press('Tab')
  check('organizer: Tab stays inside it', await win.evaluate(() => !!document.activeElement?.closest('.workspace-organizer')))
  await win.keyboard.press('Escape')
  check('organizer: Escape then closes it', await hidden(organizer))
  check('organizer: focus returns to its button', await focusSettlesOn(`document.activeElement?.getAttribute('aria-label') === 'Organize workspaces and projects'`))
}

async function settingsDialog() {
  const opener = win.getByTitle('Settings')
  await opener.click()
  const settings = win.getByRole('dialog', { name: 'Settings' })
  await settings.waitFor({ state: 'visible' })
  check('settings: focus moves into its search', await focusSettlesOn(`document.activeElement?.getAttribute('aria-label') === 'Search settings'`))
  // Search opens the row's page with the row highlighted and focused.
  await win.keyboard.type('steer')
  await settings.getByRole('heading', { name: /results? for "steer"/ }).waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  check('settings: Escape clears a search, not Settings',
    await settings.isVisible() && await settings.getByLabel('Search settings').inputValue() === '')
  await win.keyboard.type('steer')
  await win.keyboard.press('Enter')
  check('settings: a search result opens its page',
    await settings.getByRole('button', { name: /^Chat & agents/ }).getAttribute('aria-current') === 'page')
  check('settings: the result row is highlighted and focused',
    await focusSettlesOn(`!!document.activeElement?.closest('[data-setting-row="chat.followUp"]')`))
  // A changed row puts Reset before its control; focus must skip Reset,
  // or the next Enter would undo the setting.
  await settings.getByRole('button', { name: 'Queue', exact: true }).click()
  await settings.getByLabel('Search settings').fill('steer')
  await win.keyboard.press('Enter')
  check('settings: a changed result row focuses its control, not Reset',
    await focusSettlesOn(`document.activeElement?.getAttribute('aria-pressed') !== null && !!document.activeElement.closest('[data-setting-row="chat.followUp"][data-changed]')`))
  await settings.getByRole('button', { name: 'Reset Follow-up while the agent works' }).click()
  check('settings: Reset puts the default back',
    await settings.getByRole('button', { name: 'Steer', exact: true }).getAttribute('aria-pressed') === 'true')
  await settings.getByRole('button', { name: 'Projects', exact: true }).click()
  await settings.getByRole('button', { name: '+ new launch config' }).click()
  await settings.getByPlaceholder('launch config name').waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  check('settings: Escape cancels a launch-config name field, not Settings',
    await settings.getByPlaceholder('launch config name').count() === 0 && await settings.isVisible())
  // The provider editor sits inside Settings; Escape closes only the editor.
  await settings.getByRole('button', { name: /^Accounts & models/ }).click()
  await settings.getByRole('button', { name: '+ Add account' }).click()
  await win.getByRole('button', { name: 'Claude Code', exact: true }).click()
  const editor = settings.getByText(/^New account - /)
  await editor.waitFor({ state: 'visible' })
  await win.keyboard.press('Escape')
  check('settings: Escape closes the provider editor, not Settings',
    await editor.waitFor({ state: 'hidden', timeout: 2000 }).then(() => true, () => false) && await settings.isVisible())
  for (let i = 0; i < 12; i++) await win.keyboard.press('Tab')
  check('settings: Tab stays inside it', await win.evaluate(() => !!document.activeElement?.closest('.settings-page')))
  await win.keyboard.press('Escape')
  check('settings: Escape closes it', await hidden(settings))
  check('settings: focus returns to its button', await focusIsTrigger('Settings'))
  await opener.click()
  await settings.waitFor({ state: 'visible' })
  await settings.getByRole('button', { name: 'Back', exact: true }).click()
  check('settings: Back closes it', await hidden(settings))
  check('settings: Back returns focus to its button', await focusIsTrigger('Settings'))
}

await openConversation('Debug auth callback')
await providerPicker()
await branchPicker()
await commandPalette()
await sessionPicker()
await searchModal()
await quickPrompt()
await kanbanModals()
await workspaceOrganizer()
await settingsDialog()

await app.close()
const failed = results.filter((ok) => !ok).length
console.log(failed ? `E2E FAILED - ${failed} check(s)` : `E2E PASSED - ${results.length} checks`)
process.exit(failed ? 1 : 0)
