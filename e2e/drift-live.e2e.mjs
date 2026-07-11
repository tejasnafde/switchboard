#!/usr/bin/env node
/**
 * LIVE worktree-drift probe: a real Claude agent in a throwaway repo is asked
 * to `git worktree add` via shell and write a file via SHELL REDIRECT only -
 * the pure command-signal path (claude emits no tool.completed, so this
 * exercises the deferred next-event flush).
 * Asserts the registry's drift detection fires a worktree.drift event for
 * the session - the full production path: SDK -> adapter -> tool events ->
 * DriftWatcher -> bus -> renderer push. (The banner UI half is covered by
 * e2e/drift.e2e.mjs; this proves the detection half with a real agent.)
 *
 * Uses real Claude credentials and costs a few cents:
 *   SB_LIVE_AGENT=1 node e2e/drift-live.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.SB_LIVE_AGENT !== '1') {
  console.log('skipped - set SB_LIVE_AGENT=1 to run (drives a real Claude agent turn)')
  process.exit(0)
}

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build` first')
  process.exit(1)
}

let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const project = mkdtempSync(join(tmpdir(), 'sb-drift-live-'))
const git = (args) => execFileSync('git', args, { cwd: project })
git(['init', '-q'])
git(['config', 'user.email', 't@t.io'])
git(['config', 'user.name', 't'])
writeFileSync(join(project, 'README.md'), '# scratch\n')
git(['add', '-A'])
git(['commit', '-qm', 'init'])

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-drift-live-ud-'))
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.provider?.startSession, null, { timeout: 20_000 })

  const threadId = `agent_live_${Math.floor(Math.random() * 1e9)}`
  const wtName = `sb-live-wt-${Math.floor(Math.random() * 1e6)}`

  // Subscribe BEFORE the turn; collect every event type for diagnostics.
  await win.evaluate((tid) => {
    window.__drift = null
    window.__toolNames = []
    window.api.provider.onEvent((e) => {
      if (e.threadId !== tid) return
      if (e.type === 'worktree.drift') window.__drift = e
      if (e.type === 'tool.started') window.__toolNames.push(e.toolName)
    })
  }, threadId)

  const started = await win.evaluate(
    (opts) => window.api.provider.startSession(opts),
    { threadId, provider: 'claude', cwd: project, runtimeMode: 'full-access' },
  )
  check(started?.ok !== false, 'live claude session started')

  await win.evaluate(
    ({ tid, msg }) => window.api.provider.sendTurn(tid, msg, 'full-access'),
    {
      tid: threadId,
      msg:
        `Run exactly these two steps using ONLY your shell (Bash) tool - do not use any file-write tool, no questions: ` +
        `1) git worktree add /tmp/${wtName} -b drift-test/${wtName} ` +
        `2) echo "drift probe" > /tmp/${wtName}/notes.md ` +
        `Then stop.`,
    },
  )

  // A live turn takes a while; the drift event can arrive from either signal
  // (command completion or the write tool).
  let drift = null
  for (let i = 0; i < 120 && !drift; i++) {
    await win.waitForTimeout(1000)
    drift = await win.evaluate(() => window.__drift)
  }
  const toolNames = await win.evaluate(() => window.__toolNames)
  console.log(`  (agent tools observed: ${JSON.stringify(toolNames)})`)
  check(!!drift, 'worktree.drift event fired from a REAL agent turn')
  check(drift?.worktreePath?.includes(wtName) ?? false, `drift points at the worktree (${drift?.worktreePath})`)
  check(drift?.branch === `drift-test/${wtName}`, `drift names the branch (${drift?.branch})`)
} finally {
  await app.close()
  rmSync(project, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
