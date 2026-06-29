#!/usr/bin/env node
/**
 * E2E for the sidebar machine layer (M2/M3): the real app renders the pinned
 * local machine wrapping the tree, and the Add-machine modal opens. Isolated
 * userData so it never collides with a running release build.
 *
 * Run: npm run build && node e2e/machine-layer.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, existsSync } from 'node:fs'
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

const app = await electron.launch({
  args: ['.', `--user-data-dir=${mkdtempSync(join(tmpdir(), 'sb-e2e-machines-'))}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForSelector('.sidebar-machine-header', { timeout: 20_000 })

  const localName = await win.textContent('.sidebar-machine-name')
  check(localName?.trim() === 'This Mac', 'local machine "This Mac" is pinned first')
  check(await win.isVisible('.sidebar-add-machine'), 'Add-machine entry is visible')

  await win.click('.sidebar-add-machine')
  check(await win.waitForSelector('.machine-modal', { timeout: 5_000 }).then(() => true).catch(() => false), 'Add-machine modal opens')
} catch (err) {
  console.error('✗ harness error:', err?.message ?? err)
  failures++
} finally {
  await app.close().catch(() => {})
}

console.log(failures === 0 ? '\nMACHINE E2E PASSED' : `\nMACHINE E2E FAILED (${failures} check(s))`)
process.exit(failures === 0 ? 0 : 1)
