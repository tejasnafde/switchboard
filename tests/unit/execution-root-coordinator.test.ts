/**
 * The relocation transaction.
 *
 * The coordinator owns the ORDER and the DECISIONS; a host port does the
 * effects. That split is what makes the interesting cases testable at all:
 * rollback, a stale revision arriving mid-flight, and a relocation queued
 * behind a running turn are exactly the paths a live registry makes hard to
 * reach on purpose.
 *
 * The commit boundary is a successful provider start at the target. Before it,
 * nothing durable changes. After it, the durable pointer, the runtime and the
 * clients all move together.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveExecutionRoot, type ExecutionRoot } from '../../src/shared/execution-root'
import type { RelocateExecutionRootRequest } from '../../src/shared/execution-root-relocation'
import {
  ExecutionRootCoordinator,
  type ExecutionRootHost,
} from '../../src/main/provider/execution-root-coordinator'

const PROJECT = '/repo/app'
const TARGET = '/repo/app/.switchboard/worktrees/feat'

interface FakeState {
  root: ExecutionRoot
  threadIsLive: boolean
  starting: boolean
  switchingProfile: boolean
  preparingTurn: boolean
  turnActive: boolean
  provider: string
}

let machineIdsSeen: string[]
let state: FakeState
let host: ExecutionRootHost
let calls: string[]
let commitReturns: number | null
let attachFails: boolean
let restoreFails: boolean
let resolveTargetResult: Awaited<ReturnType<ExecutionRootHost['resolveTarget']>>
/** Runs after resolveTarget, to simulate the root moving under us. */
let duringValidation: (() => void) | null
let detachThrows: boolean
/** Every (path, mode) pair attachProvider was called with. */
let attachModes: Array<{ path: string; mode: string }>

function makeHost(): ExecutionRootHost {
  return {
    currentRoot: (threadId, machineId) => {
      if (threadId !== 't1') return null
      machineIdsSeen.push(machineId)
      return { ...state.root, machineId }
    },
    sessionState: (threadId) => threadId === 't1'
      ? {
        threadIsLive: state.threadIsLive,
        starting: state.starting,
        switchingProfile: state.switchingProfile,
        preparingTurn: state.preparingTurn,
        turnActive: state.turnActive,
        provider: state.provider,
      }
      : null,
    resolveTarget: async () => {
      calls.push('resolveTarget')
      duringValidation?.()
      return resolveTargetResult
    },
    detachProvider: async () => {
      calls.push('detach')
      if (detachThrows) throw new Error('adapter would not stop')
      return { threadId: 't1' }
    },
    attachProvider: async (_handle, path, mode) => {
      calls.push(`attach:${path}`)
      attachModes.push({ path, mode })
      if (mode === 'target' && attachFails) {
        return { ok: false as const, code: 'target-start-failed' as const, message: 'boom' }
      }
      if (mode === 'restore' && restoreFails) throw new Error('restore exploded')
      return { ok: true as const, continuity: 'preserved' as const }
    },
    commitRoot: (_threadId, path, branch) => {
      calls.push(`commit:${path}`)
      if (commitReturns === null) return null
      state.root = resolveExecutionRoot({
        projectPath: PROJECT,
        worktreePath: path === PROJECT ? null : path,
        worktreeBranch: branch,
        executionRootRevision: commitReturns,
      })
      return commitReturns
    },
    commitRuntime: (_threadId, path) => { calls.push(`runtime:${path}`) },
    publish: (event) => { calls.push(`publish:${event.type}`) },
  }
}

function request(overrides: Partial<RelocateExecutionRootRequest> = {}): RelocateExecutionRootRequest {
  return {
    threadId: 't1',
    expectedRevision: state.root.revision,
    targetPath: TARGET,
    targetBranch: 'sb/feat',
    machineId: 'local',
    reason: 'drift-follow',
    ...overrides,
  }
}

