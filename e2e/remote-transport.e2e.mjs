#!/usr/bin/env node
/**
 * End-to-end proof for Phase 1.5d: the *real* Electron app, launched with
 * SWITCHBOARD_BACKEND_URL set, routes data channels over the WebSocket to a
 * remote backend (HybridTransport → WsTransport → WsHost) instead of local IPC.
 *
 * A stub WsHost answers files:list-dir with a sentinel entry the local backend
 * would never return - so seeing it in the renderer proves the call crossed the
 * wire. Desktop-only channels still resolve to local IPC (unasserted here; unit
 * tested in hybrid-transport.test.ts).
 *
 * Run: npm run build && node e2e/remote-transport.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { WebSocketServer } from 'ws'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build` first')
  process.exit(1)
}

const SENTINEL = '__REMOTE_WS_SENTINEL__'
let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

// Minimal stub backend: enough to prove the renderer talks to it over WS.
const wss = new WebSocketServer({ port: 0 })
const seen = new Set()
wss.on('connection', (sock) => {
  sock.on('message', (data) => {
    const f = JSON.parse(data.toString())
    if (f.k !== 'req') return
    seen.add(f.ch)
    const result =
      f.ch === 'files:list-dir'
        ? { ok: true, entries: [{ name: SENTINEL, isDirectory: false, isGitignored: false }] }
        : { ok: true, entries: [], files: [] } // benign default for boot calls
    sock.send(JSON.stringify({ k: 'res', id: f.id, ok: true, result }))
  })
})
await new Promise((res) => wss.on('listening', res))
const port = wss.address().port
const backendUrl = `ws://localhost:${port}`

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-e2e-remote-'))
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    SWITCHBOARD_BACKEND_URL: backendUrl,
  },
})

try {
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await win.waitForFunction(() => !!window.api?.files?.listDir, null, { timeout: 20_000 })
  check(true, `app booted in remote mode (${backendUrl})`)

  const res = await win.evaluate((repo) => window.api.files.listDir(repo, ''), repoRoot)
  check(res?.ok && res.entries?.[0]?.name === '__REMOTE_WS_SENTINEL__', 'files:list-dir routed over WS to the remote backend (sentinel returned)')
  check(seen.has('files:list-dir'), 'stub backend received the files:list-dir request frame')
} catch (err) {
  console.error('✗ harness error:', err?.message ?? err)
  failures++
} finally {
  await app.close().catch(() => {})
  wss.close()
}

console.log(failures === 0 ? '\nREMOTE E2E PASSED' : `\nREMOTE E2E FAILED (${failures} check(s))`)
process.exit(failures === 0 ? 0 : 1)
