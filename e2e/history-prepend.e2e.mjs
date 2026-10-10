/**
 * Scrolling up a long chat loads the previous history window early and
 * without moving what the user reads, against the built app
 * (npm run build:fast) with the demo adapter and an isolated profile. The
 * chat is SQLite-only: 700 rows of uneven height, so the desktop opens the
 * newest 200 and has older windows to prepend.
 *
 * The page scrolls up in fixed steps. Between two steps nothing else may move
 * the row in view: it is sampled on every frame, every scroll event, every
 * React commit (MutationObserver) and every ResizeObserver pass (the one the
 * virtualizer corrects row sizes in), and must stay within 1 px and stay
 * mounted. No row other than a turn may appear in the list (no loading row).
 * Takes ~30s. Temp dirs are removed.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, realpathSync, writeFileSync } from 'node:fs'
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

const userData = mk('sb-prepend-ud-')
const project = realpathSync(mk('sb-prepend-proj-'))
const db = join(userData, 'data', 'switchboard.db')

async function launch() {
  const app = await electron.launch({ args: ['.'], cwd: repoRoot, timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1', SHELL: '/bin/sh' } })
  const win = await app.firstWindow({ timeout: 20_000 })
  win.on('pageerror', (e) => console.error('pageerror', e.message))
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

const now = Date.now()
const ROWS = 700
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`
const statements = [
  `INSERT OR REPLACE INTO projects (path, name, added_at, sort_order) VALUES (${sql(project)}, 'prepend', ${now}, 0);`,
  `INSERT INTO conversations (id, project_path, agent_type, title, created_at, updated_at) VALUES ('long-chat', ${sql(project)}, 'claude-code', 'Long scrollback', ${now - ROWS * 1000}, ${now});`,
]
for (let i = 0; i < ROWS; i++) {
  const user = i % 2 === 0
  // Uneven heights, far from the virtualizer's 120 px estimate either way.
  const paragraphs = user ? 1 : 1 + ((i * 7) % 11)
  const content = Array.from({ length: paragraphs }, (_, p) =>
    `Row ${i} paragraph ${p}. ${'The retry path keeps the state token until the exchange settles. '.repeat(1 + (i % 3))}`).join('\n\n')
  statements.push(`INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES ('row-${i}', 'long-chat', '${user ? 'user' : 'assistant'}', ${sql(content)}, ${now - (ROWS - i) * 1000});`)
}
const seedFile = join(userData, 'seed.sql')
writeFileSync(seedFile, statements.join('\n'))
execFileSync('sqlite3', [db, `.read ${seedFile}`])
;({ app, win } = await launch())

try {
  await win.getByTestId('app-sidebar').getByText('Long scrollback', { exact: true }).first().click()
  await win.locator('[data-message-id="row-699"]').first().waitFor({ timeout: 15_000 })
  // Let the open-time follow-to-bottom passes finish.
  await win.waitForTimeout(1000)

  const report = await win.evaluate(async () => {
    const list = document.querySelector('[data-chat-panel] [data-message-list-scroll]')
    const content = list.firstElementChild
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))
    const listTop = () => list.getBoundingClientRect().top
    const offsetOf = (el) => el.getBoundingClientRect().top - listTop()
    const failures = []
    const strays = []
    let baseline = null
    let samples = 0

    const sample = (where) => {
      if (!baseline) return
      samples++
      const el = list.querySelector(`[data-message-id="${baseline.id}"]`)
      if (!el) {
        failures.push({ where, id: baseline.id, missing: true, scrollTop: list.scrollTop })
        return
      }
      const drift = offsetOf(el) - baseline.top
      if (Math.abs(drift) > 1) failures.push({ where, id: baseline.id, drift: Math.round(drift) })
    }
    // The bubble in view whose top is nearest a third of the way down the
    // list is what the user reads (one tall bubble may cover the whole view).
    const pickAnchor = () => {
      const target = list.clientHeight / 3
      let best = null
      for (const el of list.querySelectorAll('[data-message-id]')) {
        const top = offsetOf(el)
        if (top > list.clientHeight || top + el.getBoundingClientRect().height < 0) continue
        if (!best || Math.abs(top - target) < Math.abs(best.top - target)) best = { id: el.getAttribute('data-message-id'), top }
      }
      return best
    }

    // Created after the virtualizer's own observer, so its callbacks run
    // after the virtualizer corrected the scroll for a measured row.
    const resize = new ResizeObserver(() => sample('resize'))
    resize.observe(content)
    content.querySelectorAll('[data-virtual-turn]').forEach((row) => resize.observe(row))
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement)) continue
          if (node.hasAttribute('data-virtual-turn')) resize.observe(node)
          else strays.push(node.outerHTML.slice(0, 120))
        }
      }
      sample('commit')
    })
    mutations.observe(content, { childList: true })
    const onScroll = () => sample('scroll')
    list.addEventListener('scroll', onScroll, true)
    let sampling = true
    const loop = () => { if (!sampling) return; sample('frame'); requestAnimationFrame(loop) }
    requestAnimationFrame(loop)

    // A prepend shifts every turn's index by the number of turns added.
    const turnIndexOf = (id) => Number(list.querySelector(`[data-message-id="${id}"]`)?.closest('[data-virtual-turn]')?.getAttribute('data-index') ?? NaN)
    let prependedAtScrollTop = null
    for (let step = 0; step < 400 && prependedAtScrollTop === null; step++) {
      baseline = null
      list.scrollTop = Math.max(0, list.scrollTop - 300)
      baseline = pickAnchor()
      if (!baseline) failures.push({ where: 'step', blank: true, scrollTop: list.scrollTop })
      const before = list.scrollTop
      const indexBefore = baseline ? turnIndexOf(baseline.id) : NaN
      await frame()
      await frame()
      if (baseline && turnIndexOf(baseline.id) > indexBefore + 50) prependedAtScrollTop = before
      if (list.scrollTop === 0 && prependedAtScrollTop === null) break
    }
    // Hold still while the prepended rows are measured.
    for (let i = 0; i < 60; i++) await frame()
    sampling = false
    resize.disconnect()
    mutations.disconnect()
    list.removeEventListener('scroll', onScroll, true)
    return { failures: failures.slice(0, 10), failureCount: failures.length, strays: strays.slice(0, 3), samples, prependedAtScrollTop }
  })

  check('the previous window loads before the user reaches the top', report.prependedAtScrollTop !== null && report.prependedAtScrollTop > 1000,
    `scrollTop when it landed: ${report.prependedAtScrollTop}`)
  check('the row in view never moves or unmounts while rows are prepended and measured', report.failureCount === 0,
    `${report.failureCount} of ${report.samples} samples: ${JSON.stringify(report.failures)}`)
  check('no loading row appears in the list', report.strays.length === 0, JSON.stringify(report.strays))
} catch (e) {
  check('unexpected error', false, e.message.split('\n').slice(0, 3).join(' / '))
  await win.screenshot({ path: join(tmpdir(), 'sb-prepend-error.png') }).catch(() => {})
} finally {
  await app.close().catch(() => {})
}

const failed = results.filter((r) => !r.ok).length
console.log(failed ? `FAILED ${failed}` : 'ALL PASS')
process.exit(failed ? 1 : 0)
