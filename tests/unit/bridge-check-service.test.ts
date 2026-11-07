/**
 * The local measured-check service on a real migrated database: the only
 * producer of a measured check fact.
 *
 * It runs a configured check ONCE per chat, definition and source snapshot,
 * waits for the checkout to stop changing, cancels on a new turn or on a stop
 * of the chat, records the real exit code or signal, digests only MASKED
 * output, and flags a definition the chat itself changed. An unconfigured
 * project runs nothing, and a read never starts a run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createMigratedDb } from './helpers/test-db'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

import {
  addProject,
  createConversation,
  listBridgeCheckRuns,
  recordBridgeOrigin,
  saveBridgeProjectPolicy,
  bridgeCheckSummaries,
  getBridgeOrigin,
  setBridgeOriginStopState,
  writeBridgeStopRecord,
} from '../../src/main/db/database'
import { secretRedactor } from '../../src/main/secrets/secret-redactor'
import {
  BridgeCheckService,
  bridgeCheckDefinitionPaths,
  bridgeCheckDefinitionTouched,
  type BridgeCheckHost,
  type BridgeCheckProcessResult,
} from '../../src/main/bridge/check-service'
import type { AllowedProject } from '../../src/main/bridge/read-service'
import type { BridgeGitFacts } from '../../src/main/bridge/git-facts'
import { defaultBridgeProjectPolicy, type BridgeCheckDefinition } from '../../src/shared/bridge'

const MACHINE = 'hub-test-machine'
const ROOT = '/repo/allowed'
const CHAT = 'chat-1'
const TESTS: BridgeCheckDefinition = { name: 'tests', program: 'npm', args: ['test'] }

let db: Database.Database
let facts: BridgeGitFacts
let runs: Array<{ definition: BridgeCheckDefinition; cwd: string }>
let result: BridgeCheckProcessResult
/** Set to change the tree the second settle read and the post-run read see. */
let treeAfterRun: string | null

function policy(checks: BridgeCheckDefinition[]) {
  return saveBridgeProjectPolicy({
    ...defaultBridgeProjectPolicy({
      project_id: 'bproj_1',
      label: 'Allowed',
      machine_id: MACHINE,
      canonical_local_root: ROOT,
    }),
    checks,
  })
}

function allowed(checks: BridgeCheckDefinition[]): AllowedProject[] {
  return [{ policy: policy(checks), paths: [ROOT], sidebarPath: ROOT }]
}

function service(over: Partial<BridgeCheckHost> = {}, checks = [TESTS]): BridgeCheckService {
  const scope = allowed(checks)
  return new BridgeCheckService({
    enabled: () => true,
    allowed: () => scope,
    now: () => 5_000,
    settleMs: 0,
    facts: async () => facts,
    run: async (input) => {
      runs.push({ definition: input.definition, cwd: input.cwd })
      if (treeAfterRun !== null) facts = { ...facts, tree: treeAfterRun }
      return result
    },
    ...over,
  })
}

beforeEach(() => {
  db = createMigratedDb()
  addProject(ROOT, 'Allowed')
  runs = []
  treeAfterRun = null
  facts = { head: 'c'.repeat(40), branch: 'main', tree: 'tree-1', dirty: false }
  result = { code: 0, signal: null, output: 'ok\n', bytes: 3, failedToStart: false, timedOut: false }
  createConversation(CHAT, ROOT, 'claude-code', 'Bridge chat')
})

afterEach(() => {
  secretRedactor.clear()
})

/** One diff card of the chat's own edit tools (no `noRevert`), as the bus reports it. */
function edit(checks: BridgeCheckService, relPath: string, noRevert?: 'outside'): void {
  checks.noteEvent({
    type: 'file.edited',
    threadId: CHAT,
    turnId: 't1',
    fileEditId: `t1:${relPath}`,
    repoRoot: ROOT,
    relPath,
    changeKind: 'modify',
    oldContent: '',
    newContent: '',
    ...(noRevert ? { noRevert } : {}),
  } as never)
}

/** The summary a chat list shows, with the tree the checkout is on now. */
function summary(tree: string | null = facts.tree) {
  return bridgeCheckSummaries(tree === null ? undefined : new Map([[CHAT, tree]])).get(CHAT)
}

