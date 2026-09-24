/**
 * A long markdown reply stays inside its bubble in a narrow chat pane,
 * against the built app (npm run build:fast) with the demo adapter and an
 * isolated profile.
 *
 * The reply (the demo adapter's "to-dos" script) is a real one that rendered
 * clipped: numbered lists past 9, bold labels, inline code, a branch name that
 * resolves to a file pill, and a fenced command. At the narrowest window the
 * chat pane is ~160px wide. Temp dirs are removed. Takes ~30s.
 */
import { _electron as electron } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
process.on('exit', () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })
const userData = mk('sb-overflow-ud-')
const project = realpathSync(mk('sb-overflow-proj-'))
// `chore/release-0.8.64` in the reply becomes a file pill only if it exists.
mkdirSync(join(project, 'chore'))
writeFileSync(join(project, 'chore', 'release-0.8.64'), '')
const db = join(userData, 'data', 'switchboard.db')
const q = (sql) => execFileSync('sqlite3', [db, sql]).toString().trim()

async function launch() {
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1', SHELL: '/bin/sh' } })
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
q(`INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES ('${project}', 'overflow', ${Date.now()}, 0);`)
;({ app, win } = await launch())

const results = []
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }

try {
  await win.locator('body').click({ position: { x: 900, y: 400 } })
  await win.keyboard.press('Meta+Shift+O')
  await win.getByTestId('new-chat-project-picker').getByRole('option').first().waitFor({ timeout: 5000 })
  await win.keyboard.press('Enter')
  await win.getByTestId('draft-workspace').waitFor({ timeout: 5000 })
  await win.getByTestId('draft-workspace').selectOption('project')
  await win.locator('[contenteditable="true"]').last().click()
  await win.keyboard.type('list the to-dos')
  await win.keyboard.press('Enter')
  await win.locator('.markdown-content .file-chip').first().waitFor({ timeout: 60_000 })
  // 800 is the window's minimum width, which leaves the chat pane its narrowest.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 800))
  await win.waitForTimeout(800)

  const geometry = await win.evaluate(() => {
    const md = [...document.querySelectorAll('.markdown-content')].find((e) => e.textContent.includes('Items 1 to 3'))
    const bubble = md.closest('.message-bubble')
    const list = md.closest('[data-message-list-scroll]')
    const box = bubble.getBoundingClientRect()
    // A code block's own lines are meant to run past it and scroll.
    const escapes = [...bubble.querySelectorAll('*')]
      .filter((el) => !el.parentElement.closest('pre'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5) })
      .map((el) => `${el.tagName}.${el.className} "${el.textContent.slice(0, 30)}"`)
    // A marker is drawn in the list's left padding, outside every box it
    // could be measured by, so compare its text width with that padding.
    const clippedMarkers = [...md.querySelectorAll('ol')].flatMap((ol) => {
      const probe = document.createElement('span')
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
      probe.textContent = `${ol.start + ol.children.length - 1}. `
      ol.firstElementChild.appendChild(probe)
      const width = probe.getBoundingClientRect().width
      probe.remove()
      return width > parseFloat(getComputedStyle(ol).paddingLeft) ? [`${probe.textContent.trim()} needs ${width | 0}px`] : []
    })
    const pre = md.querySelector('pre')
    return {
      bubbleWidth: box.width | 0,
      escapes,
      clippedMarkers,
      listOverflow: list.scrollWidth - list.clientWidth,
      preScrolls: pre.scrollWidth > pre.clientWidth && getComputedStyle(pre).whiteSpace === 'pre',
      chips: md.querySelectorAll('.file-chip').length,
    }
  })
  check('the chat pane is narrow', geometry.bubbleWidth < 260, `bubble=${geometry.bubbleWidth}px`)
  check('the branch name renders as a file pill', geometry.chips > 0, `chips=${geometry.chips}`)
  check('nothing in the message is wider than its bubble', geometry.escapes.length === 0, geometry.escapes.slice(0, 5).join(', '))
  check('two-digit list markers fit the list padding', geometry.clippedMarkers.length === 0, geometry.clippedMarkers.join(', '))
  check('the message list does not scroll sideways', geometry.listOverflow <= 0, `overflow=${geometry.listOverflow}px`)
  check('the code block scrolls instead of wrapping', geometry.preScrolls)
} catch (e) {
  check('unexpected error', false, e.message.split('\n')[0])
  await win.screenshot({ path: join(tmpdir(), 'sb-overflow-error.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
