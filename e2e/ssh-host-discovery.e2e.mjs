#!/usr/bin/env node

import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('out/main/index.js missing - run npm run build:fast first')
  process.exit(1)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'ssh-discovery-e2e-'))
const userDataDir = join(tempRoot, 'user-data')
const isolatedHome = join(tempRoot, 'home')
const sshDir = join(isolatedHome, '.ssh')
const sshConfig = join(sshDir, 'config')
let app

for (const path of [userDataDir, sshDir, join(tempRoot, 'tmp')]) {
  mkdirSync(path, { recursive: true })
}

const cleanup = () => rmSync(tempRoot, { recursive: true, force: true })
process.once('exit', cleanup)
process.once('SIGINT', () => process.exit(130))
process.once('SIGTERM', () => process.exit(143))

function config(includeLate = false) {
  return [
    'Host existing-box',
    '  HostName existing.example.com',
    '  User deploy',
    '',
    'Host new-box',
    '  HostName new.example.com',
    '  User ubuntu',
    ...(includeLate ? ['', 'Host late-box', '  HostName late.example.com', '  User ubuntu'] : []),
    '',
  ].join('\n')
}

writeFileSync(sshConfig, config())

function isolatedEnv() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/(API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET)$/i.test(key)) delete env[key]
  }
  return {
    ...env,
    HOME: isolatedHome,
    TMPDIR: join(tempRoot, 'tmp'),
    XDG_CONFIG_HOME: join(isolatedHome, '.config'),
    XDG_DATA_HOME: join(isolatedHome, '.local/share'),
    CLAUDE_CONFIG_DIR: join(isolatedHome, '.claude'),
    CODEX_HOME: join(isolatedHome, '.codex'),
    OPENCODE_CONFIG_DIR: join(isolatedHome, '.config/opencode'),
    SB_USER_DATA: userDataDir,
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  }
}

async function closeApp() {
  if (!app) return
  const closing = app
  app = undefined
  const closed = await Promise.race([
    closing.close().then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!closed) closing.process().kill('SIGKILL')
}

async function launch() {
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: isolatedEnv(),
  })
  const win = await app.firstWindow({ timeout: 20_000 })
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.machines, null, { timeout: 20_000 })
  const skipTour = win.getByRole('button', { name: 'Skip tour' })
  if (await skipTour.isVisible()) await skipTour.click()
  return win
}

function seedExistingMachine() {
  const now = Date.now()
  const sql = `INSERT INTO machines (
    id, name, ssh_alias, ssh_host, ssh_user, ssh_port, remote_user,
    transport_kind, sort_order, created_at, updated_at
  ) VALUES (
    'existing-machine', 'Existing', 'existing-box', 'existing.example.com',
    'deploy', 22, 'ubuntu', 'ssh', 0, ${now}, ${now}
  );`
  execFileSync('sqlite3', [join(userDataDir, 'data', 'switchboard.db'), sql])
}

async function openAddMachine(win) {
  await win.getByRole('button', { name: 'Create', exact: true }).click()
  await win.getByRole('menuitem', { name: /New machine/ }).click()
  const modal = win.locator('.machine-modal')
  await modal.waitFor({ state: 'visible' })
  await modal.getByText('Refreshing…').waitFor({ state: 'hidden', timeout: 10_000 })
  return modal
}

function check(condition, message) {
  if (!condition) throw new Error(message)
  console.log(`✓ ${message}`)
}

try {
  await launch()
  await closeApp()
  seedExistingMachine()

  const win = await launch()
  const pageErrors = []
  win.on('pageerror', (error) => pageErrors.push(error.message))

  let modal = await openAddMachine(win)
  const available = modal.locator('.machine-modal-hostlist').first()
  check(await available.getByText('new-box', { exact: true }).isVisible(), 'new SSH host is actionable')
  check(await available.getByText('existing-box', { exact: true }).count() === 0, 'saved host is absent from the actionable list')
  const added = modal.locator('.machine-modal-added')
  check(await added.locator('summary').textContent() === 'Already added (1)', 'saved hosts have a separate collapsed count')
  await added.locator('summary').click()
  check(await added.getByText('existing-box', { exact: true }).isVisible(), 'saved host remains discoverable in its disclosure')
  check(await modal.getByPlaceholder('Host (e.g. 10.0.0.4)').isVisible(), 'manual entry remains available')
  await modal.getByRole('button', { name: 'Cancel' }).click()
  await modal.waitFor({ state: 'detached' })

  writeFileSync(sshConfig, config(true))
  modal = await openAddMachine(win)
  check(await modal.getByText('late-box', { exact: true }).isVisible(), 'reopening rescans SSH config and shows a newly added host')
  check(pageErrors.length === 0, 'discovery flow produced no renderer errors')

  console.log('\nSSH HOST DISCOVERY E2E PASSED')
} catch (error) {
  console.error('\nSSH HOST DISCOVERY E2E FAILED')
  console.error(error)
  process.exitCode = 1
} finally {
  await closeApp()
}
