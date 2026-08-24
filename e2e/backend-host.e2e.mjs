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
import { mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { prepareElectronTestRuntime } from './electron-runtime.mjs'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build` first')
  process.exit(1)
}

const electronRuntime = await prepareElectronTestRuntime({ repoRoot })
const userDataDir = mkdtempSync(join(tmpdir(), 'sb-e2e-'))
const worktreeProject = realpathSync(mkdtempSync(join(tmpdir(), 'sb-worktree-e2e-')))
const cleanup = () => {
  rmSync(userDataDir, { recursive: true, force: true })
  rmSync(worktreeProject, { recursive: true, force: true })
  electronRuntime.cleanup()
}
process.once('exit', cleanup)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))
let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const app = await electron.launch({
  args: [electronRuntime.appPath],
  cwd: repoRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    SB_USER_DATA: userDataDir,
  },
})

async function closeApp() {
  const closed = await Promise.race([
    app.close().then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!closed) app.process().kill('SIGKILL')
}

try {
  execFileSync('git', ['init', '-b', 'main'], { cwd: worktreeProject })
  execFileSync('git', ['config', 'user.email', 'switchboard-e2e@example.invalid'], { cwd: worktreeProject })
  execFileSync('git', ['config', 'user.name', 'Switchboard E2E'], { cwd: worktreeProject })
  writeFileSync(join(worktreeProject, 'README.md'), 'worktree transaction e2e\n')
  execFileSync('git', ['add', 'README.md'], { cwd: worktreeProject })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: worktreeProject })

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

  // Worktree transaction - crosses the real preload/IPC/main/SQLite/Git seam.
  // The duplicate call uses the exact same creationId and payload so it must
  // return the canonical operation without creating a second worktree/owner.
  const worktree = await win.evaluate(async (projectPath) => {
    const project = await window.api.routing.invokeOn('local', 'app:add-project-path', projectPath)
    const request = {
      schemaVersion: 1,
      creationId: 'e2e-worktree-creation-1',
      repository: { projectPath, machineId: 'local' },
      checkout: {
        baseRef: 'HEAD',
        branch: { namespace: 'sb', seed: 'backend-host-e2e' },
        location: 'managed-in-repo',
      },
      owner: {
        kind: 'conversation',
        conversationId: 'e2e-worktree-conversation-1',
        agentType: 'claude-code',
        title: 'Worktree E2E',
      },
      purpose: 'new-chat',
      setup: { policy: 'skip' },
      provenance: { surface: 'automation', machineId: 'local', requestedAt: 1_788_000_000_000 },
    }
    const first = await window.api.worktreeCreation.create(request)
    const duplicate = await window.api.worktreeCreation.create(request)
    const fetched = await window.api.worktreeCreation.get({ creationId: request.creationId, machineId: 'local' })
    const conversations = await window.api.app.getConversations(projectPath)
    return { project, first, duplicate, fetched, conversations }
  }, worktreeProject)
  check(worktree.project?.path === worktreeProject, 'worktree owner project is durably registered before creation')
  if (worktree.first?.status !== 'ready') {
    console.error('worktree transaction snapshot:', JSON.stringify(worktree.first, null, 2))
  }
  check(worktree.first?.status === 'ready' && !!worktree.first?.worktreeId, 'worktree transaction reaches ready through the real host')
  check(worktree.duplicate?.worktreeId === worktree.first?.worktreeId, 'same creationId returns the canonical worktree')
  check(worktree.fetched?.revision === worktree.first?.revision, 'durable creation is queryable after completion')
  check(
    worktree.conversations.filter((conversation) => conversation.id === 'e2e-worktree-conversation-1').length === 1,
    'worktree owner conversation is persisted exactly once',
  )

  await win.screenshot({ path: join(tmpdir(), 'sb-e2e-shot.png') }).catch(() => {})
} catch (err) {
  console.error('✗ harness error:', err?.message ?? err)
  failures++
} finally {
  await closeApp()
  cleanup()
}

console.log(failures === 0 ? '\nE2E PASSED' : `\nE2E FAILED (${failures} check(s))`)
process.exit(failures === 0 ? 0 : 1)
