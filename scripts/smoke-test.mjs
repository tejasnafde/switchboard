#!/usr/bin/env node
/**
 * Post-build smoke test.
 *
 * Boots the freshly built `out/main/index.js` under Electron with
 * `--smoke-test`, which causes the main module to exit 0 immediately
 * after `app.whenReady()`. Any import-time failure (e.g. ERR_REQUIRE_ESM
 * from an ESM-only dep getting CJS-required, native module ABI
 * mismatches, missing files in the bundle) crashes the process here
 * with a non-zero exit, blocking the `dist:*` chain.
 *
 * Why a separate script: prebuild (typecheck + vitest) verifies source
 * correctness, but vitest runs under Node's ESM resolver and never
 * actually loads the packaged CJS bundle. v0.1.16 shipped broken
 * because of exactly that gap — the SDK loaded fine in tests but the
 * packaged bundle's `require()` of an ESM-only dep crashed at launch.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
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
// Headless ubuntu-latest runners also have no X server — Chromium's
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

const child = spawn(command, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    // Avoid surprises from the parent shell; this is just a boot check.
    ELECTRON_RUN_AS_NODE: '',
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
  },
})

const TIMEOUT_MS = 30_000
const timer = setTimeout(() => {
  console.error(`[smoke-test] timed out after ${TIMEOUT_MS}ms — main never reached app.whenReady()`)
  child.kill('SIGKILL')
  process.exit(1)
}, TIMEOUT_MS)

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  if (code === 0) {
    console.log('[smoke-test] OK — packaged main bundle boots cleanly')
    process.exit(0)
  }
  console.error(`[smoke-test] FAILED (code=${code}, signal=${signal})`)
  process.exit(code ?? 1)
})
