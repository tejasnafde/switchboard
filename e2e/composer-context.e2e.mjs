#!/usr/bin/env node
/**
 * Cmd+L from a chat message into the composer, against the built app
 * (npm run build:fast first) on the seeded tour workspace with the scripted
 * demo provider: the caret lands right after the inserted chip (the focus
 * that follows the insert used to put it back before the chip), and the
 * user's own messages can be quoted too, attributed to "you", with their
 * pills as their labels. Temp dirs are removed on exit.
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

const userData = mk('sb-ctx-ud-')
const projectRoot = mk('sb-ctx-proj-')
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

const editor = win.locator('.chat-composer [aria-label="Chat message"]').first()
const chips = editor.locator('[data-pill-chip]')
const clearComposer = async () => {
  await editor.click()
  await win.keyboard.press('ControlOrMeta+A')
  await win.keyboard.press('Backspace')
}
// What the composer shows, with each chip as <chip>.
const composerText = () => editor.evaluate((root) => {
  const parts = []
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { parts.push(node.textContent); return }
    if (node instanceof HTMLElement && node.hasAttribute('data-pill-chip')) { parts.push('<chip>'); return }
    node.childNodes.forEach(walk)
  }
  walk(root)
  return parts.join('').replace(/ /g, ' ')
})
// A click in the bubble takes focus from the composer, as a drag would; then
// the bubble's whole text is selected.
const selectBubble = async (messageId) => {
  const bubble = win.locator(`[data-message-id="${messageId}"] .message-bubble`).first()
  await bubble.click({ position: { x: 4, y: 4 } })
  await bubble.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el.firstElementChild ?? el)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
}
const quoteBubble = async (messageId) => {
  const before = await chips.count()
  await selectBubble(messageId)
  await win.keyboard.press('ControlOrMeta+L')
  await win.waitForFunction(([n]) => document.querySelectorAll('.chat-composer [data-pill-chip]').length > n, [before], { timeout: 5000 })
  // The context bridge focuses the composer on the next frame.
  await win.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Chat message', null, { timeout: 2000 })
}

try {
  await win.locator('.sidebar-recent-row').filter({ hasText: 'Debug auth callback' }).first().click()
  await win.locator('.chat-identity-title').filter({ hasText: 'Debug auth callback' }).waitFor({ state: 'visible' })

  // Caret at the end of the text.
  await clearComposer()
  await win.keyboard.type('hello world')
  await quoteBubble('promo-m4')
  await win.keyboard.type('Z')
  let text = await composerText()
  check('Cmd+L after text: typing continues after the chip', /^hello world\s*<chip>\s*Z$/.test(text), JSON.stringify(text))

  // Caret inside the text.
  await clearComposer()
  await win.keyboard.type('hello world')
  for (let i = 0; i < 5; i++) await win.keyboard.press('ArrowLeft')
  await quoteBubble('promo-m4')
  await win.keyboard.type('Z')
  text = await composerText()
  check('Cmd+L mid-text: typing continues right after the chip', /^hello\s*<chip>\s*Z\s*world$/.test(text), JSON.stringify(text))

  // A second Cmd+L goes after the first chip.
  await quoteBubble('promo-m1')
  await win.keyboard.type('Y')
  text = await composerText()
  check('a second Cmd+L lands after the first chip', /^hello\s*<chip>\s*Z\s*<chip>\s*Y\s*world$/.test(text), JSON.stringify(text))

  // The user's own message, which holds two pills.
  await clearComposer()
  await quoteBubble('promo-m2')
  const pill = await win.evaluate(() => {
    const all = Object.values(JSON.parse(localStorage.getItem('switchboard.draftPills') ?? '{}')).flat()
    return all.filter((p) => p.kind === 'chat-message').pop() ?? null
  })
  check('Cmd+L quotes the user\'s own message', !!pill, JSON.stringify(pill))
  check('the quote is attributed to "you"', !!pill && pill.label.startsWith('you: "') && pill.content.startsWith('> from you: "'), JSON.stringify(pill))
  check('the quote shows its pills as their labels, not tokens',
    !!pill && pill.content.includes('Compare src/api/auth.ts:1-7 with api · oauth callback.') && !pill.content.includes('[[pill:'), JSON.stringify(pill?.content))
  await clearComposer()
} catch (e) {
  check('unexpected error', false, e.message.split('\n').slice(0, 3).join(' / '))
  await win.screenshot({ path: join(tmpdir(), 'sb-ctx-error.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}

const failed = results.filter((ok) => !ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
