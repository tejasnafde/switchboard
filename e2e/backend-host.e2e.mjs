#!/usr/bin/env node
/**
 * End-to-end check for the BackendHost refactor (Phase 1).
 *
 * Boots the *built* app under Playwright/Electron with an isolated
 * `--user-data-dir` (so the single-instance lock never collides with a
 * released build the user is running), then calls every migrated
 * window.api.* channel from the renderer. This exercises the real path -
 * preload Transport → IPC → ElectronIpcHost → registerXHandlers handler -
 * which unit tests can't, and is the thing that breaks if the seam is wrong.
 *
 * Run: npm run build && node e2e/backend-host.e2e.mjs
 * Requires a display (macOS desktop, or xvfb on Linux).
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build` first')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-e2e-'))
let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.files?.listAll, null, { timeout: 20_000 })
  check(true, 'app booted with BackendHost wiring (window loaded, window.api present)')

  // Call every migrated channel from the renderer, against the repo itself.
  const r = await win.evaluate(async (repo) => {
    const api = window.api
    return {
      listDir: await api.files.listDir(repo, ''),
      listAll: await api.files.listAll(repo),
      resolve: await api.files.resolve(repo, 'package.json'),
      branch: await api.git.currentBranch(repo),
      kanban: await api.kanban.list(repo),
      providers: await api.providerInstances.list(),
      // app.ts-migrated channels: settings round-trip + projects list
      settingsSet: await api.settings.set('sb-e2e-key', 'sb-e2e-val'),
      settingsGet: await api.settings.get('sb-e2e-key'),
      projects: await api.app.getProjects(),
    }
  }, repoRoot)

  // files
  check(r.listDir?.ok && Array.isArray(r.listDir.entries) && r.listDir.entries.length > 0, 'files:list-dir returns entries')
  check(r.listAll?.ok && r.listAll.files.includes('package.json'), 'files:list-all includes package.json')
  check(r.resolve?.ok && r.resolve.exists === true, 'files:resolve finds package.json')
  // git
  check(r.branch?.ok && typeof r.branch.branch === 'string', 'git:current-branch returns a branch')
  // kanban + provider-instances
  check(Array.isArray(r.kanban), 'kanban:list returns an array')
  check(Array.isArray(r.providers), 'provider-instances:list returns an array')
  // app.ts handlers (settings get/set, getProjects) route through the host seam
  check(r.settingsGet === 'sb-e2e-val', 'settings:set→get round-trips through the host seam')
  check(Array.isArray(r.projects), 'app:get-projects returns an array')

  // terminal - exercises host.emit + host.on (the streaming path) end to end:
  // create a pty, write a command, assert its output streams back.
  const termOut = await win.evaluate(
    (repo) =>
      new Promise((res) => {
        const id = 'e2e-term-1'
        let buf = ''
        const off = window.api.terminal.onOutput((tid, data) => {
          if (tid === id) buf += data
        })
        window.api.terminal.create({ id, cwd: repo, cols: 80, rows: 24 }).then(() => {
          setTimeout(() => window.api.terminal.write(id, 'echo SBE2E_OK\n'), 400)
          setTimeout(() => {
            off()
            window.api.terminal.kill(id)
            res(buf)
          }, 2000)
        })
      }),
    repoRoot,
  )
  check(typeof termOut === 'string' && termOut.includes('SBE2E_OK'), 'terminal create→write→onOutput streams (host.emit/on)')

  // provider-registry - proves the provider channels route through the migrated
  // host.handle seam. (A live instance-switch assertion needs real provider auth
  // / a mock adapter and lands with the WS-boundary phase.)
  const prov = await win.evaluate(async () => ({
    claude: await window.api.provider.isAvailable('claude'),
    codex: await window.api.provider.isAvailable('codex'),
  }))
  check(typeof prov.claude === 'boolean' && typeof prov.codex === 'boolean', 'provider:is-available round-trips through the host seam')

  await win.screenshot({ path: join(tmpdir(), 'sb-e2e-shot.png') }).catch(() => {})
} catch (err) {
  console.error('✗ harness error:', err?.message ?? err)
  failures++
} finally {
  await app.close().catch(() => {})
}

console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures} check(s))`)
process.exit(failures === 0 ? 0 : 1)
