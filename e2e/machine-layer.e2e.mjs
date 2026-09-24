#!/usr/bin/env node
/**
 * E2E for the sidebar machine layer (M2/M3): the real app renders the pinned
 * local machine wrapping the tree, and the Add-machine modal opens. Isolated
 * userData so it never collides with a running release build.
 *
 * Run: npm run build && node e2e/machine-layer.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build` first')
  process.exit(1)
}

let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-e2e-machines-'))
process.once('exit', () => rmSync(userDataDir, { recursive: true, force: true }))

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  // The first-run tour and analytics notice both read their setting on
  // mount, and the notice sits over the sidebar footer: set them, then reload.
  await win.evaluate(() => Promise.all([
    window.api.settings.set('tour.autoplay', 'false'),
    window.api.settings.set('analytics.enabled', 'false'),
    window.api.settings.set('analytics.noticeSeen', 'true'),
  ]))
  await win.reload()

  const firstMachine = win.locator('.sidebar-machine-name').first()
  await firstMachine.waitFor({ timeout: 20_000 })
  check((await firstMachine.textContent())?.trim() === 'This Mac', 'local machine "This Mac" is pinned first')

  await win.getByRole('button', { name: 'Create', exact: true }).click()
  const newMachine = win.getByRole('menuitem', { name: /New machine/ })
  check(await newMachine.isVisible(), 'Create menu offers New machine')

  await newMachine.click()
  check(await win.getByText('Add machine', { exact: true }).waitFor({ timeout: 5_000 }).then(() => true).catch(() => false), 'Add-machine modal opens')
} catch (err) {
  console.error('✗ harness error:', err?.message ?? err)
  failures++
} finally {
  await app.close().catch(() => {})
}

console.log(failures === 0 ? '\nMACHINE E2E PASSED' : `\nMACHINE E2E FAILED (${failures} check(s))`)
process.exit(failures === 0 ? 0 : 1)
