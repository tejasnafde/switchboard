/**
 * Settings > Accounts & models does not shift while usage readings land,
 * against the built app (npm run build:fast) with the demo adapter and an
 * isolated profile. SB_DEMO_USAGE_DELAY_MS makes the readings arrive one at a
 * time, 350ms apart, as real probes do.
 *
 * Every animation frame records each card's and summary tile's box; after the
 * readings settle, every box must equal the one it had when first painted.
 * Checked three ways: Settings opened and Accounts reached while the prewarm
 * is still reading, a manual refresh, and a reopen (cached values at once).
 *
 * The fixture has no signed-out account: a card whose first reading says
 * "signed out" drops its bars, a different height nobody can know in advance.
 * Temp dirs are removed. Takes ~20s.
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const userData = mkdtempSync(join(tmpdir(), 'sb-accounts-shift-'))
process.on('exit', () => rmSync(userData, { recursive: true, force: true }))

const app = await electron.launch({
  args: ['.'], cwd: repoRoot, timeout: 30_000,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', SB_USER_DATA: userData, SB_DEMO_ADAPTER: '1', SB_DEMO_USAGE_DELAY_MS: '350', SHELL: '/bin/sh' },
})
const win = await app.firstWindow({ timeout: 20_000 })
await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
await win.evaluate(() => Promise.all([
  window.api.settings.set('tour.autoplay', 'false'),
  window.api.settings.set('analytics.enabled', 'false'),
  window.api.settings.set('analytics.noticeSeen', 'true'),
  window.api.providerInstances.upsert({
    id: 'claude-code-work', agentType: 'claude-code', displayName: 'akshaya', accentColor: '#b0833a',
    authMode: 'env', env: null, oauthDir: null, enabled: true,
  }),
]))
// Reload so the renderer lists the new account at start-up, like one made on
// an earlier run: an account created mid-test would add a card mid-test.
await win.reload()
await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
const skip = win.getByRole('button', { name: 'Skip tour' })
if (await skip.isVisible().catch(() => false)) await skip.click()

const failures = []
const settings = win.locator('.settings-page')

function startRecording() {
  return win.evaluate(() => {
    const boxes = {}
    window.__stopBoxes = false
    window.__boxes = boxes
    const tick = () => {
      const page = document.querySelector('.settings-page')
      const targets = page ? [...page.querySelectorAll('[data-account], [data-summary-tile]')] : []
      for (const el of targets) {
        const key = el.getAttribute('data-account') ?? `tile:${el.getAttribute('data-summary-tile')}`
        const r = el.getBoundingClientRect()
        const box = [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 2) / 2).join(',')
        const seen = (boxes[key] ??= [])
        if (seen[seen.length - 1] !== box) seen.push(box)
      }
      if (!window.__stopBoxes) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function settled() {
  await win.waitForFunction(() => {
    const page = document.querySelector('.settings-page')
    return !!page && page.querySelectorAll('[data-account]').length === 4
      && page.querySelectorAll('[aria-busy="true"]').length === 0
      && !page.textContent.includes('Reading usage')
  }, null, { timeout: 15_000 })
  await win.waitForTimeout(300)
}

async function checkNoShift(label) {
  const boxes = await win.evaluate(() => { window.__stopBoxes = true; return window.__boxes })
  const moved = Object.entries(boxes).filter(([, seen]) => seen.length > 1)
  const cards = Object.keys(boxes).filter((k) => !k.startsWith('tile:')).length
  const ok = cards === 4 && moved.length === 0
  if (!ok) failures.push(label)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${cards} cards tracked${moved.map(([k, seen]) => `\n  ${k}: ${seen.join(' -> ')}`).join('')}`)
}

try {
  // 1. Open Settings on General (the prewarm starts), go to Accounts at once.
  await startRecording()
  await win.getByTitle('Settings').click()
  await settings.waitFor({ state: 'visible' })
  await settings.getByRole('button', { name: /^Accounts & models/ }).click()
  await settings.locator('[data-account]').first().waitFor({ state: 'visible' })
  const skeletons = await settings.locator('[data-account] [aria-busy="true"]').count()
  console.log(`${skeletons > 0 ? 'PASS' : 'FAIL'} readings were still outstanding on first paint (${skeletons} skeletons)`)
  if (skeletons === 0) failures.push('the test did not catch the load in flight')
  await settled()
  await checkNoShift('load')

  // 2. Manual refresh: previous values stay up, dimmed, and nothing moves.
  await startRecording()
  await settings.getByRole('button', { name: 'Actions for akshaya' }).click()
  await win.getByRole('button', { name: 'Refresh usage' }).click()
  const card = settings.locator('[data-account="claude-code-work"]')
  await settings.locator('[data-account="claude-code-work"][aria-busy="true"]').waitFor({ state: 'visible', timeout: 5000 })
  const bars = await card.getByRole('progressbar').count()
  console.log(`${bars === 2 ? 'PASS' : 'FAIL'} refreshing card keeps its ${bars} bars`)
  if (bars !== 2) failures.push('refresh blanked the bars')
  await settled()
  await checkNoShift('refresh')

  // 3. Reopen: cached values at once, then the fresh reads land in place.
  await win.keyboard.press('Escape')
  await settings.waitFor({ state: 'hidden' })
  await startRecording()
  await win.getByTitle('Settings').click()
  await settings.getByRole('button', { name: /^Accounts & models/ }).click()
  await settings.locator('[data-account]').first().waitFor({ state: 'visible' })
  const cachedBars = await settings.getByRole('progressbar').count()
  console.log(`${cachedBars === 6 ? 'PASS' : 'FAIL'} reopened page shows ${cachedBars} cached bars at once`)
  if (cachedBars !== 6) failures.push('reopen did not show cached values')
  await settled()
  await checkNoShift('reopen')
} catch (err) {
  failures.push(String(err))
  console.error(err)
} finally {
  await app.close()
}

if (failures.length > 0) {
  console.error(`FAILED: ${failures.join('; ')}`)
  process.exit(1)
}
console.log('accounts page holds still')
