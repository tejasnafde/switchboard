#!/usr/bin/env node
/**
 * LIVE remote-workbench-bridge e2e. Pins the bug where cmd+shift+E toggled the
 * IDE pane ON but never back OFF on a remote machine: the VM's code-server had
 * no sb-bridge extension and no bridge listening, so an intent raised inside the
 * workbench webview had nothing to forward it to the desktop.
 *
 * Asserts, against a real VM:
 *   - the sb-bridge extension is seeded onto the remote --extensions-dir
 *   - the seed clears code-server's extensions.json (a manifest that omits
 *     sb-bridge marks it removed, which is how this silently breaks)
 *   - the ssh bootstrap handed the remote backend an SB_BRIDGE_PORT/TOKEN
 *   - the bridge is listening on that port, on the VM's loopback only
 *   - an intent sent from the VM reaches the DESKTOP renderer's handlers:
 *     terminal (the reported bug), dsmode, and selection
 *   - ide:open carrying machineId routes to the REMOTE bridge, not the local one
 *   - and finally, with the stand-in gone: a real workbench over the tunnel
 *     activates the SEEDED extension, and every real chord pressed in it
 *     (cmd+shift+E, cmd+shift+J, ctrl+`) reaches the desktop
 *
 * Two phases, deliberately. First a stand-in: a WebSocket client run on the VM
 * with code-server's own bundled node (v24, global WebSocket) speaking the same
 * protocol as resources/sb-bridge/extension.js. It isolates the transport -
 * bridge -> WsHost.emit -> ssh tunnel -> WsTransport -> TransportRouter ->
 * renderer - and can assert payloads precisely.
 *
 * Then the real thing, with the stand-in killed: a browser on the tunneled port
 * boots the actual remote workbench, whose extension host loads the SEEDED
 * extension and dials the same bridge. Pressing the real chord there is what
 * proves the two links the stand-in cannot: that code-server picks the
 * extension up at all, and that VS Code dispatches the chords to it. The
 * extension host runs on the VM either way, so this is the same path the app's
 * own <webview> drives.
 *
 * Chords are pressed in a retry loop after a settle delay: the first press can
 * land before the workbench's keybinding service is listening, which reads as a
 * routing failure and is not one.
 *
 * Needs SSH access (gcloud IAP for GeoIQ hosts). Run explicitly:
 *   SB_LIVE_REMOTE=1 SB_REMOTE_ALIAS=geoiq-ssg-bot-prod-in SB_REMOTE_USER=ubuntu \
 *     node e2e/remote-bridge.e2e.mjs
 */
import { _electron as electron, chromium } from 'playwright'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
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
/** Matches Machine.remoteUser: remote work runs as this user via sudo. */
const remoteUser = process.env.SB_REMOTE_USER || null

