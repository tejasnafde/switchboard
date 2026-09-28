/**
 * Hiding repositories the account cannot see, against the built app
 * (npm run build:fast) with the demo adapter and SB_DEMO_REPO_ERRORS=1, which
 * adds two projects in a Bitbucket workspace that answers 404. The card
 * names both, Cancel keeps them, Hide removes the card and counts them under
 * the list, and Show brings one back at a time. Nothing reaches a host; the
 * hide is the backend's own table in an isolated profile. Temp dirs are removed.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scratch = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); scratch.push(d); return d }
process.on('exit', () => { for (const d of scratch) rmSync(d, { recursive: true, force: true }) })
const userData = mk('sb-review-hidden-repos-ud-')

const app = await electron.launch({ args: ['.'], cwd: repoRoot, timeout: 30_000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1', SB_DEMO_REPO_ERRORS: '1', SHELL: '/bin/sh' } })
const win = await app.firstWindow({ timeout: 20_000 })
await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
await win.evaluate(() => Promise.all([
  window.api.settings.set('tour.autoplay', 'false'),
  window.api.settings.set('analytics.enabled', 'false'),
  window.api.settings.set('analytics.noticeSeen', 'true'),
]))
const skip = win.getByRole('button', { name: 'Skip tour' })
if (await skip.isVisible().catch(() => false)) await skip.click()

const results = []
const check = (name, ok, detail = '') => { results.push({ ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`) }
const shot = async (name) => { if (process.env.SB_SHOTS) await win.screenshot({ path: join(process.env.SB_SHOTS, `${name}.png`) }) }
const reviews = () => win.locator('[data-reviews-view]')

try {
  await win.getByRole('button', { name: 'Reviews', exact: true }).click()
  await reviews().locator('[data-pr-row]').first().waitFor({ state: 'visible', timeout: 20_000 })

  const card = reviews().locator('[data-review-notice="bitbucket:not_found"]')
  await card.waitFor({ state: 'visible', timeout: 20_000 })
  await shot('hidden-repos-card')
  const text = await card.innerText()
  check('the card names the workspace and both repositories', text.includes('Cannot see 2 repositories in geoiq-staging: geoiq_broker_app_stg, geoiqcore_stg.'), JSON.stringify(text))
  check('the card says what to do', text.includes("The API token's account needs access to that workspace, or hide these repositories."))
  const box = await card.boundingBox()
  const list = await reviews().locator('aside').boundingBox()
  check('the card fits the list column', !!box && !!list && box.x + box.width <= list.x + list.width + 1, JSON.stringify({ box, list }))
  check('the other repositories still list their PRs', await reviews().locator('[data-pr-row]').count() > 0)

  const hideButton = card.getByRole('button', { name: 'Hide these repositories' })
  const dialog = win.getByRole('alertdialog', { name: 'Hide 2 repositories from Reviews?' })
  await hideButton.click()
  await dialog.waitFor({ state: 'visible' })
  await shot('hidden-repos-confirm')
  check('the confirm names the repositories', (await dialog.innerText()).includes('geoiq-staging/geoiq_broker_app_stg, geoiq-staging/geoiqcore_stg'))
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  check('Cancel keeps the card', await card.isVisible())

  await hideButton.click()
  await dialog.getByRole('button', { name: 'Hide', exact: true }).click()
  await card.waitFor({ state: 'hidden', timeout: 10_000 })
  const row = reviews().locator('[data-pr-hidden-repos]')
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  check('hidden repositories are counted under the list', (await row.innerText()).startsWith('2 repositories hidden'), JSON.stringify(await row.innerText()))

  // A refresh does not bring the card back: the backend no longer reads them.
  await win.evaluate(() => window.api.pullRequests.list()).then((r) => {
    check('the list read skips them', r.ok && !r.data.sources.some((s) => s.error) && r.data.hiddenRepos.length === 2, JSON.stringify(r.ok && r.data.hiddenRepos))
  })

  await row.getByRole('button', { name: 'Show', exact: true }).click()
  const pop = win.getByRole('dialog', { name: 'Hidden repositories' })
  await pop.waitFor({ state: 'visible' })
  await shot('hidden-repos-popover')
  await pop.getByRole('button', { name: 'Show geoiq-staging/geoiqcore_stg' }).click()
  await card.waitFor({ state: 'visible', timeout: 10_000 })
  check('Show brings one repository back', (await card.innerText()).includes('Cannot see 1 repository in geoiq-staging: geoiqcore_stg.'))
  check('the other stays hidden', (await row.innerText()).startsWith('1 repository hidden'))
  await pop.getByRole('button', { name: 'Show geoiq-staging/geoiq_broker_app_stg' }).click()
  await row.waitFor({ state: 'hidden', timeout: 10_000 })
  check('showing the last one removes the hidden line', (await card.innerText()).includes('Cannot see 2 repositories'))
} catch (err) {
  console.error(err)
  results.push({ ok: false })
} finally {
  await app.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 && results.length > 0 ? 0 : 1)
