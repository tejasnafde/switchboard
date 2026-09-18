#!/usr/bin/env node
/**
 * LIVE execution-root relocation: does Follow actually move a REAL agent?
 *
 * Every other test stops short of this. The unit suite fakes the host, and
 * e2e/drift.e2e.mjs relocates a thread with no adapter attached - both prove
 * the transaction, neither proves that a running provider is stopped and
 * restarted in the new directory with its conversation intact.
 *
 * So this one drives a real agent, twice:
 *
 *   1. a turn in the project checkout, to get a live adapter and a native
 *      session id;
 *   2. the relocation;
 *   3. a second turn that writes `pwd` to a file.
 *
 * The file is the proof. It can only land in the worktree if the provider
 * process is actually executing there. The native session id is compared
 * across the move, because a relocation that silently started a fresh
 * conversation would otherwise look identical.
 *
 * Costs real tokens on both providers:
 *   SB_LIVE_AGENT=1 node e2e/execution-root-live.e2e.mjs
 *   SB_LIVE_AGENT=1 SB_LIVE_ONLY=codex node e2e/execution-root-live.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareElectronTestRuntime } from './electron-runtime.mjs'

if (process.env.SB_LIVE_AGENT !== '1') {
  console.log('skipped - set SB_LIVE_AGENT=1 to run (drives real agent turns on both providers)')
  process.exit(0)
}

const repoRoot = process.cwd()
if (!existsSync(join(repoRoot, 'out/main/index.js'))) {
  console.error('✗ out/main/index.js missing - run `npm run build` first')
  process.exit(1)
}

// Credential homes, so this never depends on whatever the desktop app is
// currently pointed at.
const CLAUDE_CONFIG_DIR = '/Users/tejas/.claude-tech-team'
const CODEX_HOME = '/Users/tejas/.codex-default'

let failures = 0
const check = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`)
  if (!cond) failures++
}

const only = process.env.SB_LIVE_ONLY
const PROVIDERS = [
  { provider: 'claude', agentType: 'claude-code', home: CLAUDE_CONFIG_DIR },
  { provider: 'codex', agentType: 'codex', home: CODEX_HOME },
].filter((p) => !only || p.provider === only)

for (const { provider, agentType, home } of PROVIDERS) {
  console.log(`\n── ${provider} (credentials: ${home}) ──`)
  if (!existsSync(home)) {
    check(false, `credential home exists (${home})`)
    continue
  }

  // Real repo, real worktree. realpath up front: macOS /var is a symlink to
  // /private/var, and comparing the two spellings is its own class of bug.
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'sb-exec-live-')))
  const git = (args) => execFileSync('git', args, { cwd: project })
  git(['init', '-q'])
  git(['config', 'user.email', 't@t.io'])
  git(['config', 'user.name', 't'])
  writeFileSync(join(project, 'a.txt'), 'x')
  git(['add', '-A'])
  git(['commit', '-qm', 'init'])
  const worktree = join(project, '.switchboard', 'worktrees', 'live-wt')
  git(['worktree', 'add', '-q', '-b', 'live/exec-root', worktree])
  const worktreeReal = realpathSync(worktree)

  const userDataDir = mkdtempSync(join(tmpdir(), 'sb-exec-live-ud-'))
  const runtime = await prepareElectronTestRuntime({ repoRoot })
  const app = await electron.launch({
    args: [runtime.appPath, `--user-data-dir=${userDataDir}`],
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      CLAUDE_CONFIG_DIR,
      CODEX_HOME,
    },
  })

  let win
  try {
    win = await app.firstWindow()
    await win.waitForFunction(() => !!window.api?.provider?.startSession, null, { timeout: 30_000 })

    // A fresh user-data-dir has no provider instances, so the registry would
    // fall back to the default credential home and the agent answers "Not
    // logged in". Register the account explicitly - `oauth_dir` is the
    // supported way to point a session at a credential home.
    const instance = await win.evaluate(
      (i) => window.api.providerInstances.upsert(i),
      { agentType, displayName: `live-${provider}`, authMode: 'oauth_dir', oauthDir: home, enabled: true },
    )
    check(!!instance?.id, `registered a credential home (${instance?.effectiveOauthDir ?? instance?.oauthDir})`)

    const threadId = `agent_live_${Date.now()}`
    await win.evaluate((dir) => window.api.routing.invokeOn('local', 'app:add-project-path', dir), project)
    await win.evaluate(
      (p) => window.api.app.createConversation({ id: p.id, projectPath: p.dir, agentType: p.agentType }),
      { id: threadId, dir: project, agentType },
    )

    // Collect the signals we assert on. `session` carries the native id the
    // relocation has to preserve.
    await win.evaluate((tid) => {
      window.__sid = null
      window.__turns = 0
      window.__errors = []
      window.__tools = []
      window.__types = []
      window.api.provider.onEvent((e) => {
        if (e.threadId !== tid) return
        window.__types.push(e.type)
        if (e.type === 'session') window.__sid = e.sessionId
        if (e.type === 'turn.completed') window.__turns++
        if (e.type === 'error') window.__errors.push(JSON.stringify(e).slice(0, 400))
        if (e.type === 'tool.started') window.__tools.push(e.toolName)

      })
    }, threadId)

    const started = await win.evaluate(
      (o) => window.api.provider.startSession(o),
      { threadId, provider, cwd: project, runtimeMode: 'full-access', instanceId: instance.id },
    )
    check(started?.ok !== false, `live ${provider} session started in the project checkout`)

    const waitForTurns = async (n, label) => {
      for (let i = 0; i < 180; i++) {
        const errs = await win.evaluate(() => window.__errors)
        if (errs.length > 0) {
          console.log(`  (adapter error during ${label}: ${errs[0]})`)
          return false
        }
        if ((await win.evaluate(() => window.__turns)) >= n) return true
        await win.waitForTimeout(1000)
      }
      console.log(`  (timed out waiting for ${label}; errors: ${JSON.stringify(await win.evaluate(() => window.__errors))})`)
      return false
    }

    await win.evaluate(
      ({ tid }) => window.api.provider.sendTurn(tid, 'Reply with the single word READY. Do not use any tools.', 'full-access'),
      { tid: threadId },
    )
    check(await waitForTurns(1, 'the first turn'), 'first turn completed in the project checkout')
    const sidBefore = await win.evaluate(() => window.__sid)
    console.log(`  (native session before: ${sidBefore})`)

    // ── the thing under test ──────────────────────────────────────
    const result = await win.evaluate(
      (r) => window.api.provider.relocateExecutionRoot(r),
      {
        threadId,
        expectedRevision: 0,
        targetPath: worktreeReal,
        targetBranch: 'live/exec-root',
        machineId: 'local',
        reason: 'drift-follow',
      },
    )
    console.log(`  (relocation: ${JSON.stringify(result)})`)
    check(result?.ok === true, `relocation succeeded (${result?.ok ? result.outcome : result?.code})`)
    check(result?.root?.path === worktreeReal, 'committed root is the worktree')
    check(result?.root?.revision === 1, `revision bumped to 1 (${result?.root?.revision})`)
    check(result?.continuity === 'preserved', `native context preserved (${result?.continuity})`)

    // ── the proof ─────────────────────────────────────────────────
    // Only a process actually running in the worktree can put this file there.
    await win.evaluate(
      ({ tid }) => window.api.provider.sendTurn(
        tid,
        'Using ONLY your shell tool, run exactly this one command and then stop: pwd > where.txt',
        'full-access',
      ),
      { tid: threadId },
    )
    check(await waitForTurns(2, 'the post-relocation turn'), 'second turn completed after the relocation')

    console.log(`  (tools used after the move: ${JSON.stringify(await win.evaluate(() => window.__tools))})`)

    const marker = join(worktreeReal, 'where.txt')
    const landedInWorktree = existsSync(marker)
    check(landedInWorktree, 'the agent wrote into the WORKTREE, not the checkout')
    if (landedInWorktree) {
      const pwd = readFileSync(marker, 'utf8').trim()
      check(pwd === worktreeReal, `the agent's own pwd is the worktree (${pwd})`)
    }
    check(!existsSync(join(project, 'where.txt')), 'nothing landed in the project checkout')

    const sidAfter = await win.evaluate(() => window.__sid)
    console.log(`  (native session after: ${sidAfter})`)
    check(!!sidAfter && sidAfter === sidBefore, `native session id survived the move (${sidBefore} -> ${sidAfter})`)
  } finally {
    await app.close()
    rmSync(project, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
    runtime.cleanup()
  }
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