const repoRoot = process.cwd()
for (const rel of ['out/main/index.js', 'out/server/index.cjs']) {
  if (!existsSync(join(repoRoot, rel))) {
    console.error(`✗ ${rel} missing - run \`npm run build\` first`)
    process.exit(1)
  }
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

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=45']

/** Mirrors remoteExec.asUserScript: base64 so quoting survives ssh + sudo. */
function asUserScript(script) {
  const preamble = 'cd "$HOME" 2>/dev/null; export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"; '
  const payload = Buffer.from(preamble + script, 'utf8').toString('base64')
  const decode = `printf %s '${payload}' | base64 -d`
  return remoteUser ? `${decode} | sudo -n -H -u ${remoteUser} bash` : `${decode} | bash`
}

const onRemote = (script, timeout = 120_000) =>
  execFileSync('ssh', [...SSH_OPTS, alias, asUserScript(script)], { timeout }).toString()

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-remote-bridge-ud-'))
tempDirs.push(userDataDir)

// State before the app touches anything, so the assertions below describe a
// change this build caused rather than a leftover from an earlier run.
const before = onRemote('ls ~/.switchboard-server/ide-extensions 2>/dev/null || true')
console.log(`  (before: sb-bridge ${before.includes('switchboard.sb-bridge') ? 'present' : 'ABSENT'})`)

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

let relay = null
let browser = null
try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.machines, null, { timeout: 20_000 })

  const folder = '/home/' + (remoteUser || 'ubuntu')
  const created = await win.evaluate(
    (m) => window.api.machines.create({ name: 'e2e-bridge', sshAlias: m.alias, sshHost: m.alias, remoteUser: m.remoteUser }),
    { alias, remoteUser }
  )
  check(!!created?.id, `machine created (${created?.id})`)

  // Subscribe BEFORE connecting: these are the very handlers the reported bug
  // never reached (App.tsx wires the same three).
  await win.evaluate(() => {
    window.__ide = { terminal: 0, dsmode: 0, selections: [] }
    window.api.ide.onTerminalRequest(() => window.__ide.terminal++)
    window.api.ide.onDsModeRequest(() => window.__ide.dsmode++)
    window.api.ide.onSelection((msg) => window.__ide.selections.push(msg))
  })

  await win.evaluate((id) => {
    window.__statuses = []
    window.api.machines.onStatus((machineId, status, url, reason, willRetry, idePort) => {
      if (machineId !== id) return
      window.__statuses.push({ status, reason, idePort })
    })
    return window.api.machines.connect(id)
  }, created.id)

  // First connect provisions: bundle upload + npm install + code-server.
  let connected = null
  for (let i = 0; i < 420 && !connected; i++) {
    await win.waitForTimeout(1000)
    connected = await win.evaluate(() => window.__statuses.find((s) => s.status === 'connected') ?? null)
    if (i % 30 === 29) console.log(`  (waiting: ${JSON.stringify(await win.evaluate(() => window.__statuses.at(-1)))})`)
  }
  const trail = await win.evaluate(() => window.__statuses.map((s) => s.reason ?? s.status))
  console.log(`  (status trail: ${JSON.stringify(trail)})`)
  check(!!connected, 'machine connected')
  if (!connected) throw new Error('never connected - later checks would be meaningless')

  // Connect time: an upload to an IAP-tunneled host costs ~2 minutes no matter
  // how small it is (measured), so a remote that already has the current
  // payload must not be sent it again. The probe reports the marker; the seed
  // step should be absent from the trail entirely.
  if (before.includes('switchboard.sb-bridge')) {
    check(
      !trail.includes('seed workbench bridge extension'),
      'already-seeded remote: connect skipped the payload upload'
    )
  } else {
    console.log('  (remote was unseeded, so the seed step is expected in the trail)')
  }

  // ── The extension actually landed on the VM ──────────────────────────────
  const exts = onRemote('ls ~/.switchboard-server/ide-extensions')
  check(exts.includes('switchboard.sb-bridge-0.0.1'), 'sb-bridge extension seeded on the remote')
  // -A: the payload marker is a dotfile, which plain `ls` hides.
  const seeded = onRemote(
    'ls -A ~/.switchboard-server/ide-extensions/switchboard.sb-bridge-0.0.1 ~/.switchboard-server/ide-extensions/switchboard.sb-bridge-0.0.1/themes 2>/dev/null'
  )
  for (const f of ['package.json', 'extension.js', 'protocol.js', '.sb-marker']) {
    check(seeded.includes(f), `  seeded ${f}`)
  }
  check(seeded.includes('switchboard-charcoal-color-theme.json'), '  seeded the nested themes/ payload')

  // A manifest that omits sb-bridge marks it removed, so the seed must clear it.
  // code-server rebuilds it from a folder scan, so post-boot it either does not
  // exist yet or lists sb-bridge - never lists other extensions without it.
  const manifest = onRemote(
    'cat ~/.switchboard-server/ide-extensions/extensions.json 2>/dev/null || echo NO_MANIFEST'
  )
  check(
    manifest.includes('NO_MANIFEST') || manifest.includes('sb-bridge'),
    'extensions.json does not omit sb-bridge (cleared, or rebuilt including it)'
  )

  // ── The bootstrap handed the backend a token, and the bridge is up ───────
  const env = onRemote(
    'P="$(cat ~/.switchboard-server/server.pid)"; tr "\\0" "\\n" < /proc/$P/environ | grep -E "^SB_BRIDGE_(PORT|TOKEN)="'
  )
  const bridgePort = env.match(/^SB_BRIDGE_PORT=(\d+)$/m)?.[1]
  const bridgeToken = env.match(/^SB_BRIDGE_TOKEN=(.+)$/m)?.[1]
  check(!!bridgePort, `remote backend has SB_BRIDGE_PORT (${bridgePort})`)
  check(!!bridgeToken && bridgeToken.length >= 32, `remote backend has a minted SB_BRIDGE_TOKEN (${bridgeToken?.length} chars)`)

  const codeServerEnv = onRemote(
    'IP="$(cat ~/.switchboard-server/ide.pid)"; tr "\\0" "\\n" < /proc/$IP/environ | grep -E "^SB_BRIDGE_(PORT|TOKEN)="'
  )
  check(
    codeServerEnv.includes(`SB_BRIDGE_PORT=${bridgePort}`) && codeServerEnv.includes(`SB_BRIDGE_TOKEN=${bridgeToken}`),
    'code-server inherited the SAME port+token (its extension hosts dial with these)'
  )

  const listening = onRemote(`ss -ltn 2>/dev/null | grep ":${bridgePort}" || netstat -ltn 2>/dev/null | grep ":${bridgePort}" || echo NONE`)
  check(!listening.includes('NONE'), `bridge listening on ${bridgePort}`)
  check(listening.includes('127.0.0.1'), '  bound to loopback only (never tunneled)')

  // ── The reported bug: an intent from the VM must reach the desktop ───────
  const clientSrc = `
    const ws = new WebSocket('ws://127.0.0.1:${bridgePort}/?token=${bridgeToken}')
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', folder: ${JSON.stringify(folder)} }))
      ws.send(JSON.stringify({ type: 'terminal' }))
      ws.send(JSON.stringify({ type: 'dsmode' }))
      ws.send(JSON.stringify({ type: 'selection', path: ${JSON.stringify(folder + '/x.ts')}, startLine: 3, endLine: 9, text: 'sel', intent: 'edit' }))
      console.log('SENT')
      // Hold the socket so the folder stays registered for the ide:open check.
      setTimeout(() => process.exit(0), 60000)
    }
    ws.onerror = (e) => { console.log('WSERR ' + (e && e.message)); process.exit(1) }
  `
  // base64 the source rather than embedding it: a JSON-quoted program inside a
  // double-quoted `node -e "..."` leaves its \n sequences literal, which is a
  // syntax error in JS.
  const clientB64 = Buffer.from(clientSrc, 'utf8').toString('base64')
  const runClient =
    `printf %s '${clientB64}' | base64 -d > /tmp/sb-bridge-probe.mjs && ` +
    '~/.switchboard-server/code-server/lib/node /tmp/sb-bridge-probe.mjs'
  // Backgrounded: the client must stay connected while the desktop asserts.
  relay = spawn('ssh', [...SSH_OPTS, alias, asUserScript(runClient)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let relayOut = ''
  relay.stdout.on('data', (d) => (relayOut += d))
  relay.stderr.on('data', (d) => (relayOut += d))
  for (let i = 0; i < 30 && !relayOut.includes('SENT') && !relayOut.includes('WSERR'); i++) {
    await win.waitForTimeout(1000)
  }
  check(relayOut.includes('SENT'), `stand-in workbench connected to the remote bridge${relayOut.includes('WSERR') ? ` (${relayOut.trim()})` : ''}`)

  let got = { terminal: 0, dsmode: 0, selections: [] }
  for (let i = 0; i < 20; i++) {
    got = await win.evaluate(() => window.__ide)
    if (got.terminal > 0 && got.dsmode > 0 && got.selections.length > 0) break
    await win.waitForTimeout(500)
  }
  check(got.terminal > 0, 'TERMINAL intent reached the desktop (the cmd+shift+E toggle-off path)')
  check(got.dsmode > 0, 'DSMODE intent reached the desktop (cmd+shift+J)')
  check(got.selections.length > 0, 'SELECTION reached the desktop (cmd+l / cmd+k)')
  check(got.selections[0]?.intent === 'edit' && got.selections[0]?.startLine === 3, '  selection payload intact')

  // ── machineId routing: ide:open must reach the REMOTE bridge ─────────────
  // The stand-in hello'd for `folder`, so only the remote bridge can route it.
  // Routed to the local backend instead, this would come back ok:false.
  const opened = await win.evaluate(
    (a) => window.api.ide.open({ folder: a.folder, path: a.folder + '/x.ts', line: 4, machineId: a.machineId }),
    { folder, machineId: created.id }
  )
  check(opened?.ok === true, 'ide:open with machineId routed to the REMOTE bridge')

  const openedLocal = await win.evaluate(
    (a) => window.api.ide.open({ folder: a.folder, path: a.folder + '/x.ts', line: 4 }),
    { folder }
  )
  check(openedLocal?.ok === false, '  and without machineId it does NOT (stays local, as before)')

  // ── The real thing: the seeded extension, activated by a real workbench,
  //    reacting to real keystrokes ─────────────────────────────────────────
  // Everything above used a stand-in client, which proves the bridge but not
  // that code-server actually loads the seeded extension or that VS Code
  // dispatches the chord to it. Kill the stand-in so nothing it registered can
  // be mistaken for the real extension, then boot the REMOTE workbench over the
  // tunnel. Its extension host runs on the VM and dials the same bridge,
  // exactly as it does when the workbench is hosted in the app's own <webview>.
  relay.kill()
  relay = null
  await win.waitForTimeout(1000)

  const idePort = connected.idePort
  browser = await chromium.launch()
  const wb = await browser.newPage()
  await wb.goto(`http://127.0.0.1:${idePort}/?folder=${encodeURIComponent(folder)}`, { timeout: 120_000 })
  await wb.waitForSelector('.monaco-workbench', { timeout: 180_000 })
  check(true, 'remote workbench renders over the tunnel')

  // The seeded extension announcing its folder is what makes ide:open routable.
  // Nothing else can answer for this folder now that the stand-in is gone.
  let realHello = false
  for (let i = 0; i < 90 && !realHello; i++) {
    await win.waitForTimeout(1000)
    const res = await win.evaluate(
      (a) => window.api.ide.open({ folder: a.folder, path: a.folder, machineId: a.machineId }),
      { folder, machineId: created.id }
    )
    realHello = res?.ok === true
  }
  check(realHello, 'the SEEDED extension activated and dialed the remote bridge')

  // The reported bug, with a real keystroke.
  await win.evaluate(() => {
    window.__ide = { terminal: 0, dsmode: 0, selections: [] }
  })
  await wb.locator('.monaco-workbench').click()
  await wb.waitForTimeout(1500)

  /** Press `chord` in the workbench until `read` reports a hit, or give up. */
  const chordReaches = async (chord, read) => {
    for (let i = 0; i < 6; i++) {
      await wb.keyboard.press(chord)
      for (let j = 0; j < 6; j++) {
        await win.waitForTimeout(500)
        if (((await win.evaluate(read)) ?? 0) > 0) return i + 1
      }
    }
    return 0
  }

  const ePresses = await chordReaches('Meta+Shift+E', () => window.__ide.terminal)
  check(ePresses > 0, `REAL cmd+shift+E in the remote workbench reached the desktop${ePresses > 1 ? ` (took ${ePresses} presses)` : ''}`)

  const jPresses = await chordReaches('Meta+Shift+J', () => window.__ide.dsmode)
  check(jPresses > 0, `REAL cmd+shift+J in the remote workbench reached the desktop${jPresses > 1 ? ` (took ${jPresses} presses)` : ''}`)

  // ctrl+` is the third terminal-intent chord and the one the local e2e covers.
  await win.evaluate(() => {
    window.__ide.terminal = 0
  })
  const backtickPresses = await chordReaches('Control+`', () => window.__ide.terminal)
  check(backtickPresses > 0, 'REAL ctrl+` in the remote workbench reached the desktop')

  await win.evaluate((id) => window.api.machines.disconnect(id), created.id)
} finally {
  relay?.kill()
  await browser?.close()
  await app.close()
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