beforeEach(() => {
  state = {
    root: resolveExecutionRoot({ projectPath: PROJECT, executionRootRevision: 0 }),
    threadIsLive: true,
    starting: false,
    switchingProfile: false,
    preparingTurn: false,
    turnActive: false,
    provider: 'claude',
  }
  calls = []
  commitReturns = 1
  attachFails = false
  restoreFails = false
  duringValidation = null
  detachThrows = false
  attachModes = []
  machineIdsSeen = []
  resolveTargetResult = { ok: true, path: TARGET, branch: 'sb/feat' }
  host = makeHost()
})

describe('happy path', () => {
  it('stops, starts at the target, commits, then publishes - in that order', async () => {
    const coordinator = new ExecutionRootCoordinator(host)
    const result = await coordinator.relocate(request())
    expect(result).toMatchObject({ ok: true, outcome: 'relocated', continuity: 'preserved' })
    expect(calls).toEqual([
      'resolveTarget',
      'detach',
      `attach:${TARGET}`,
      `commit:${TARGET}`,
      `runtime:${TARGET}`,
      'publish:session.execution-root-changed',
    ])
  })

  it('reports the committed revision, not the requested one', async () => {
    commitReturns = 7
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result.ok && result.root.revision).toBe(7)
  })

  it('releases the thread so a second relocation can follow', async () => {
    const coordinator = new ExecutionRootCoordinator(host)
    await coordinator.relocate(request())
    expect(coordinator.isRelocating('t1')).toBe(false)
    commitReturns = 2
    const second = await coordinator.relocate(request({ expectedRevision: 1, targetPath: PROJECT }))
    expect(second.ok).toBe(true)
  })
})

describe('refusals that must not touch the provider', () => {
  it('reports already-at-target without stopping anything', async () => {
    const result = await new ExecutionRootCoordinator(host).relocate(request({ targetPath: PROJECT }))
    expect(result).toMatchObject({ ok: true, outcome: 'already-at-target' })
    expect(calls).toEqual([])
  })

  it('rejects a stale revision', async () => {
    const result = await new ExecutionRootCoordinator(host).relocate(request({ expectedRevision: 5 }))
    expect(result).toMatchObject({ ok: false, code: 'stale-revision' })
    expect(calls).toEqual([])
  })

  it('rejects an unknown thread', async () => {
    const result = await new ExecutionRootCoordinator(host).relocate(request({ threadId: 'ghost' }))
    expect(result).toMatchObject({ ok: false, code: 'unknown-thread' })
    expect(calls).toEqual([])
  })

  it('rejects a missing target before detaching', async () => {
    resolveTargetResult = { ok: false, code: 'target-missing', message: 'gone' }
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'target-missing' })
    expect(calls).toEqual(['resolveTarget'])
  })

  it('rejects a target in a different repository before detaching', async () => {
    resolveTargetResult = { ok: false, code: 'different-repository', message: 'other repo' }
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'different-repository' })
    expect(calls).toEqual(['resolveTarget'])
  })

  it('rejects a second relocation while one holds the thread', async () => {
    const coordinator = new ExecutionRootCoordinator(host)
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    host.resolveTarget = async () => { await gate; return resolveTargetResult }

    const first = coordinator.relocate(request())
    const second = await coordinator.relocate(request())
    expect(second).toMatchObject({ ok: false, code: 'busy' })
    release()
    await first
  })

  it('refuses an unsupported provider rather than restarting it cold', async () => {
    state.provider = 'opencode'
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'continuity-unsupported' })
    expect(calls).toEqual([])
  })

  it('relocates an unsupported provider when the caller accepted the loss', async () => {
    state.provider = 'opencode'
    const result = await new ExecutionRootCoordinator(host)
      .relocate(request({ acceptContinuityLoss: true }))
    expect(result.ok).toBe(true)
    expect(calls).toContain('detach')
  })
})

