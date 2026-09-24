#!/usr/bin/env node
/**
 * Worktree-drift Follow flow, driven through the real UI: a project with a
 * real git worktree, a real thread, then a worktree.drift push (the exact
 * event the registry emits - the detection half is covered by the real-git
 * DriftWatcher integration test). Asserts the banner renders, Follow swaps
 * the session pointer, and the branch chip flips to the worktree's branch.
 *
 * Run: npm run build && node e2e/drift.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareElectronTestRuntime } from './electron-runtime.mjs'

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

// Real repo + a real worktree the "agent" drifts into.
const project = mkdtempSync(join(tmpdir(), 'sb-drift-proj-'))
const git = (args) => execFileSync('git', args, { cwd: project })
git(['init', '-q'])
git(['config', 'user.email', 't@t.io'])
git(['config', 'user.name', 't'])
writeFileSync(join(project, 'a.txt'), 'x')
git(['add', '-A'])
git(['commit', '-qm', 'init'])
const worktree = join(project, '.switchboard', 'worktrees', 'wt-e2e')
git(['worktree', 'add', '-q', '-b', 'fork/wt-e2e', worktree])

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-drift-ud-'))
// Launch from an isolated copy with Electron-ABI natives, so the repo's
// node_modules can stay on the Node ABI that vitest needs.
const electronRuntime = await prepareElectronTestRuntime({ repoRoot })
const app = await electron.launch({
  args: [electronRuntime.appPath, `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  if (process.env.SB_E2E_CONSOLE) {
    win.on('console', (m) => { const t = m.text(); if (/relocat|worktree|execution/i.test(t)) console.log(`  [renderer] ${t}`) })
  }
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  await win.evaluate((dir) => window.api.routing.invokeOn('local', 'app:add-project-path', dir), project)
  await win.evaluate(() => window.api.settings.set('tour.autoplay', 'false'))
  await win.evaluate(() => window.api.settings.set('sidebar.localTreeExpanded', 'true'))
  // Suppress the first-run analytics notice; it overlays the composer.
  await win.evaluate(() => window.api.settings.set('analytics.noticeSeen', 'true'))
  await win.reload()
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  await win.keyboard.press('Escape')

  const row = win.locator('.sidebar-project-header', { hasText: project.split('/').pop() }).first()
  await row.hover()
  await row.locator('.sidebar-project-compose').click({ force: true })
  // Compose now asks where to start. This flow wants the existing checkout;
  // the worktree it drifts into is created by this script, not by the app.
  // The options are real buttons; let Playwright auto-wait for one.
  await win.locator('button', { hasText: 'Project checkout' }).first().click({ timeout: 10_000 })
  await win.waitForTimeout(1500)
  if (process.env.SB_E2E_SHOT) await win.screenshot({ path: process.env.SB_E2E_SHOT })

  // threadId === conversationId for fresh threads.
  const conversations = await win.evaluate((dir) => window.api.app.getConversations(dir), project)
  const threadId = conversations?.[0]?.id
  check(!!threadId, `thread resolved (${threadId})`)

  // Push the exact event the registry's drift watcher emits.
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send('provider:event', payload)
  }, { type: 'worktree.drift', threadId, worktreePath: realpathSync(worktree), branch: 'fork/wt-e2e' })

  const banner = win.locator('[data-drift-banner]')
  let visible = false
  for (let i = 0; i < 10 && !visible; i++) {
    await win.waitForTimeout(500)
    visible = await banner.isVisible()
  }
  check(visible, 'drift banner appears with the worktree branch')
  check((await banner.textContent())?.includes('fork/wt-e2e') ?? false, 'banner names the branch')

  await banner.locator('button', { hasText: 'Follow' }).click()
  await win.waitForTimeout(500)
  check(!(await banner.isVisible()), 'Follow dismisses the banner (suggestion resolved)')

  // The one pointer everything derives from: the branch chip now polls the
  // WORKTREE's HEAD, so it flips to the fork branch within its 5s cadence.
  let chipText = ''
  for (let i = 0; i < 16 && !chipText.includes('wt-e2e'); i++) {
    await win.waitForTimeout(1000)
    chipText = (await win.locator('button[title="Switch branch"]').first().textContent().catch(() => '')) ?? ''
  }
  check(chipText.includes('wt-e2e'), `branch chip follows the worktree (shows: ${chipText.trim()})`)

  // Orphaned-worktree heal: an agent deletes the worktree the session
  // follows (post-merge cleanup). BranchPicker is push-based off the HEAD
  // watcher, and a deleted directory emits nothing, so the recovery rides
  // the 60s fallback poll. Wait past it rather than pretending it is fast.
  const mainBranch = execFileSync('git', ['branch', '--show-current'], { cwd: project }).toString().trim()
  rmSync(worktree, { recursive: true, force: true })
  let healedChip = ''
  for (let i = 0; i < 80 && !healedChip.includes(mainBranch); i++) {
    await win.waitForTimeout(1000)
    healedChip = (await win.locator('button[title="Switch branch"]').first().textContent().catch(() => '')) ?? ''
  }
  check(healedChip.includes(mainBranch), `deleted worktree heals back to the main clone (chip: ${healedChip.trim()})`)
  // The heal does append a system notice, but `MessageList` renders the
  // empty state while `turns.length === 0`, and a lone system message with no
  // user turn around it groups into no turn at all. So it is invisible in a
  // chat that never had a turn. Asserting the durable outcome below is both
  // stronger and not hostage to that grouping rule.
  if (process.env.SB_E2E_SHOT2) await win.screenshot({ path: process.env.SB_E2E_SHOT2 })
  // The durable proof the heal committed: the pointer is null again and the
  // revision advanced past the Follow.
  const healedRow = await win.evaluate((dir) => window.api.app.getConversations(dir), project)
  const healed = healedRow?.[0]
  check(!healed?.worktree_path, 'heal cleared the worktree pointer in the database')
  // `getConversations` returns a projection that never carried the column, so
  // read the revision the way the renderer hydrates it.
  const loaded = await win.evaluate((tid) => window.api.app.loadSessionById(tid), threadId)
  const rev = loaded?.meta?.executionRootRevision
  check((rev ?? 0) >= 2, `heal bumped the execution-root revision (${rev})`)
} finally {
  await app.close()
  rmSync(project, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  electronRuntime.cleanup()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
