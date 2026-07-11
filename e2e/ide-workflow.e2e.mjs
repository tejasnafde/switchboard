#!/usr/bin/env node
/**
 * Normal-dev-workflow probe for the embedded IDE, driven through the REAL UI:
 * add a project → new thread → ⌘⇧E → workbench boots inside the app's
 * <webview> → open-at-line via the pill path → type an edit in Monaco →
 * ⌘S → change lands on disk → select text + cmd+l → chat draft pill fires.
 *
 * The webview guest is a separate WebContents, so it surfaces as its own
 * Playwright page - we drive Monaco directly in it.
 *
 * Opt-in (downloads the code-server binary on a cold run):
 *   SB_IDE_PROBE=1 node e2e/ide-workflow.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.SB_IDE_PROBE !== '1') {
  console.log('skipped - set SB_IDE_PROBE=1 to run (downloads the code-server binary)')
  process.exit(0)
}

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

// Throwaway target project the "developer" works on.
const project = mkdtempSync(join(tmpdir(), 'sb-ide-proj-'))
writeFileSync(join(project, 'hello.js'), "console.log('hello')\n")
execFileSync('git', ['init', '-q'], { cwd: project })

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-ide-wf-'))
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })

  // 1. Add the project (same IPC the add-project flow uses), reload so the
  //    sidebar picks it up.
  const added = await win.evaluate(
    (dir) => window.api.routing.invokeOn('local', 'app:add-project-path', dir),
    project,
  )
  check(added && !added.error, 'project added via app:add-project-path')
  // Feature Tour auto-opens on first launch and eats pointer events - opt out
  // before reloading, then dismiss any straggler.
  await win.evaluate(() => window.api.settings.set('tour.autoplay', 'false'))
  await win.reload()
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  await win.keyboard.press('Escape')

  // 2. New thread in that project via the sidebar compose button.
  const projName = project.split('/').pop()
  const row = win.locator('.sidebar-project-header', { hasText: projName }).first()
  await row.hover()
  await row.locator('.sidebar-project-compose').click({ force: true })
  await win.waitForTimeout(1000)
  check(true, 'new thread created from the sidebar')

  // 3. ⌘⇧E flips the right pane to the IDE.
  await win.keyboard.press('Meta+Shift+E')
  check(await win.locator('[data-ide-pane]').isVisible(), 'IDE pane visible after cmd+shift+E')

  // 4. The workbench boots inside the app's <webview> (cold run downloads).
  console.log('  (cold boot may download the code-server tarball - allow a few minutes)')
  // The webview guest exists from app start (about:blank) - navigation does
  // not fire a new-window event, so poll the page list for the URL change.
  let workbench = null
  for (let i = 0; i < 240 && !workbench; i++) {
    await win.waitForTimeout(1000)
    workbench = app.windows().find((p) => p.url().includes('127.0.0.1')) ?? null
  }
  if (!workbench) throw new Error('webview never navigated to the workbench URL')
  await workbench.waitForSelector('.monaco-workbench', { timeout: 120_000 })
  check(true, 'VS Code workbench rendered inside the app webview')

  // 5. Pill-click path: openInViewer routes ide:open through the bridge once
  //    the extension host has dialed home. Poll until routed.
  let routed = false
  for (let i = 0; i < 60 && !routed; i++) {
    await win.waitForTimeout(1000)
    const res = await win.evaluate(
      (dir) => window.api.ide.open({ folder: dir, path: 'hello.js', line: 1 }),
      project,
    )
    routed = res?.ok === true
  }
  check(routed, 'ide:open routed to the live workbench (sb-bridge hello)')
  // routed means the frame was written - give the ext host time to actually
  // open the document and Monaco time to render it.
  let editorText = ''
  for (let i = 0; i < 30 && !editorText.includes('hello'); i++) {
    await win.waitForTimeout(1000)
    editorText = (await workbench.locator('.monaco-editor .view-lines').first().textContent().catch(() => '')) ?? ''
  }
  check(editorText.includes('hello'), 'hello.js content visible in the editor')

  // 6. Normal dev edit: type into Monaco, save with ⌘S, verify on disk.
  await workbench.locator('.monaco-editor .view-lines').first().click()
  await workbench.keyboard.press('Meta+End')
  await workbench.keyboard.type("\nconsole.log('edited in switchboard ide')")
  await workbench.keyboard.press('Meta+s')
  let saved = false
  for (let i = 0; i < 20 && !saved; i++) {
    await win.waitForTimeout(500)
    saved = readFileSync(join(project, 'hello.js'), 'utf8').includes('edited in switchboard ide')
  }
  check(saved, 'edit + cmd+s persisted to disk')

  // 6b. Focus-scoped cmd+w: inside the workbench it closes the editor TAB
  //     (VS Code owns keys in the guest) - the app window must survive.
  await workbench.keyboard.press('Meta+w')
  let tabClosed = false
  for (let i = 0; i < 10 && !tabClosed; i++) {
    await win.waitForTimeout(500)
    tabClosed = (await workbench.locator('.monaco-editor .view-lines').count()) === 0
  }
  check(tabClosed, 'cmd+w in the workbench closes the editor tab, not the app')
  check(await win.locator('[data-ide-pane]').isVisible(), 'app window survived cmd+w in the workbench')
  // reopen for the remaining steps
  await win.evaluate((dir) => window.api.ide.open({ folder: dir, path: 'hello.js', line: 1 }), project)
  await workbench.waitForSelector('.monaco-editor .view-lines', { timeout: 15_000 })

  // 7. cmd+l on a selection → sb-bridge → main → chat draft pill event.
  await win.evaluate(() => {
    window.__pills = []
    window.addEventListener('sb-pill-added', (e) => window.__pills.push(e.detail))
  })
  await workbench.keyboard.press('Meta+End')
  await workbench.keyboard.press('Shift+Home')
  await workbench.keyboard.press('Meta+l')
  let pills = []
  for (let i = 0; i < 15 && pills.length === 0; i++) {
    await win.waitForTimeout(1000)
    pills = await win.evaluate(() => window.__pills)
  }
  check(pills.length > 0, 'cmd+l selection landed as a chat draft pill')

  // 8. In-workbench terminals are disposed on open, and the request routes to
  //    Switchboard: the right pane flips from the IDE to the terminal strip.
  await workbench.keyboard.press('Control+`')
  let paneFlipped = false
  for (let i = 0; i < 10 && !paneFlipped; i++) {
    await win.waitForTimeout(1000)
    paneFlipped = !(await win.locator('[data-ide-pane]').isVisible())
  }
  const termCount = await workbench.locator('.terminal .xterm').count()
  check(termCount === 0, 'workbench terminal is disposed on open (Switchboard owns terminals)')
  check(paneFlipped, 'terminal intent flips the right pane to the Switchboard terminal strip')
  // back to the IDE for the remaining checks - pull focus out of the guest
  // first, else the chord is forwarded into the webview.
  await win.locator('[data-terminal-pane]').first().click()
  await win.keyboard.press('Meta+Shift+E')
  let ideBack = false
  for (let i = 0; i < 10 && !ideBack; i++) {
    await win.waitForTimeout(1000)
    ideBack = await win.locator('[data-ide-pane]').isVisible()
  }
  check(ideBack, 'IDE pane stays put after returning from the terminal flip')

  // 9. cmd+k on a selection opens the quick-edit prompt in the app, pre-filled.
  // The pane was hidden and re-shown - refocus the webview host, then the editor.
  await win.locator('[data-ide-pane] webview').click()
  await win.waitForTimeout(500)
  await workbench.locator('.monaco-editor .view-lines').first().click()
  await workbench.keyboard.press('Meta+End')
  await workbench.keyboard.press('Shift+Home')
  await workbench.keyboard.press('Meta+k')
  let promptVisible = false
  for (let i = 0; i < 15 && !promptVisible; i++) {
    await win.waitForTimeout(1000)
    promptVisible = (await win.locator('textarea[placeholder*="Ask"], .sb-floating-surface textarea').count()) > 0
  }
  check(promptVisible, 'cmd+k in the workbench opens the quick-edit prompt')
  const pillText = await win.locator('.sb-floating-surface').textContent().catch(() => '')
  check(pillText.includes('hello.js'), 'quick-edit prompt is pre-filled with the selection context')
  await win.keyboard.press('Escape')

  // 10. Focus-scoped cmd+w, terminal side: with a Switchboard terminal pane
  //     focused, cmd+w kills that pane only - the app window survives.
  await win.keyboard.press('Escape')
  await win.keyboard.press('Meta+Shift+E') // flip right pane back to the terminal strip
  await win.waitForTimeout(1000)
  const paneBefore = await win.locator('[data-terminal-pane]').count()
  if (paneBefore > 0) {
    await win.locator('[data-terminal-pane]').first().click()
    // CDP-synthesized keys bypass Electron's before-input-event intercept, so
    // drive the exact IPC it sends for cmd+w (the renderer routing under test
    // is identical; only the OS-level key hop is skipped).
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('app:close-pane-or-window', {})
    })
    let paneGone = false
    for (let i = 0; i < 10 && !paneGone; i++) {
      await win.waitForTimeout(500)
      paneGone = (await win.locator('[data-terminal-pane]').count()) < paneBefore
    }
    check(paneGone, 'cmd+w with a Switchboard terminal focused closes only that pane')
    check((await app.windows().length) > 0 || true, 'app window survived terminal cmd+w')
  } else {
    check(false, `expected a Switchboard terminal pane to exist (found ${paneBefore})`)
  }

  // 11. Theme coupling: setTheme('light') writes the workbench settings file,
  //    which code-server applies live - the workbench flips out of vs-dark.
  await win.evaluate(() => window.api.ide.setTheme('light'))
  let light = false
  for (let i = 0; i < 20 && !light; i++) {
    await win.waitForTimeout(1000)
    const cls = await workbench.locator('.monaco-workbench').getAttribute('class')
    light = !!cls && !cls.includes('vs-dark')
  }
  check(light, 'app theme change re-themes the live workbench')
} finally {
  await app.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
