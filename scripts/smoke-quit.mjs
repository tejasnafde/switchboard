#!/usr/bin/env node
/**
 * Quit smoke test: launches the built app with `--smoke-quit` several times.
 * Each launch does a real startup in a throwaway profile, opens PTYs, file
 * watchers and the database (src/main/smoke-quit.ts), then quits the way a
 * user does. A launch passes only if the process exits 0 AND every teardown
 * step reported `ok`.
 *
 * Why several launches: the Windows quit crash (0xC0000005 after a clean
 * run) was intermittent - one release run failed, its rerun passed - so a
 * single launch proves little. better-sqlite3 13 and node-pty 1.1 are
 * N-API modules, so this runs on a plain `npm ci` with no Electron rebuild.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')
const mainBundle = resolve(repoRoot, 'out/main/index.js')
const runs = Number(process.env.SB_SMOKE_QUIT_RUNS ?? 5)
const EXPECTED_STEPS = ['terminals', 'providers', 'file-watchers', 'database']

if (!existsSync(mainBundle)) {
  console.error(`[smoke-quit] missing build output: ${mainBundle}`)
  process.exit(1)
}
const require = createRequire(import.meta.url)
const electronPath = require('electron')

const root = mkdtempSync(join(tmpdir(), 'sb-smoke-quit-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))

const project = join(root, 'project')
mkdirSync(join(project, '.switchboard'), { recursive: true })
writeFileSync(join(project, '.switchboard', 'launch-config.yaml'), 'windows: []\n')
execFileSync('git', ['init', '-q'], { cwd: project })

const isLinux = process.platform === 'linux'
const needsXvfb = isLinux && !process.env.DISPLAY
const TIMEOUT_MS = needsXvfb ? 90_000 : 60_000

function launch(run) {
  const electronArgs = [mainBundle, '--smoke-quit']
  if (isLinux) electronArgs.push('--no-sandbox')
  const command = needsXvfb ? 'xvfb-run' : electronPath
  const args = needsXvfb
    ? ['--auto-servernum', '--server-args=-screen 0 1024x768x24', electronPath, ...electronArgs]
    : electronArgs
  const env = {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    SB_USER_DATA: join(root, `profile-${run}`),
    SB_SMOKE_PROJECT: project,
    // macOS: keep the window from taking focus on a developer's machine.
    SB_E2E_BACKGROUND: '1',
  }
  // See smoke-test.mjs: presence alone flips Electron into node mode.
  delete env.ELECTRON_RUN_AS_NODE
  return new Promise((resolveRun) => {
    const started = Date.now()
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'inherit'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    const timer = setTimeout(() => {
      console.error(`[smoke-quit] run ${run} timed out after ${TIMEOUT_MS}ms`)
      child.kill('SIGKILL')
    }, TIMEOUT_MS)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ code, signal, stdout, ms: Date.now() - started })
    })
  })
}

function teardownProblems(stdout) {
  const line = stdout.split('\n').find((l) => l.includes('[smoke-quit] shutdown '))
  if (!line) return ['no teardown report - the quit teardown never finished']
  const reports = JSON.parse(line.slice(line.indexOf('[smoke-quit] shutdown ') + '[smoke-quit] shutdown '.length))
  const problems = reports.filter((r) => r.outcome !== 'ok').map((r) => `${r.name} ${r.outcome}`)
  for (const name of EXPECTED_STEPS) {
    if (!reports.some((r) => r.name === name)) problems.push(`${name} missing`)
  }
  return problems
}

let failures = 0
for (let run = 1; run <= runs; run++) {
  const { code, signal, stdout, ms } = await launch(run)
  const problems = code === 0 ? teardownProblems(stdout) : [`exit code=${code} signal=${signal}`]
  if (problems.length === 0) {
    console.log(`[smoke-quit] run ${run}/${runs} OK in ${ms}ms`)
  } else {
    failures++
    console.error(`[smoke-quit] run ${run}/${runs} FAILED: ${problems.join('; ')}`)
  }
}
if (failures > 0) {
  console.error(`[smoke-quit] FAILED ${failures} of ${runs} launches`)
  process.exit(1)
}
console.log(`[smoke-quit] OK - ${runs} launches quit cleanly`)
