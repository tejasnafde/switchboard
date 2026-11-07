/**
 * The bridge's measured-evidence projection: what `read_chat` can prove.
 *
 * Every fact here comes from an observation on this machine. Agent text
 * never reaches it, a pull request head that is not the checkout's commit is
 * stale, a host that cannot be read is unavailable, and a check whose source
 * moved or whose definition the chat changed is never measured.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMigratedDb } from './helpers/test-db'

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/tmp/switchboard-vitest') } }))

import {
  buildBridgeEvidence,
  bridgeEvidenceReader,
  type BridgeEvidenceDeps,
  type BridgePrReading,
} from '../../src/main/bridge/evidence'
import { addProject, createConversation, linkConversationPullRequest } from '../../src/main/db/database'
import type { BridgeCheckRun } from '../../src/main/db/bridge'
import type { BridgeGitFacts } from '../../src/main/bridge/git-facts'
import type { PrRef } from '../../src/shared/pull-requests'

const CWD = '/repo/allowed'
const FACTS: BridgeGitFacts = { head: 'c'.repeat(40), branch: 'feat/x', tree: 'tree-now', dirty: false }
const REF: PrRef = { host: 'github', owner: 'tejasnafde', name: 'switchboard', number: 7 }

const READING: BridgePrReading = {
  url: 'https://github.com/tejasnafde/switchboard/pull/7',
  sourceBranch: 'feat/x',
  state: 'open',
  headSha: FACTS.head,
  checks: { state: 'success', total: 2, passed: 2, failed: 0 },
}

function run(over: Partial<BridgeCheckRun> = {}): BridgeCheckRun {
  return {
    runId: 'bchk_1',
    conversationId: 'chat-1',
    projectId: 'bproj_1',
    name: 'tests',
    definitionHash: 'hash-1',
    cwd: CWD,
    executionRootRevision: 0,
    commit: FACTS.head,
    treeBefore: 'tree-now',
    treeAfter: 'tree-now',
    dirty: false,
    state: 'finished',
    exitCode: 0,
    signal: null,
    logDigest: 'd'.repeat(64),
    logBytes: 120,
    definitionChanged: false,
    definitionChangedReason: null,
    startedAt: 1_000,
    endedAt: 2_000,
    ...over,
  }
}

function deps(over: Partial<BridgeEvidenceDeps> = {}): BridgeEvidenceDeps {
  return {
    now: () => 10_000,
    executionRoot: () => ({ cwd: CWD, revision: 3 }),
    facts: async () => FACTS,
    changedFiles: async () => ['src/a.ts', 'src/b.ts'],
    shared: () => false,
    baselineTree: () => 'tree-baseline',
    writtenSinceBaseline: () => ['src/a.ts', 'src/b.ts'],
    prLinks: () => [],
    readPr: async () => READING,
    checkRuns: () => [],
    ...over,
  }
}

describe('code evidence', () => {
  it('reports the checkout it read, with the baseline diff and the execution root revision', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps())
    expect(evidence.code).toMatchObject({
      producer: 'git',
      status: 'measured',
      commit: FACTS.head,
      tree: 'tree-now',
      branch: 'feat/x',
      dirty: false,
      baseline_tree: 'tree-baseline',
      changed_files: 2,
      execution_root_revision: 3,
      attribution: 'bridge_chat',
    })
    expect(evidence.code.observed_at).toBe(new Date(10_000).toISOString())
  })

  it('says so when the tree is dirty with no new commit', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ facts: async () => ({ ...FACTS, dirty: true }) }))
    expect(evidence.code.dirty).toBe(true)
    expect(evidence.code.note).toContain('not committed')
  })

  it('attributes nothing when another chat shares the checkout', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ shared: () => true }))
    expect(evidence.code.attribution).toBe('unknown')
    expect(evidence.code.note).toContain('shares this checkout')
  })

  it('attributes nothing when a changed file is not one this chat wrote', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ writtenSinceBaseline: () => ['src/a.ts'] }))
    expect(evidence.code.attribution).toBe('unknown')
    expect(evidence.code.note).toContain('not in what this chat wrote')
  })

  it('attributes nothing when no written set was recorded, even alone in the checkout', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ writtenSinceBaseline: () => null }))
    expect(evidence.code).toMatchObject({ attribution: 'unknown', changed_files: 2 })
  })

  it('attributes nothing when nothing changed', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({ changedFiles: async () => [], writtenSinceBaseline: () => [] }),
    )
    expect(evidence.code).toMatchObject({ attribution: 'unknown', changed_files: 0 })
    expect(evidence.code.note).toContain('Nothing differs from the baseline')
  })

  it('is unavailable, not clean, when the folder cannot be read as a checkout', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ facts: async () => null }))
    expect(evidence.code.status).toBe('unavailable')
    expect(evidence.code.commit).toBeNull()
  })

  it('is not measured when the chat has no execution root', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ executionRoot: () => null }))
    expect(evidence.code.status).toBe('not_measured')
    expect(evidence.checks.status).toBe('not_measured')
  })
})

describe('pull request evidence', () => {
  it('is not measured when the chat links none', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps())
    expect(evidence.pull_requests).toEqual({ status: 'not_measured', items: [], omitted: 0 })
  })

  it('reads only the newest links, so a chat with hundreds costs one read each and counts the rest', async () => {
    const links = Array.from({ length: 206 }, (_, i) => ({ ...REF, number: i + 1 }))
    const read: number[] = []
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({
        prLinks: () => links,
        readPr: async (ref) => {
          read.push(ref.number)
          return { ...READING, headSha: FACTS.head }
        },
      }),
    )
    expect(evidence.pull_requests.items).toHaveLength(10)
    expect(evidence.pull_requests.omitted).toBe(196)
    // Newest first, and nothing older was read at all.
    expect(evidence.pull_requests.items.map((pr) => pr.number)).toEqual([
      206, 205, 204, 203, 202, 201, 200, 199, 198, 197,
    ])
    expect(read.sort((a, b) => a - b)).toEqual([197, 198, 199, 200, 201, 202, 203, 204, 205, 206])
  })

  it('is measured when the head is the commit this checkout is on', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ prLinks: () => [REF] }))
    expect(evidence.pull_requests.status).toBe('measured')
    expect(evidence.pull_requests.items[0]).toMatchObject({
      producer: 'pull_request_service',
      status: 'measured',
      url: READING.url,
      source_branch: 'feat/x',
      state: 'open',
      head_commit: FACTS.head,
      checks: { state: 'success', total: 2, passed: 2, failed: 0 },
    })
  })

  it('is stale when the head is another commit: a link alone proves nothing', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({ prLinks: () => [REF], readPr: async () => ({ ...READING, headSha: 'a'.repeat(40) }) }),
    )
    expect(evidence.pull_requests.status).toBe('stale')
    expect(evidence.pull_requests.items[0].status).toBe('stale')
    expect(evidence.pull_requests.items[0].note).toContain('may not hold this work')
  })

  it('is unavailable, never "no pull request", when the host read fails', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ prLinks: () => [REF], readPr: async () => null }))
    expect(evidence.pull_requests.status).toBe('unavailable')
    expect(evidence.pull_requests.items[0]).toMatchObject({ status: 'unavailable', url: null, state: null })
  })

  it('is unavailable, not stale, when the checkout could not be read', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ prLinks: () => [REF], facts: async () => null }))
    expect(evidence.pull_requests.items[0]).toMatchObject({ status: 'unavailable', url: READING.url })
    expect(evidence.pull_requests.items[0].note).toContain('not compared')
  })

  it('is unavailable when the read throws', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({
        prLinks: () => [REF],
        readPr: () => Promise.reject(new Error('gh is signed out')),
      }),
    )
    expect(evidence.pull_requests.items[0].status).toBe('unavailable')
  })
})

describe('measured check evidence', () => {
  it('stays not measured while nothing ran, whatever the agent wrote', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps())
    expect(evidence.checks).toEqual({ status: 'not_measured', items: [], omitted: 0 })
  })

  it('reports a pass on the exact source it ran on', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ checkRuns: () => [run()] }))
    expect(evidence.checks.status).toBe('measured')
    expect(evidence.checks.items[0]).toMatchObject({
      producer: 'local_check',
      status: 'measured',
      name: 'tests',
      outcome: 'passed',
      exit_code: 0,
      definition_hash: 'hash-1',
      tree_before: 'tree-now',
      tree_after: 'tree-now',
    })
  })

  it('reports a nonzero exit as failed, with the code', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ checkRuns: () => [run({ exitCode: 1 })] }))
    expect(evidence.checks.items[0]).toMatchObject({ status: 'measured', outcome: 'failed', exit_code: 1 })
  })

  it('keeps the exit code when no log was captured', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({ checkRuns: () => [run({ logDigest: null, logBytes: 0 })] }),
    )
    expect(evidence.checks.items[0]).toMatchObject({ status: 'measured', outcome: 'passed', log_digest: null })
  })

  it('is stale when the source changed while the check ran', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ checkRuns: () => [run({ treeAfter: 'tree-moved' })] }))
    expect(evidence.checks.items[0].status).toBe('stale')
    expect(evidence.checks.items[0].note).toContain('did not test one tree')
  })

  it('is stale when the current tree is no longer the one it tested', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({ checkRuns: () => [run({ treeBefore: 'tree-old', treeAfter: 'tree-old' })] }),
    )
    expect(evidence.checks.items[0].status).toBe('stale')
    expect(evidence.checks.items[0].note).toContain('current tree')
  })

  it('flags a check definition the chat changed and never calls it measured', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({ checkRuns: () => [run({ definitionChanged: true, definitionChangedReason: 'chat_edit' })] }),
    )
    expect(evidence.checks.items[0]).toMatchObject({ status: 'stale', definition_changed: true })
    expect(evidence.checks.items[0].note).toContain('The chat wrote a file that decides what this check runs')
  })

  it('says the check list was replaced when that, and not the chat, changed the definition', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({ checkRuns: () => [run({ definitionChanged: true, definitionChangedReason: 'checks_replaced' })] }),
    )
    expect(evidence.checks.items[0]).toMatchObject({ status: 'stale', definition_changed: true })
    const { note } = evidence.checks.items[0]
    expect(note).toContain("The project's configured checks were replaced after this run")
    expect(note).not.toContain('The chat wrote a file')
  })

  it('names the snapshot of a dirty run and binds it to no commit', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({ checkRuns: () => [run({ dirty: true, commit: null })] }),
    )
    expect(evidence.checks.items[0]).toMatchObject({ dirty: true, commit: null, tree: 'tree-now' })
  })

  it('reports a cancelled run as not measured and one that could not run as unavailable', async () => {
    const cancelled = await buildBridgeEvidence(
      'chat-1',
      deps({ checkRuns: () => [run({ state: 'cancelled', exitCode: null, endedAt: 2_500 })] }),
    )
    expect(cancelled.checks.items[0]).toMatchObject({ status: 'not_measured', outcome: 'not_run' })
    const broken = await buildBridgeEvidence(
      'chat-1',
      deps({ checkRuns: () => [run({ state: 'unavailable', exitCode: null })] }),
    )
    expect(broken.checks.items[0]).toMatchObject({ status: 'unavailable', outcome: 'unavailable' })
  })

  it('says the definition flag is one way only on every finished run', async () => {
    const evidence = await buildBridgeEvidence('chat-1', deps({ checkRuns: () => [run()] }))
    expect(evidence.checks.items[0].note).toContain('not proof the check is unchanged')
  })

  it('lets one unmeasured check pull the whole group down', async () => {
    const evidence = await buildBridgeEvidence(
      'chat-1',
      deps({ checkRuns: () => [run(), run({ runId: 'bchk_2', name: 'lint', state: 'cancelled', exitCode: null })] }),
    )
    expect(evidence.checks.status).toBe('not_measured')
  })

  it('keeps the newest runs and counts the rest', async () => {
    const runs = Array.from({ length: 24 }, (_, i) => run({ runId: `bchk_${i}`, name: `check-${i}` }))
    const evidence = await buildBridgeEvidence('chat-1', deps({ checkRuns: () => runs }))
    expect(evidence.checks.items.map((c) => c.name)).toEqual(runs.slice(0, 20).map((r) => r.name))
    expect(evidence.checks.omitted).toBe(4)
  })
})

describe('the reader a backend keeps', () => {
  it('holds its reads: one pull request read serves the polls inside the window', async () => {
    createMigratedDb()
    addProject(CWD, 'Allowed')
    createConversation('chat-1', CWD, 'claude-code', 'Bridge chat')
    linkConversationPullRequest('chat-1', REF, 'manual')
    let reads = 0
    const read = bridgeEvidenceReader(
      async () => {
        reads += 1
        return READING
      },
      () => 10_000,
    )
    await read('chat-1')
    await read('chat-1')
    expect(reads).toBe(1)
  })
})