describe('the root moving under an in-flight relocation', () => {
  it('aborts after validation if the revision changed, without detaching', async () => {
    duringValidation = () => {
      state.root = resolveExecutionRoot({ projectPath: PROJECT, executionRootRevision: 9 })
    }
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'stale-revision' })
    expect(calls).toEqual(['resolveTarget'])
  })
})

describe('rollback', () => {
  it('restores the source provider when the target will not start', async () => {
    attachFails = true
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'target-start-failed', rolledBack: true })
    expect(calls).toEqual(['resolveTarget', 'detach', `attach:${TARGET}`, `attach:${PROJECT}`])
  })

  it('leaves the durable pointer untouched when the target will not start', async () => {
    attachFails = true
    await new ExecutionRootCoordinator(host).relocate(request())
    expect(calls.some((c) => c.startsWith('commit:'))).toBe(false)
    expect(state.root.path).toBe(PROJECT)
  })

  it('reports rollback-failed when the source cannot be restored either', async () => {
    attachFails = true
    restoreFails = true
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'rollback-failed' })
    expect(result.ok === false && result.rolledBack).toBeFalsy()
  })

  it('rolls back when the conversation row vanished before the commit', async () => {
    commitReturns = null
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'unknown-thread', rolledBack: true })
    expect(calls).toEqual([
      'resolveTarget', 'detach', `attach:${TARGET}`, `commit:${TARGET}`, `attach:${PROJECT}`,
    ])
  })
})

describe('a thread with no live provider', () => {
  beforeEach(() => { state.threadIsLive = false })

  it('commits straight away, with no provider work', async () => {
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: true, outcome: 'relocated', continuity: 'not-needed' })
    expect(calls).toEqual([
      'resolveTarget', `commit:${TARGET}`, `runtime:${TARGET}`, 'publish:session.execution-root-changed',
    ])
  })

  it('reports unknown-thread if the row is gone, rather than claiming success', async () => {
    commitReturns = null
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'unknown-thread' })
  })
})

describe('queueing behind a running turn', () => {
  beforeEach(() => { state.turnActive = true })

  it('queues instead of killing the turn', async () => {
    const coordinator = new ExecutionRootCoordinator(host)
    const result = await coordinator.relocate(request())
    expect(result).toMatchObject({ ok: true, outcome: 'queued' })
    expect(calls).toEqual([])
    expect(coordinator.hasQueued('t1')).toBe(true)
  })

  it('commits at the turn boundary', async () => {
    const coordinator = new ExecutionRootCoordinator(host)
    await coordinator.relocate(request())
    state.turnActive = false
    await coordinator.onTurnBoundary('t1')
    expect(calls).toContain(`commit:${TARGET}`)
    expect(coordinator.hasQueued('t1')).toBe(false)
  })

  it('lets a later request supersede an earlier queued one', async () => {
    const coordinator = new ExecutionRootCoordinator(host)
    await coordinator.relocate(request())
    await coordinator.relocate(request({ targetPath: '/repo/app/.switchboard/worktrees/other' }))
    resolveTargetResult = { ok: true, path: '/repo/app/.switchboard/worktrees/other', branch: 'sb/other' }
    state.turnActive = false
    await coordinator.onTurnBoundary('t1')
    expect(calls).toContain('commit:/repo/app/.switchboard/worktrees/other')
    expect(calls).not.toContain(`commit:${TARGET}`)
  })

  it('drops a queued request whose revision was superseded while it waited', async () => {
    const coordinator = new ExecutionRootCoordinator(host)
    await coordinator.relocate(request())
    state.turnActive = false
    state.root = resolveExecutionRoot({ projectPath: PROJECT, executionRootRevision: 4 })
    await coordinator.onTurnBoundary('t1')
    expect(calls).toEqual([])
    expect(coordinator.hasQueued('t1')).toBe(false)
  })

  it('drops a queued request as soon as another move commits, so sends are not refused', async () => {
    // Seen live: a Follow queued behind a turn, then a second Follow committed
    // once the chat was idle. The stale queued one kept refusing every send
    // ("working directory is moving") until the next turn ended.
    const coordinator = new ExecutionRootCoordinator(host)
    await coordinator.relocate(request())
    expect(coordinator.hasQueued('t1')).toBe(true)
    state.turnActive = false
    const committed = await coordinator.relocate(request())
    expect(committed).toMatchObject({ ok: true, outcome: 'relocated' })
    expect(coordinator.hasQueued('t1')).toBe(false)
  })

  it('drops a queued request when the session stops', async () => {
    const coordinator = new ExecutionRootCoordinator(host)
    await coordinator.relocate(request())
    coordinator.onSessionStopped('t1')
    expect(coordinator.hasQueued('t1')).toBe(false)
    state.turnActive = false
    await coordinator.onTurnBoundary('t1')
    expect(calls).toEqual([])
  })

  it('does nothing at a turn boundary with nothing queued', async () => {
    await new ExecutionRootCoordinator(host).onTurnBoundary('t1')
    expect(calls).toEqual([])
  })
})