function origin(): void {
  recordBridgeOrigin({
    conversationId: CHAT,
    callId: 'bcall_1',
    projectId: 'bproj_1',
    machineId: MACHINE,
    policyRevision: 1,
    source: 'relay',
  })
}

describe('scheduling', () => {
  it('runs each configured check once and records what it observed', async () => {
    origin()
    await service().onTurnEnded(CHAT)
    expect(runs).toEqual([{ definition: TESTS, cwd: ROOT }])
    const [stored] = listBridgeCheckRuns(CHAT)
    expect(stored).toMatchObject({
      name: 'tests',
      state: 'finished',
      exitCode: 0,
      commit: facts.head,
      treeBefore: 'tree-1',
      treeAfter: 'tree-1',
      dirty: false,
      cwd: ROOT,
      definitionChanged: false,
    })
    expect(stored.logDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(stored.logBytes).toBe(3)
  })

  it('never runs the same check twice over the same source snapshot', async () => {
    origin()
    const checks = service()
    await checks.onTurnEnded(CHAT)
    await checks.onTurnEnded(CHAT)
    expect(runs).toHaveLength(1)
    expect(listBridgeCheckRuns(CHAT)).toHaveLength(1)
  })

  it('runs again once the source has changed', async () => {
    origin()
    const checks = service()
    await checks.onTurnEnded(CHAT)
    facts = { ...facts, tree: 'tree-2' }
    await checks.onTurnEnded(CHAT)
    expect(runs).toHaveLength(2)
    expect(db.prepare('SELECT COUNT(*) AS n FROM bridge_check_runs').get()).toEqual({ n: 2 })
  })

  it('runs nothing for a project with no configured check', async () => {
    origin()
    await service({}, []).onTurnEnded(CHAT)
    expect(runs).toEqual([])
    expect(listBridgeCheckRuns(CHAT)).toEqual([])
  })

  it('runs nothing for a chat with no bridge origin', async () => {
    await service().onTurnEnded(CHAT)
    expect(runs).toEqual([])
  })

  it('runs nothing while the flag is off', async () => {
    origin()
    await service({ enabled: () => false }).onTurnEnded(CHAT)
    expect(runs).toEqual([])
  })

  it('runs nothing while the checkout keeps changing', async () => {
    origin()
    let reads = 0
    await service({
      facts: async () => {
        reads += 1
        return { ...facts, tree: `tree-${reads}` }
      },
    }).onTurnEnded(CHAT)
    expect(runs).toEqual([])
    expect(listBridgeCheckRuns(CHAT)).toEqual([])
  })
})

describe('what a run records', () => {
  it('keeps a nonzero exit as the result, never as a pass', async () => {
    origin()
    result = { ...result, code: 2 }
    await service().onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0]).toMatchObject({ state: 'finished', exitCode: 2 })
    expect(summary()).toEqual({ status: 'measured', passed: 0, failed: 1 })
  })

  it('records no log digest when the check wrote nothing', async () => {
    origin()
    result = { ...result, output: '', bytes: 0 }
    await service().onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0]).toMatchObject({ exitCode: 0, logDigest: null, logBytes: 0 })
  })

  it('is unavailable when the program could not start or ran too long', async () => {
    origin()
    result = { code: null, signal: null, output: '', bytes: 0, failedToStart: true, timedOut: false }
    await service().onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0].state).toBe('unavailable')
    expect(summary()).toEqual({ status: 'unavailable', passed: 0, failed: 0 })
  })

  it('binds a dirty run to its snapshot and to no commit', async () => {
    origin()
    facts = { ...facts, dirty: true }
    await service().onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0]).toMatchObject({ dirty: true, commit: null, treeBefore: 'tree-1' })
  })

  it('records the tree the source moved to while the check ran', async () => {
    origin()
    treeAfterRun = 'tree-edited'
    await service().onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0]).toMatchObject({ treeBefore: 'tree-1', treeAfter: 'tree-edited' })
    expect(summary()).toEqual({ status: 'stale', passed: 0, failed: 0 })
  })

  it('digests the masked output, so a saved secret never decides the digest', async () => {
    origin()
    const value = 'tskey-auth-0123456789abcdef'
    result = { ...result, output: `logged in with ${value}\n`, bytes: 40 }
    secretRedactor.add(CHAT, 'sec-1', 'TAILSCALE_AUTHKEY', Buffer.from(value))
    await service().onTurnEnded(CHAT)
    const withSecret = listBridgeCheckRuns(CHAT)[0].logDigest
    secretRedactor.clear()

    createMigratedDb()
    addProject(ROOT, 'Allowed')
    createConversation(CHAT, ROOT, 'claude-code', 'Bridge chat')
    origin()
    result = { ...result, output: 'logged in with [secret TAILSCALE_AUTHKEY]\n' }
    await service().onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0].logDigest).toBe(withSecret)
  })
})

