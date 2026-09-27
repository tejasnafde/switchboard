#!/usr/bin/env node
/**
 * Post-build smoke test.
 *
 * Boots the freshly built `out/main/index.js` under Electron with
 * `--smoke-test`, which causes the main module to quit immediately
 * after `app.whenReady()`. Any import-time failure (e.g. ERR_REQUIRE_ESM
 * from an ESM-only dep getting CJS-required, native module ABI
 * mismatches, missing files in the bundle) crashes the process here
 * with a non-zero exit, blocking the `dist:*` chain.
 *
 * Why a separate script: prebuild (typecheck + vitest) verifies source
 * correctness, but vitest runs under Node's ESM resolver and never
 * actually loads the packaged CJS bundle. v0.1.16 shipped broken
 * because of exactly that gap - the SDK loaded fine in tests but the
 * packaged bundle's `require()` of an ESM-only dep crashed at launch.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const mainBundle = resolve(repoRoot, 'out/main/index.js')

if (!existsSync(mainBundle)) {
  console.error(`[smoke-test] missing build output: ${mainBundle}`)
  process.exit(1)
}

// Resolve the electron binary the same way npx would.
const require = createRequire(import.meta.url)
const electronPath = require('electron')
if (typeof electronPath !== 'string') {
  console.error('[smoke-test] could not resolve electron binary path')
  process.exit(1)
}

// On Linux CI the SUID sandbox helper (`chrome-sandbox`) needs to be owned
// by root with mode 4755. GitHub-hosted runners ship Electron in a path
// where neither condition holds, and Chromium aborts at startup rather
// than fall back to the non-SUID sandbox. Since this is a one-shot boot
// check (we exit at `app.whenReady()` before any renderer loads), running
// without the sandbox is safe and matches how `electron-builder`'s own
// post-pack tests behave on the same runners.
//
// Headless ubuntu-latest runners also have no X server - Chromium's
// ozone/x11 backend aborts ("Missing X server or $DISPLAY") before
// `app.whenReady()` fires. Wrap under `xvfb-run` (preinstalled on
// ubuntu-latest) when DISPLAY is missing.
const isLinux = process.platform === 'linux'
const needsXvfb = isLinux && !process.env.DISPLAY
const electronArgs = [mainBundle, '--smoke-test']
if (isLinux) electronArgs.push('--no-sandbox')

const command = needsXvfb ? 'xvfb-run' : electronPath
const args = needsXvfb
  ? ['--auto-servernum', '--server-args=-screen 0 1024x768x24', electronPath, ...electronArgs]
  : electronArgs

const electronEnv = {
  ...process.env,
  ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
}
// The variable controls Electron by its presence. On Windows, preserving it
// with an empty value still enters Electron 43's Node bootstrap and aborts
// before the main bundle loads because the browser snapshot is unavailable.
delete electronEnv.ELECTRON_RUN_AS_NODE

// Windows launches several times: the quit-time crash this caught
// (0xC0000005 in Chromium's sandbox broker, see the note in main/index.ts)
// hit about one launch in fifteen, so a single launch let it through.
const runs = Number(process.env.SB_SMOKE_RUNS ?? (process.platform === 'win32' ? 5 : 1))

// A throwaway profile: the quit teardown logs, and that must not land in the
// real app's logs folder or contend for its single-instance lock.
const scratch = mkdtempSync(join(tmpdir(), 'sb-smoke-'))
electronEnv.SB_USER_DATA = join(scratch, 'profile')
// Any crash leaves a local minidump here; CI uploads the folder on failure.
const dumpDir = process.env.SB_SMOKE_CRASH_DIR ?? join(scratch, 'dumps')
electronEnv.SB_SMOKE_CRASH_DIR = dumpDir

// Under xvfb a cold runner can take most of 30s just to bring up the X
// server and Chromium: CI run 35994904488 reached app.whenReady() at 29.2s
// and was killed before it could exit. The check is whether main boots, not
// how fast a shared runner is, so give xvfb the headroom.
const TIMEOUT_MS = needsXvfb ? 90_000 : 30_000

function launch() {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: electronEnv,
    })
    const timer = setTimeout(() => {
      console.error(`[smoke-test] timed out after ${TIMEOUT_MS}ms - main never reached app.whenReady()`)
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal })
    })
  })
}

for (let run = 1; run <= runs; run++) {
  const { code, signal } = await launch()
  if (code !== 0) {
    console.error(`[smoke-test] FAILED on launch ${run} of ${runs} (code=${code}, signal=${signal})`)
    const dumps = existsSync(dumpDir) ? readdirSync(dumpDir, { recursive: true }).filter((f) => String(f).endsWith('.dmp')) : []
    if (dumps.length > 0) console.error(`[smoke-test] minidumps in ${dumpDir}: ${dumps.join(', ')}`)
    process.exit(code ?? 1)
  }
}
rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
console.log(`[smoke-test] OK - packaged main bundle boots and quits cleanly (${runs} launch${runs === 1 ? '' : 'es'})`)
