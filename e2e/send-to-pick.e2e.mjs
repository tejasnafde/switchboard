/**
 * `/send-to` target picker, against the built app (npm run build:fast) with
 * the demo adapter and an isolated profile. Picking a chat by mouse and by
 * keyboard must show its title (not the raw id) and leave the caret after
 * `: `, so the message the user types lands in the message half. The keyboard
 * pick is then sent and must reach that exact chat. Also covers the caret
 * after a slash-command pick and an @-mention pick, and the error banner:
 * dismissable, and cleared once the text changes. Temp dirs are removed.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeDemoRepo, makeSideRepo, seedDatabase } from './fixtures/demo-workspace.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
process.on('exit', () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })
const userData = mk('sb-sendto-ud-')
const project = realpathSync(mk('sb-sendto-proj-'))
const side = realpathSync(mk('sb-sendto-side-'))
const db = join(userData, 'data', 'switchboard.db')
const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim()
makeDemoRepo(project)
makeSideRepo(side)
writeFileSync(join(project, 'notes.md'), '# notes\n')

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
seedDatabase(db, project, side)
;({ app, win } = await launch())

const results = []
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }

const editor = () => win.locator('[contenteditable="true"][aria-label="Chat message"]').last()
/** Composer text and the caret as an offset into it (null when unfocused). */
const composerState = () => editor().evaluate((el) => {
  const sel = window.getSelection()
  let caret = null
  if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) {
    const r = document.createRange()
    r.setStart(el, 0)
    r.setEnd(sel.anchorNode, sel.anchorOffset)
    caret = r.toString().length
  }
  return { text: el.innerText.replace(/\n$/, ''), caret }
})
const clearComposer = async () => {
  await editor().click()
  await win.keyboard.press('Meta+A')
  await win.keyboard.press('Backspace')
}
async function openConversation(title) {
  await win.locator('.sidebar-recent-row').filter({ hasText: title }).first().click()
  await win.locator('.chat-identity-title').filter({ hasText: title }).waitFor({ state: 'visible' })
}

const target = 'Compare retry strategies'
try {
  // Both chats must be open for the picker to offer one from the other, and
  // the target must be running to accept a delivery.
  await openConversation(target)
  await editor().click()
  await win.keyboard.type('warm up')
  await win.keyboard.press('Enter')
  await win.getByText('Worked for').first().waitFor({ timeout: 30_000 })
  await openConversation('Debug auth callback')

  for (const mode of ['slash+mouse', 'mouse', 'keyboard']) {
    await clearComposer()
    if (mode.startsWith('slash')) {
      await win.keyboard.type('/send-t')
      await win.getByRole('option').filter({ hasText: 'send-to' }).first().waitFor({ timeout: 5000 })
      await win.keyboard.press('Enter')
    } else {
      await win.keyboard.type('/send-to Compare')
    }
    const option = win.getByRole('option').filter({ hasText: target }).first()
    await option.waitFor({ timeout: 5000 })
    if (mode.endsWith('mouse')) await option.click()
    else await win.keyboard.press('Enter')
    await win.waitForTimeout(300)
    const picked = await composerState()
    const expected = `/send-to ${target}: `
    check(`${mode} pick shows the chat title`, picked.text === expected, JSON.stringify(picked.text))
    check(`${mode} pick leaves the caret after ": "`, picked.caret === expected.length, `caret ${picked.caret}`)
    await win.keyboard.type(`hello-${mode}`)
    const typed = await composerState()
    check(`${mode} pick: typing lands in the message half`, typed.text === `${expected}hello-${mode}`, JSON.stringify(typed.text))
  }

  // Send the keyboard pick: it must reach the picked chat.
  await win.keyboard.press('Enter')
  let delivered = false
  for (let i = 0; i < 40 && !delivered; i++) {
    delivered = Number(q(`SELECT count(*) FROM messages WHERE conversation_id = 'promo-parallel' AND content LIKE '%hello-keyboard%';`)) > 0
    if (!delivered) await win.waitForTimeout(250)
  }
  const sendError = await win.locator('[data-composer-send-error]').innerText({ timeout: 100 }).catch(() => '')
  check('the send reaches the picked chat', delivered, sendError)

  // Slash-command pick: `/send-to` takes arguments, so it is inserted and the
  // caret must sit after it (which also opens the target picker).
  await clearComposer()
  await win.keyboard.type('/send-t')
  await win.getByRole('option').filter({ hasText: 'send-to' }).first().waitFor({ timeout: 5000 })
  await win.keyboard.press('Enter')
  await win.waitForTimeout(300)
  const slash = await composerState()
  check('slash pick leaves the caret after the command', slash.text === '/send-to ' && slash.caret === 9, JSON.stringify(slash))

  // @-mention pick: the chip replaces `@not`, and the caret follows it.
  await clearComposer()
  await win.keyboard.type('see @notes')
  const at = win.getByRole('option').filter({ hasText: 'notes.md' }).first()
  await at.waitFor({ timeout: 5000 })
  await at.click()
  await win.waitForTimeout(300)
  await win.keyboard.type('now')
  const mention = await composerState()
  check('@-mention pick: typing lands after the chip', /^see .*notes\.md.*now$/s.test(mention.text), JSON.stringify(mention.text))

  // The error banner: a failed command shows it, the x dismisses it, and
  // editing the text clears it.
  const banner = win.locator('[data-composer-send-error]')
  const fail = async () => {
    await clearComposer()
    await win.keyboard.type(`/send-to ${target}:`)
    await win.keyboard.press('Enter')
    await banner.waitFor({ timeout: 5000 })
  }
  await fail()
  check('an empty /send-to shows the error', (await banner.innerText()).includes('Nothing to send'))
  // The failed send clears the composer and then restores it. The caret used
  // to come back at 0, before `/send-to`, which is what the user reported.
  const restored = await composerState()
  check('a failed send restores the text with the caret at its end',
    restored.text === `/send-to ${target}:` && restored.caret === restored.text.length, JSON.stringify(restored))
  // Move focus away so the action has to bring the caret back itself.
  await win.locator('.chat-identity-title').click()
  await banner.getByRole('button', { name: 'Write the message' }).click()
  await win.waitForTimeout(200)
  const fix = await composerState()
  check('the banner action puts the caret at the message position', fix.caret === fix.text.length, JSON.stringify(fix))
  await win.keyboard.type(' x')
  await win.waitForTimeout(200)
  check('editing the text clears the banner', await banner.count() === 0)
  await fail()
  await banner.getByRole('button', { name: 'Dismiss' }).click()
  check('the x dismisses the banner', await banner.count() === 0)
  await fail()
  await clearComposer()
  await win.waitForTimeout(200)
  check('clearing the composer clears the banner', await banner.count() === 0)
} catch (e) {
  check('unexpected error', false, e.message.split('\n')[0])
  await win.screenshot({ path: join(tmpdir(), 'sb-sendto-error.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
