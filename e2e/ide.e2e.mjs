#!/usr/bin/env node
/**
 * End-to-end probe for the embedded IDE (code-server) stack.
 *
 * Boots the *built* app under Playwright/Electron with an isolated
 * --user-data-dir, then drives the real path from the renderer:
 *   ide.ensure(repo) → binary resolve (download on a cold dir!), extension
 *   seeding, bridge WebSocketServer, code-server spawn, /healthz → ready.
 * Asserts the workbench URL serves HTML, the sb-bridge extension landed in
 * the extensions dir, idle-stop works, and the app log carries ide: scopes
 * with no ide-scoped errors.
 *
 * Opt-in (downloads ~100MB on first run): SB_IDE_PROBE=1 node e2e/ide.e2e.mjs
 * Requires `npm run build` first and a display.
 */
import { _electron as electron, chromium } from 'playwright'
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs'
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

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-ide-e2e-'))
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
  await win.waitForFunction(() => !!window.api?.ide?.ensure, null, { timeout: 20_000 })
  check(true, 'app booted, window.api.ide present')

  // Collect status pushes while ensure runs.
  await win.evaluate(() => {
    window.__ideStatuses = []
    window.api.ide.onStatus((p) => window.__ideStatuses.push(p.status))
  })

  // The real boot: cold userData → download, seed, spawn, healthz.
  console.log('  (ensure may download the code-server tarball - allow a few minutes)')
  const ensure = await win.evaluate(
    (repo) => window.api.ide.ensure(repo),
    repoRoot,
  )
  check(ensure?.ok === true && Number.isInteger(ensure.port), `ide:ensure ok on port ${ensure?.port}`)
  if (!ensure?.ok) throw new Error(`ensure failed: ${ensure?.error}`)

  const statuses = await win.evaluate(() => window.__ideStatuses)
  check(statuses.includes('ready'), `status events include ready (${JSON.stringify(statuses)})`)

  const healthz = await fetch(`http://127.0.0.1:${ensure.port}/healthz`)
  check(healthz.ok, 'GET /healthz from outside the app returns 200')

  const workbench = await fetch(
    `http://127.0.0.1:${ensure.port}/?folder=${encodeURIComponent(repoRoot)}`,
  )
  const html = await workbench.text()
  check(workbench.ok && /vscode|workbench/i.test(html), 'workbench URL serves the VS Code shell')

  const seeded = join(userDataDir, 'code-server', 'extensions', 'switchboard.sb-bridge-0.0.1', 'package.json')
  check(existsSync(seeded), 'sb-bridge extension seeded into the extensions dir')

  // Second ensure reuses the same server (one process per app).
  const again = await win.evaluate((repo) => window.api.ide.ensure(repo), repoRoot)
  check(again?.ok === true && again.port === ensure.port, 'second ensure reuses the same port')

  // open() with no connected workbench ext host routes nowhere - and says so.
  const open = await win.evaluate(
    (repo) => window.api.ide.open({ folder: repo, path: 'package.json', line: 1 }),
    repoRoot,
  )
  check(open?.ok === false, 'ide:open reports not-routed with no connected workbench')

  // Connect a REAL workbench client: each connection spawns an extension
  // host, which activates sb-bridge, which dials the bridge and sends hello.
  // Once registered, ide:open routes.
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${ensure.port}/?folder=${encodeURIComponent(repoRoot)}`)
  let routed = false
  for (let i = 0; i < 60 && !routed; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const res = await win.evaluate(
      (repo) => window.api.ide.open({ folder: repo, path: 'package.json', line: 3 }),
      repoRoot,
    )
    routed = res?.ok === true
  }
  check(routed, 'sb-bridge hello registered; ide:open routes to the live workbench')
  await browser.close()

  // Idle shutdown path.
  const stop = await win.evaluate(() => window.api.ide.stop())
  check(stop?.ok === true, 'ide:stop returns ok')
  const deadHealth = await fetch(`http://127.0.0.1:${ensure.port}/healthz`).then(
    () => true,
    () => false,
  )
  check(deadHealth === false, 'server is gone after stop (healthz connection refused)')

  // Logs: ide scopes present, no ide-scoped error lines.
  const logDir = join(userDataDir, 'logs')
  const logFile = readdirSync(logDir).find((f) => f.endsWith('.log'))
  const log = readFileSync(join(logDir, logFile), 'utf8')
  // File format is `<ts> [LVL] [scope] msg` (the SB: prefix is console-only).
  check(/\[(INF|DBG)\] \[(ide:binary|ipc:ide|ide:bridge)\]/.test(log), 'app log carries ide: scopes')
  const ideErrors = log.split('\n').filter((l) => /\[ERR\] \[(ide|ipc:ide)/.test(l))
  check(ideErrors.length === 0, `no ide-scoped ERR lines (${ideErrors.length})`)
} finally {
  await app.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
