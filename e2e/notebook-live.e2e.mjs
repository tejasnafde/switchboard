#!/usr/bin/env node
/**
 * LIVE notebook-mirror probe: a real Claude agent in a throwaway repo is asked
 * to edit a Jupyter notebook. Asserts the full Phase 1 pipeline
 * (docs/plans/2026-07-18-data-scientist-mode-design.md):
 *   - the agent edits the .py mirror, never the .ipynb JSON
 *   - direct .ipynb writes (if attempted) are denied with the redirect message
 *   - the sync engine propagates the mirror edit into the .ipynb, preserving
 *     cell ids and structure
 *   - a synthetic file.edited event lands for the MIRROR path and none for
 *     the raw .ipynb
 *
 * Uses real Claude credentials and costs a few cents:
 *   SB_LIVE_AGENT=1 node e2e/notebook-live.e2e.mjs
 */
import { _electron as electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
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

// Temp dirs are cleaned by an exit handler (per CLAUDE.md e2e temp-dir rule)
// so a crash or signal during setup cannot leak them.
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

const project = mkdtempSync(join(tmpdir(), 'sb-nb-live-'))
tempDirs.push(project)
const git = (args) => execFileSync('git', args, { cwd: project })
git(['init', '-q'])
git(['config', 'user.email', 't@t.io'])
git(['config', 'user.name', 't'])
writeFileSync(
  join(project, 'analysis.ipynb'),
  JSON.stringify(
    {
      cells: [
        {
          id: 'cell-load',
          cell_type: 'code',
          source: ['THRESHOLD = 10\n', 'print(THRESHOLD)'],
          metadata: {},
          outputs: [{ output_type: 'stream', name: 'stdout', text: ['10\n'] }],
          execution_count: 2,
        },
      ],
      metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1
  ) + '\n'
)
git(['add', '-A'])
git(['commit', '-qm', 'init'])

const userDataDir = mkdtempSync(join(tmpdir(), 'sb-nb-live-ud-'))
tempDirs.push(userDataDir)
const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: repoRoot,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
})

try {
  const win = await app.firstWindow()
  await win.waitForFunction(() => !!window.api?.provider?.startSession, null, { timeout: 20_000 })

  const threadId = `agent_nb_live_${Math.floor(Math.random() * 1e9)}`

  await win.evaluate((tid) => {
    window.__events = []
    window.__done = false
    window.api.provider.onEvent((e) => {
      if (e.threadId !== tid) return
      if (['tool.started', 'tool.denied', 'file.edited', 'turn.completed', 'error'].includes(e.type)) {
        window.__events.push({
          type: e.type,
          toolName: e.toolName,
          reason: e.reason,
          relPath: e.relPath,
          message: e.message,
        })
      }
      if (e.type === 'turn.completed') window.__done = true
    })
  }, threadId)

  const started = await win.evaluate(
    (opts) => window.api.provider.startSession(opts),
    { threadId, provider: 'claude', cwd: project, runtimeMode: 'full-access' }
  )
  check(started?.ok !== false, 'live claude session started')

  const mirrorAbs = join(project, '.switchboard/notebooks/analysis.py')
  check(existsSync(mirrorAbs), 'mirror was created at session attach')

  await win.evaluate(
    ({ tid, msg }) => window.api.provider.sendTurn(tid, msg, 'full-access'),
    {
      tid: threadId,
      msg: 'Change THRESHOLD from 10 to 42 in analysis.ipynb. Make the edit, then stop - no summary needed.',
    }
  )

  let done = false
  for (let i = 0; i < 180 && !done; i++) {
    await win.waitForTimeout(1000)
    done = await win.evaluate(() => window.__done)
  }
  check(done, 'turn completed')

  // file.edited events arrive asynchronously AFTER turn.completed (the
  // registry diffs the git checkpoint + drains mirror edits fire-and-forget).
  for (let i = 0; i < 15; i++) {
    const hasCard = await win.evaluate(() => window.__events.some((e) => e.type === 'file.edited'))
    if (hasCard) break
    await win.waitForTimeout(1000)
  }

  const events = await win.evaluate(() => window.__events)
  console.log(`  (events: ${JSON.stringify(events)})`)

  // The notebook was updated THROUGH the mirror, structure intact.
  const doc = JSON.parse(readFileSync(join(project, 'analysis.ipynb'), 'utf-8'))
  const source = doc.cells.map((c) => (Array.isArray(c.source) ? c.source.join('') : c.source)).join('\n')
  check(source.includes('THRESHOLD = 42'), 'notebook source updated to THRESHOLD = 42')
  check(doc.cells[0]?.id === 'cell-load', 'cell id preserved through the sync')
  check(doc.nbformat === 4, 'notebook JSON still valid nbformat')

  const mirror = readFileSync(mirrorAbs, 'utf-8')
  check(mirror.includes('THRESHOLD = 42'), 'mirror contains the edit')
  check(mirror.includes('[cellbridge_id=cell-load]'), 'mirror kept the cell marker')

  const denied = events.filter((e) => e.type === 'tool.denied')
  const deniedOk = denied.every((e) => /\.switchboard\/notebooks\/analysis\.py/.test(e.reason ?? ''))
  check(deniedOk, `any denials carried the mirror redirect (${denied.length} denial[s])`)

  const fileEdits = events.filter((e) => e.type === 'file.edited')
  check(
    fileEdits.some((e) => e.relPath === '.switchboard/notebooks/analysis.py'),
    'synthetic file.edited fired for the mirror'
  )
  check(!fileEdits.some((e) => e.relPath === 'analysis.ipynb'), 'no raw .ipynb diff card event')
} finally {
  await app.close() // temp dirs removed by the exit handler
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