describe('cancelling and invalidating', () => {
  it('cancels a run in flight when a new turn starts', async () => {
    origin()
    const checks = service({
      run: async (input) => {
        runs.push({ definition: input.definition, cwd: input.cwd })
        checks.noteEvent({
          type: 'tool.started',
          threadId: CHAT,
          toolId: 't1',
          toolName: 'Edit',
          input: {},
        } as never)
        return { code: 0, signal: 'SIGKILL', output: '', bytes: 0, failedToStart: false, timedOut: false }
      },
    })
    await checks.onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0].state).toBe('cancelled')
    expect(summary()).toEqual({ status: 'not_measured', passed: 0, failed: 0 })
  })

  it('flags a check whose definition the chat changed', async () => {
    origin()
    const script: BridgeCheckDefinition = { name: 'gate', program: './scripts/gate.sh', args: [] }
    const checks = service({}, [script])
    edit(checks, 'scripts/gate.sh')
    await checks.onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0].definitionChanged).toBe(true)
    expect(summary()).toEqual({ status: 'stale', passed: 0, failed: 0 })
  })

  it('leaves a check alone when the turn changed another file', async () => {
    origin()
    const script: BridgeCheckDefinition = { name: 'gate', program: './scripts/gate.sh', args: [] }
    const checks = service({}, [script])
    edit(checks, 'src/app.ts')
    await checks.onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0].definitionChanged).toBe(false)
  })
})

describe('the recorded baseline', () => {
  it('stores the checkout a bridge call arrived on', async () => {
    origin()
    await service().noteBridgeCall(CHAT, ROOT)
    expect(getBridgeOrigin(CHAT)).toMatchObject({ baselineTree: 'tree-1', baselineCommit: facts.head })
  })

  it('leaves the baseline alone when the folder cannot be read', async () => {
    origin()
    await service({ facts: async () => null }).noteBridgeCall(CHAT, ROOT)
    expect(getBridgeOrigin(CHAT)?.baselineTree).toBeNull()
  })
})

describe('definition paths', () => {
  it('names the files inside the root a definition points at', () => {
    expect(bridgeCheckDefinitionPaths({ name: 'a', program: 'npm', args: ['run', 'test'] }, ROOT)).toEqual([
      'run',
      'test',
    ])
    expect(bridgeCheckDefinitionPaths({ name: 'a', program: './x.sh', args: ['-q', '/etc/other'] }, ROOT)).toEqual([
      'x.sh',
    ])
  })

  it('is touched only by a file the definition names', () => {
    const def = { name: 'a', program: './scripts/gate.sh', args: [] }
    expect(bridgeCheckDefinitionTouched(def, ROOT, ['scripts/gate.sh'])).toBe(true)
    expect(bridgeCheckDefinitionTouched(def, ROOT, ['src/app.ts'])).toBe(false)
    expect(bridgeCheckDefinitionTouched(def, ROOT, [])).toBe(false)
  })
})

describe('a check the chat itself decided', () => {
  const RUN_TEST: BridgeCheckDefinition = { name: 'tests', program: 'npm', args: ['run', 'test'] }

  it('flags a turn that rewrote what the runner runs, not only a path the arguments name', async () => {
    origin()
    const checks = service({}, [RUN_TEST])
    edit(checks, 'package.json')
    await checks.onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0].definitionChanged).toBe(true)
  })

  it('flags a file under the top-level scripts folder and leaves other sources alone', () => {
    expect(bridgeCheckDefinitionTouched(RUN_TEST, ROOT, ['scripts/test.sh'])).toBe(true)
    expect(bridgeCheckDefinitionTouched(RUN_TEST, ROOT, ['package-lock.json'])).toBe(true)
    expect(bridgeCheckDefinitionTouched(RUN_TEST, ROOT, ['Makefile'])).toBe(true)
    expect(bridgeCheckDefinitionTouched(RUN_TEST, ROOT, ['src/scripts/test.sh'])).toBe(false)
    expect(bridgeCheckDefinitionTouched(RUN_TEST, ROOT, ['src/app.ts'])).toBe(false)
  })
})

