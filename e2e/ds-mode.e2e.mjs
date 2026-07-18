#!/usr/bin/env node
/**
 * Data scientist mode e2e: cmd+shift+J swaps the layout (workbench takes the
 * wide center slot, chat docks right) with every pane staying mounted, the
 * toggle persists via settings, and the IDE boot auto-seeds the Jupyter
 * extension stack from Open VSX.
 *
 * Reuses the machine's already-downloaded code-server binary (symlinked into
 * the temp user-data dir) so only the two extensions download (~60MB once):
 *   node e2e/ds-mode.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
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

const tempDirs = []
process.on('exit', () => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort on exit */
    }
  }
})

const project = mkdtempSync(join(tmpdir(), 'sb-dsmode-e2e-'))
tempDirs.push(project)
writeFileSync(join(project, 'notes.ipynb'), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }))

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-dsmode-e2e-ud-'))
tempDirs.push(userDataDir)

// Reuse the real code-server binary; extensions dir starts EMPTY so the
// Jupyter seed path is exercised.
const realCs = join(homedir(), 'Library/Application Support/switchboard/code-server/4.127.0')
if (existsSync(realCs)) {
  mkdirSync(join(userDataDir, 'code-server'), { recursive: true })
  symlinkSync(realCs, join(userDataDir, 'code-server/4.127.0'))
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

const layoutProbe = (win) =>
  win.evaluate(() => {
    const handle = document.querySelector('[data-handle-id="terminal"]')
    if (!handle) return null
    const parent = handle.parentElement
    const kids = [...parent.children]
    const idx = kids.indexOf(handle)
    const chatEl = kids[idx - 1] // DOM order: chat wrapper, handle, right pane
    const rightEl = kids[idx + 1]
    const cs = (el) => getComputedStyle(el)
    return {
      chatOrder: cs(chatEl).order,
      chatGrow: cs(chatEl).flexGrow,
      rightOrder: cs(rightEl).order,
      rightGrow: cs(rightEl).flexGrow,
      handleOrder: cs(handle).order,
    }
  })

try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.settings, null, { timeout: 20_000 })
  await win.waitForTimeout(1500) // let hydration settle

  const before = await layoutProbe(win)
  check(before !== null, 'layout probe found the terminal handle')
  check(before?.chatGrow === '1' && before?.rightGrow === '0', 'default layout: chat wide, right pane fixed')

  await win.evaluate(() => document.body.focus())
  await win.keyboard.press('Meta+Shift+J')
  await win.waitForTimeout(300)

  const ds = await layoutProbe(win)
  check(ds?.rightGrow === '1', 'DS mode: workbench pane is the wide slot (flex-grow 1)')
  check(ds?.chatGrow === '0', 'DS mode: chat column is fixed width')
  check(ds?.rightOrder === '1' && ds?.handleOrder === '2' && ds?.chatOrder === '3', 'DS mode: visual order is workbench | handle | chat')

  const persisted = await win.evaluate(() => window.api.settings.get('layout.dataScienceMode'))
  check(persisted === 'true', 'DS mode persisted to settings')

  // Jupyter seeding: boot the IDE against the notebook project and verify
  // the extension stack lands in the fresh extensions dir.
  if (existsSync(realCs)) {
    const ensure = await win.evaluate((folder) => window.api.ide.ensure(folder), project)
    check(ensure?.ok === true, `ide booted (${JSON.stringify(ensure)})`)
    const extDir = join(userDataDir, 'code-server/extensions')
    const entries = existsSync(extDir) ? readdirSync(extDir) : []
    check(
      entries.some((e) => e.startsWith('ms-toolsai.jupyter-')),
      `jupyter extension seeded on boot (${entries.filter((e) => e.startsWith('ms-')).join(', ') || 'none'})`
    )
    check(entries.some((e) => e.startsWith('ms-python.python-')), 'python extension seeded on boot')
  } else {
    console.log('  (skipped seed check - no local code-server binary to reuse)')
  }

  await win.keyboard.press('Meta+Shift+J')
  await win.waitForTimeout(300)
  const restored = await layoutProbe(win)
  check(restored?.chatGrow === '1' && restored?.rightGrow === '0', 'toggling off restores the default layout')
} finally {
  await app.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
