/**
 * Reviews to chat, against the built app (npm run build:fast) with the demo
 * adapter and an isolated profile. The demo chat "Debug auth callback" is
 * linked to the demo PR #612: the chat header shows it, "Ask the agent" on
 * the failed check and "Send all 3 open conversations" each land as ONE
 * review pill in that chat's composer, and sending one expands it into the
 * provider text while the stored display body keeps the token. Unlinking
 * from the Overview card removes the header control. Temp dirs are removed.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeDemoRepo, makeSideRepo, seedDatabase } from './fixtures/demo-workspace.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
process.on('exit', () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })
const userData = mk('sb-review-chat-ud-')
const project = realpathSync(mk('sb-review-chat-proj-'))
const side = realpathSync(mk('sb-review-chat-side-'))
const db = join(userData, 'data', 'switchboard.db')
const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim()
makeDemoRepo(project)
makeSideRepo(side)

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
seedDatabase(db, project, side, { linkPullRequest: true })
;({ app, win } = await launch())

const results = []
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
const CHAT = 'Debug auth callback'
const reviews = () => win.locator('[data-reviews-view]')
const pills = () => win.locator('.chat-composer [data-pill-chip]')

async function openReviewsOn612() {
  await win.getByRole('button', { name: 'Reviews', exact: true }).click()
  await reviews().locator('[data-pr-row*="#612"]').click()
  await reviews().getByRole('tab', { name: 'Overview' }).click()
  await reviews().getByText('Replaces the fixed 30 s retry', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 })
}

try {
  await win.locator('.sidebar-recent-row').filter({ hasText: CHAT }).first().click()
  await win.locator('.chat-identity-title').filter({ hasText: CHAT }).waitFor({ state: 'visible' })
  const header = win.locator('[data-linked-pr]')
  await header.filter({ hasText: 'build failed' }).waitFor({ state: 'visible', timeout: 20_000 })
  check('chat header shows the linked PR', (await header.innerText()).includes('#612'), await header.innerText())

  await header.click()
  await win.getByRole('button', { name: 'Open in Reviews' }).click()
  await reviews().getByText('Replaces the fixed 30 s retry', { exact: false }).waitFor({ state: 'visible', timeout: 20_000 })
  check('Open in Reviews selects the PR', await reviews().locator('[data-pr-row*="#612"][aria-current="true"]').isVisible())

  // The failed check: one linked chat, so it goes straight there.
  await reviews().getByRole('button', { name: 'Ask the agent' }).first().click()
  await win.locator('.chat-identity-title').filter({ hasText: CHAT }).waitFor({ state: 'visible', timeout: 10_000 })
  await pills().first().waitFor({ state: 'visible', timeout: 10_000 })
  check('failed check lands as one pill', (await pills().count()) === 1 && (await pills().first().innerText()).includes('1 failed check · #612 · integration'), await pills().first().innerText())

  await openReviewsOn612()
  await reviews().getByRole('tab', { name: /^Conversations/ }).click()
  await reviews().getByRole('button', { name: 'Send all 3 open conversations' }).click()
  await win.locator('.chat-identity-title').filter({ hasText: CHAT }).waitFor({ state: 'visible', timeout: 10_000 })
  await pills().nth(1).waitFor({ state: 'visible', timeout: 10_000 })
  const second = await pills().nth(1).innerText()
  check('all open conversations land as one pill', (await pills().count()) === 2 && second.includes('3 review conversations · #612'), second)

  await win.locator('[contenteditable="true"][aria-label="Chat message"]').last().click()
  await win.keyboard.press('End')
  await win.keyboard.type('Fix these.')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(2500)
  const stored = q("SELECT display_body || char(10) || '---' || char(10) || content FROM messages WHERE conversation_id = 'promo-context' AND role = 'user' ORDER BY timestamp DESC LIMIT 1")
  const displayBody = stored.split('---')[0]
  check('stored display body keeps the pill tokens', (displayBody.match(/\[\[pill:review-[a-z0-9-]+\]\]/g) ?? []).length === 2 && displayBody.includes('Fix these.'), displayBody)
  check('provider text carries the expansion', stored.includes('Failed check: integration') && stored.includes('Review conversation on sync/worker.py:') && stored.includes('pankaj: Cap the jitter too.'))
  const pillKinds = q("SELECT pills_meta FROM messages WHERE conversation_id = 'promo-context' AND role = 'user' ORDER BY timestamp DESC LIMIT 1")
  check('pill metadata stores the review kind', (pillKinds.match(/"kind":"review"/g) ?? []).length === 2, pillKinds)
  const sent = win.locator('[data-chat-panel] [data-pill-chip], [data-chat-panel] span[title*="review conversations"]')
  check('the sent bubble draws the pills', (await sent.count()) >= 1)

  // Unlink from the Overview card: the header control goes away.
  await openReviewsOn612()
  const unlink = reviews().getByRole('button', { name: `Unlink ${CHAT}` })
  await unlink.scrollIntoViewIfNeeded()
  await unlink.click()
  await unlink.waitFor({ state: 'hidden', timeout: 10_000 })
  check('unlink removes the stored link', q("SELECT unlinked_at IS NOT NULL FROM conversation_pull_requests WHERE conversation_id = 'promo-context'") === '1')
  await win.getByRole('button', { name: 'Chats', exact: true }).click()
  await win.locator('[data-linked-pr]').waitFor({ state: 'hidden', timeout: 10_000 })
  check('chat header drops the unlinked PR', !(await win.locator('[data-linked-pr]').isVisible()))

  // Selected diff lines with no linked chat: the dialog asks. The demo PR's
  // repository is no local project's, so it has no chat to offer (and a chat of
  // another project is never offered).
  await openReviewsOn612()
  await reviews().getByRole('tab', { name: /^Files/ }).click()
  await reviews().getByRole('button', { name: 'Select line 84' }).last().click()
  await reviews().getByRole('button', { name: 'Select line 86' }).last().click({ modifiers: ['Shift'] })
  await reviews().getByRole('button', { name: 'Ask the agent' }).click()
  const dialog = win.getByRole('dialog', { name: 'Which chat should get this?' })
  await dialog.waitFor({ state: 'visible', timeout: 10_000 })
  await dialog.getByRole('combobox', { name: 'Chat' }).click()
  await win.getByText('No chats in this project.').waitFor({ state: 'visible', timeout: 5_000 })
  check('the chooser offers no chat of another project', (await win.getByRole('option').count()) === 0)
  await win.keyboard.press('Escape')
  await win.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 })

  // Linked again, the same selection goes straight to the chat.
  q("UPDATE conversation_pull_requests SET unlinked_at = NULL WHERE conversation_id = 'promo-context'")
  await reviews().getByRole('button', { name: 'Select line 84' }).last().click()
  await reviews().getByRole('button', { name: 'Select line 86' }).last().click({ modifiers: ['Shift'] })
  await reviews().getByRole('button', { name: 'Ask the agent' }).click()
  await win.locator('.chat-identity-title').filter({ hasText: CHAT }).waitFor({ state: 'visible', timeout: 10_000 })
  await pills().first().waitFor({ state: 'visible', timeout: 10_000 })
  const lines = await pills().first().innerText()
  check('selected diff lines land as one pill', lines.includes('diff selection · #612 · worker.py:84-86'), lines)
} catch (err) {
  check('flow completed', false, String(err))
} finally {
  await app.close().catch(() => {})
}

const failed = results.filter((r) => !r.ok).length
console.log(failed ? `E2E FAILED (${failed})` : 'E2E PASSED')
process.exit(failed ? 1 : 0)
