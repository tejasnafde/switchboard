#!/usr/bin/env node
/**
 * LIVE remote-IDE e2e (the SSHed-notebooks use case): the app creates a
 * machine, connects (auto-provisioning the server bundle AND code-server on
 * the VM), and the tunnel's second -L forward serves the REMOTE workbench on
 * a stable local port. Asserts:
 *   - connect reaches 'connected' with an idePort in the status payload
 *   - the machine-store learned the idePort (IdePane's data source)
 *   - the forwarded port answers code-server's /healthz through the tunnel
 *   - the Jupyter extension stack is installed on the REMOTE
 *
 * Needs SSH access to the machine (gcloud IAP) and installs ~350MB under
 * ~/.switchboard-server on it. Run explicitly:
 *   SB_LIVE_REMOTE=1 SB_REMOTE_ALIAS=geoiq-ssg-bot-stg-in node e2e/remote-ide.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.SB_LIVE_REMOTE !== '1') {
  console.log('skipped - set SB_LIVE_REMOTE=1 (and SB_REMOTE_ALIAS) to run against a real VM')
  process.exit(0)
}
const alias = process.env.SB_REMOTE_ALIAS
if (!alias) {
  console.error('✗ SB_REMOTE_ALIAS is required')
  process.exit(1)
}

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js')) || !existsSync(join(repoRoot, 'out/server/index.cjs'))) {
  console.error('✗ build missing - run `npm run build` first')
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

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-remote-ide-ud-'))
tempDirs.push(userDataDir)

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.machines, null, { timeout: 20_000 })

  const created = await win.evaluate(
    (a) => window.api.machines.create({ name: 'e2e-remote', sshAlias: a, sshHost: a }),
    alias
  )
  check(!!created?.id, `machine created (${created?.id})`)

  await win.evaluate((id) => {
    window.__statuses = []
    window.api.machines.onStatus((machineId, status, url, reason, willRetry, idePort) => {
      if (machineId !== id) return
      window.__statuses.push({ status, reason, idePort })
    })
    return window.api.machines.connect(id)
  }, created.id)

  // Provisioning can take minutes on first connect (npm install + ~100MB
  // code-server download on the VM).
  let connected = null
  for (let i = 0; i < 420 && !connected; i++) {
    await win.waitForTimeout(1000)
    connected = await win.evaluate(() => window.__statuses.find((s) => s.status === 'connected') ?? null)
    if (i % 30 === 29) {
      const last = await win.evaluate(() => window.__statuses.at(-1))
      console.log(`  (waiting: ${JSON.stringify(last)})`)
    }
  }
  const statuses = await win.evaluate(() => window.__statuses)
  console.log(`  (status trail: ${JSON.stringify(statuses.map((s) => s.reason ?? s.status))})`)
  check(!!connected, 'machine connected')
  check(typeof connected?.idePort === 'number', `status carries the forwarded IDE port (${connected?.idePort})`)

  const idePorts = await win.evaluate(() => {
    // machine-store state is not on window; read through getStatuses instead
    return window.api.machines.getStatuses()
  })
  const idePort = Object.values(idePorts)[0]?.idePort
  check(typeof idePort === 'number', `getStatuses resync exposes idePort (${idePort})`)

  // The REMOTE workbench through the tunnel, from an arbitrary local process.
  let healthy = false
  for (let i = 0; i < 30 && !healthy; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${idePort}/healthz`)
      healthy = res.ok
    } catch {
      /* code-server still booting on the VM */
    }
    if (!healthy) await new Promise((r) => setTimeout(r, 2000))
  }
  check(healthy, 'remote code-server answers /healthz through the tunnel')

  // Extension stack landed on the VM.
  const remoteExts = execFileSync('ssh', ['-o', 'BatchMode=yes', alias, 'ls ~/.switchboard-server/ide-extensions 2>/dev/null'], {
    timeout: 60_000,
  }).toString()
  check(remoteExts.includes('ms-toolsai.jupyter-'), 'jupyter extension installed on the remote')
  check(remoteExts.includes('ms-python.python-'), 'python extension installed on the remote')

  await win.evaluate((id) => window.api.machines.disconnect(id), created.id)
} finally {
  await app.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