describe('a stop of all bridge work', () => {
  it('schedules nothing while a kill stands', async () => {
    origin()
    writeBridgeStopRecord({ generation: 1, killed: true, killPending: false })
    await service().onTurnEnded(CHAT)
    expect(runs).toEqual([])
    expect(listBridgeCheckRuns(CHAT)).toEqual([])
  })

  it("schedules nothing after a stop that came since the chat's last bridge call", async () => {
    origin()
    writeBridgeStopRecord({ generation: 2, killed: false, killPending: false })
    await service().onTurnEnded(CHAT)
    expect(runs).toEqual([])
  })

  it('kills a run in flight and records it as cancelled, never as the pass it did not see', async () => {
    origin()
    const checks: BridgeCheckService = service({
      run: async (input) => {
        runs.push({ definition: input.definition, cwd: input.cwd })
        writeBridgeStopRecord({ generation: 1, killed: true, killPending: true })
        checks.cancelAll()
        return { code: 0, signal: 'SIGKILL', output: '', bytes: 0, failedToStart: false, timedOut: false }
      },
    })
    await checks.onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0].state).toBe('cancelled')
    expect(summary()).toEqual({ status: 'not_measured', passed: 0, failed: 0 })
  })
})

describe('a stop of one chat', () => {
  it("schedules nothing for the turn the chat's own stop ended", async () => {
    origin()
    // What stop_chat records before it runs the Stop.
    setBridgeOriginStopState([CHAT], 'pending')
    await service().onTurnEnded(CHAT)
    expect(runs).toEqual([])
    expect(listBridgeCheckRuns(CHAT)).toEqual([])
  })

  it('schedules again once the next bridge call clears the stop', async () => {
    origin()
    setBridgeOriginStopState([CHAT], 'stopped')
    await service().onTurnEnded(CHAT)
    expect(runs).toEqual([])
    origin()
    await service().onTurnEnded(CHAT)
    expect(runs).toEqual([{ definition: TESTS, cwd: ROOT }])
  })

  it('kills a run in flight for that chat and records it as cancelled, never as the pass it did not see', async () => {
    origin()
    const checks: BridgeCheckService = service({
      run: async (input) => {
        runs.push({ definition: input.definition, cwd: input.cwd })
        expect(checks.cancel(CHAT)).toBe(true)
        // The child exited 0 after the kill landed; the row still reports no result.
        return { code: 0, signal: null, output: 'ok\n', bytes: 3, failedToStart: false, timedOut: false }
      },
    })
    await checks.onTurnEnded(CHAT)
    expect(listBridgeCheckRuns(CHAT)[0].state).toBe('cancelled')
    expect(summary()).toEqual({ status: 'not_measured', passed: 0, failed: 0 })
  })
})

describe('what a chat list may claim', () => {
  it('drops a pass once the checkout moved on with no turn in between', async () => {
    origin()
    await service().onTurnEnded(CHAT)
    expect(summary()).toEqual({ status: 'measured', passed: 1, failed: 0 })
    // The owner edits a file in their editor: no turn, so nothing cancelled the run.
    expect(summary('tree-edited')).toEqual({ status: 'stale', passed: 0, failed: 0 })
    // And a list that read no checkout claims nothing about the code now.
    expect(bridgeCheckSummaries().get(CHAT)).toEqual({ status: 'stale', passed: 0, failed: 0 })
  })
})

describe('what this chat wrote', () => {
  it('keeps the paths its own edit tools wrote, and nothing it only saw change', async () => {
    origin()
    const checks = service()
    edit(checks, 'src/app.ts')
    edit(checks, 'src/other.ts', 'outside')
    expect(checks.writtenSinceBaseline(CHAT)).toEqual(['src/app.ts'])
    // A new bridge call records a new baseline, so the set starts again with it.
    await checks.noteBridgeCall(CHAT, ROOT)
    expect(checks.writtenSinceBaseline(CHAT)).toBeNull()
  })
})
