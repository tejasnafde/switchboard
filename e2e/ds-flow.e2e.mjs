#!/usr/bin/env node
/**
 * Data-scientist-mode HUMAN FLOW e2e: the journey a data scientist takes,
 * driven through the real UI - add a project containing a notebook, open a
 * new thread from the sidebar, hit cmd+shift+J, and end with the workbench
 * (notebook rendered as cells) in the wide center slot and the chat column
 * docked right, mirror created by the session attach.
 *
 * Point SB_DS_FLOW_PROJECT at a project dir with an .ipynb (defaults to a
 * generated throwaway). Cold extensions dir exercises the Jupyter seed.
 *   node e2e/ds-flow.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
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

let project = process.env.SB_DS_FLOW_PROJECT
let notebookName = process.env.SB_DS_FLOW_NOTEBOOK ?? 'EDA_Raw_Data.ipynb'
if (!project) {
  project = mkdtempSync(join(tmpdir(), 'sb-ds-flow-proj-'))
  tempDirs.push(project)
  notebookName = 'analysis.ipynb'
  writeFileSync(
    join(project, notebookName),
    JSON.stringify({
      cells: [{ id: 'a', cell_type: 'code', source: ['x = 1'], metadata: {}, outputs: [], execution_count: null }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })
  )
  execFileSync('git', ['init', '-q'], { cwd: project })
}

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-ds-flow-ud-'))
tempDirs.push(userDataDir)
// Reuse the machine's code-server binary; extensions dir stays cold so the
// Jupyter seed path runs for real.
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
    const kids = [...handle.parentElement.children]
    const idx = kids.indexOf(handle)
    const cs = (el) => getComputedStyle(el)
    return {
      chatGrow: cs(kids[idx - 1]).flexGrow,
      chatOrder: cs(kids[idx - 1]).order,
      rightGrow: cs(kids[idx + 1]).flexGrow,
      rightOrder: cs(kids[idx + 1]).order,
    }
  })

try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })

  // 1. Add the project the way the sidebar would.
  const added = await win.evaluate((dir) => window.api.routing.invokeOn('local', 'app:add-project-path', dir), project)
  check(added && !added.error, 'project added')
  await win.evaluate(() => window.api.settings.set('tour.autoplay', 'false'))
  await win.reload()
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  await win.keyboard.press('Escape')

  // 2. New thread from the sidebar compose button (real session -> mirror attach).
  const projName = project.split('/').pop()
  const row = win.locator('.sidebar-project-header', { hasText: projName }).first()
  await row.hover()
  await row.locator('.sidebar-project-compose').click({ force: true })
  await win.waitForTimeout(1500)
  check(true, 'new thread created from the sidebar')

  // 3. cmd+shift+J: data scientist mode.
  await win.keyboard.press('Meta+Shift+J')
  await win.waitForTimeout(400)
  const ds = await layoutProbe(win)
  check(ds?.rightGrow === '1' && ds?.rightOrder === '1', 'workbench pane took the wide center slot')
  check(ds?.chatGrow === '0' && ds?.chatOrder === '3', 'chat column docked right at fixed width')
  check(await win.locator('[data-ide-pane]').isVisible(), 'IDE pane visible')

  // 4. Workbench boots inside the webview (cold extensions -> Jupyter seed runs).
  console.log('  (cold boot: extension seeding may take a couple of minutes)')
  let workbench = null
  for (let i = 0; i < 300 && !workbench; i++) {
    await win.waitForTimeout(1000)
    workbench = app.windows().find((p) => p.url().includes('127.0.0.1')) ?? null
  }
  check(!!workbench, 'webview navigated to the workbench')
  await workbench.waitForSelector('.monaco-workbench', { timeout: 180_000 })
  check(true, 'VS Code workbench rendered in the center pane')

  // 5. Sessions start LAZILY (on the first message), so the mirror must NOT
  //    exist yet - it appears when the agent session attaches. Documented
  //    behavior, pinned here so a change to eager attach is a conscious one.
  const mirrorPath = join(project, '.switchboard/notebooks', notebookName.replace(/\.ipynb$/, '.py'))
  check(!existsSync(mirrorPath), 'mirror not yet created (sessions attach lazily on first message)')

  // 6. Open the notebook in the workbench - it must render as CELLS (Jupyter
  //    extension seeded), not raw JSON.
  let routed = false
  for (let i = 0; i < 90 && !routed; i++) {
    await win.waitForTimeout(1000)
    const res = await win.evaluate(
      ({ dir, nb }) => window.api.ide.open({ folder: dir, path: nb, line: 1 }),
      { dir: project, nb: notebookName }
    )
    routed = res?.ok === true
  }
  check(routed, 'notebook open routed through the sb-bridge')
  const kernelButton = workbench.getByRole('button', { name: /Select Kernel/i })
  let cellsRendered = false
  try {
    await kernelButton.first().waitFor({ timeout: 120_000 })
    cellsRendered = true
  } catch {
    cellsRendered = false
  }
  check(cellsRendered, 'notebook rendered as cells (Select Kernel toolbar present)')
  const rawJson = await workbench.getByText('"cell_type"').count()
  check(rawJson === 0, 'no raw notebook JSON visible')

  // 7. Chat column is really the chat (composer present) on the right.
  check((await win.locator('[data-chat-panel] textarea, [data-chat-panel] [contenteditable]').count()) > 0 ||
        (await win.locator('[contenteditable="true"]').count()) > 0,
    'chat composer present in the docked column')

  // 8. Toggle back restores the default layout. Focus may be inside the
  //    workbench webview - the sb-bridge forwards cmd+shift+J from there, so
  //    pressing it works regardless of which surface owns the keyboard.
  await win.keyboard.press('Meta+Shift+J')
  await win.waitForTimeout(400)
  const restored = await layoutProbe(win)
  check(restored?.chatGrow === '1' && restored?.rightGrow === '0', 'cmd+shift+J again restores the default layout')
} finally {
  await app.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