describe('the published event', () => {
  it('carries both roots, the branch, the revision, the reason and the continuity', async () => {
    const published = vi.fn()
    host.publish = published
    commitReturns = 3
    await new ExecutionRootCoordinator(host).relocate(request({ reason: 'branch-picker' }))
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      type: 'session.execution-root-changed',
      threadId: 't1',
      machineId: 'local',
      from: { path: PROJECT, branch: null },
      to: { path: TARGET, branch: 'sb/feat', isWorktree: true },
      revision: 3,
      reason: 'branch-picker',
      continuity: 'preserved',
    }))
  })

  it('uses the branch git resolved, not the one the client asked for', async () => {
    const published = vi.fn()
    host.publish = published
    resolveTargetResult = { ok: true, path: TARGET, branch: 'actually/this-one' }
    await new ExecutionRootCoordinator(host).relocate(request({ targetBranch: 'client/guess' }))
    expect(published).toHaveBeenCalledWith(expect.objectContaining({
      to: { path: TARGET, branch: 'actually/this-one', isWorktree: true },
    }))
  })
})

describe('review hardening', () => {
  it('tells the host which machine the REQUEST claimed, on every lookup', async () => {
    await new ExecutionRootCoordinator(host).relocate(request({ machineId: 'local' }))
    expect(machineIdsSeen.length).toBeGreaterThan(1)
    expect(new Set(machineIdsSeen)).toEqual(new Set(['local']))
  })

  it('marks a rollback explicitly, instead of leaving the host to compare paths', async () => {
    attachFails = true
    await new ExecutionRootCoordinator(host).relocate(request())
    expect(attachModes).toEqual([
      { path: TARGET, mode: 'target' },
      { path: PROJECT, mode: 'restore' },
    ])
  })

  it('reports a failed stop as its own outcome, with nothing to roll back', async () => {
    detachThrows = true
    const result = await new ExecutionRootCoordinator(host).relocate(request())
    expect(result).toMatchObject({ ok: false, code: 'source-stop-failed' })
    expect(result.ok === false && result.rolledBack).toBeFalsy()
    expect(calls).toEqual(['resolveTarget', 'detach'])
  })

  it('does not commit or publish when the source could not be stopped', async () => {
    detachThrows = true
    await new ExecutionRootCoordinator(host).relocate(request())
    expect(calls.some((c) => c.startsWith('commit:'))).toBe(false)
    expect(calls.some((c) => c.startsWith('publish:'))).toBe(false)
  })

  it('releases the thread after a failed stop, so a retry is possible', async () => {
    detachThrows = true
    const coordinator = new ExecutionRootCoordinator(host)
    await coordinator.relocate(request())
    expect(coordinator.isRelocating('t1')).toBe(false)
  })
})
