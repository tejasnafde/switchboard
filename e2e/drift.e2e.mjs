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
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  await win.evaluate((dir) => window.api.routing.invokeOn('local', 'app:add-project-path', dir), project)
  await win.evaluate(() => window.api.settings.set('tour.autoplay', 'false'))
  await win.reload()
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  await win.keyboard.press('Escape')

  const row = win.locator('.sidebar-project-header', { hasText: project.split('/').pop() }).first()
  await row.hover()
  await row.locator('.sidebar-project-compose').click({ force: true })
  await win.waitForTimeout(1500)

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
} finally {
  await app.close()
  rmSync(project, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
