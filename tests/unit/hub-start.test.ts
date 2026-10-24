import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string | null) => ({ id: id ?? `${agentType}-default`, agentType }),
}))

import {
  addProject,
  createConversation,
  getHubBatch,
  getHubChild,
  getSetting,
  insertHubChild,
  listHubChildren,
  listPendingHubWakes,
  setConversationWorktree,
  setSetting,
  updateHubChild,
} from '../../src/main/db/database'
import { linkedDependencyAt, untrackDependencyLinks, type ChildDepsState } from '../../src/main/hub/hub-deps'
import { HubStarter, type HubParentContext, type HubStartHost, type HubStartIo } from '../../src/main/hub/hub-start'
import type { HubTask } from '../../src/shared/hub'
import type { WorktreeCreationRequest } from '../../src/shared/worktree-creation'
import type { UserTurnSubmissionV1 } from '../../src/shared/provider-events'

const GIB = 1024 ** 3

function harness(
  opts: {
    failWorktree?: (r: WorktreeCreationRequest) => boolean
    freeBytes?: number
    depsMode?: 'link' | 'clone' | 'install'
    problems?: () => string[]
  } = {},
) {
  const started: string[] = []
  const turns: UserTurnSubmissionV1[] = []
  const cards: string[] = []
  const rows: string[] = []
  const prepared: string[] = []
  const stopped: string[] = []
  const owned: string[] = []
  const host: HubStartHost = {
    async createWorktree(request) {
      if (opts.failWorktree?.(request)) throw new Error('disk on fire')
      const id = request.owner.kind === 'conversation' ? request.owner.conversationId : ''
      return { status: 'ready', worktreePath: `/wt/${id}`, branch: `hub/${id}` } as never
    },
    async startSession(o) {
      started.push(`${o.threadId}:${o.provider}:${o.runtimeMode}`)
      return {}
    },
    async submitTurn(input) {
      turns.push(input)
      return { status: 'accepted' } as never
    },
    openCard({ plan }) {
      cards.push(plan.batchId)
      return { ok: true, requestId: `sbmcp_${cards.length}` }
    },
    announceRow(_parentId, row) {
      rows.push(row.content)
    },
    async stopChild(childId) {
      stopped.push(childId)
    },
  }
  const io: Partial<HubStartIo> = {
    freeBytes: async () => opts.freeBytes ?? 100 * GIB,
    checkoutBytes: async () => GIB / 2,
    dirBytes: async () => GIB,
    planDeps: async () =>
      ['node_modules', 'apps/mobile/node_modules'].map((path) => ({
        path,
        pkgDir: path.replace(/\/?node_modules$/, ''),
        mode: opts.depsMode ?? 'link',
        reason: null,
      })),
    prepareDeps: async (_p, wt, plans) => {
      prepared.push(wt)
      return { folders: plans.map((p) => ({ ...p, target: `/repo/${p.path}`, stamp: 's', lock: 'l' })) }
    },
    checkDeps: async () => opts.problems?.() ?? [],
    ownDeps: async (_p, wt, state: ChildDepsState) => {
      owned.push(wt)
      return {
        state: {
          folders: state.folders.map((f) => ({ path: f.path, pkgDir: f.pkgDir, mode: 'clone' as const, reason: null })),
        },
        lines: state.folders.map((f) => `${f.path}: now your own copy.`),
      }
    },
    isMainCheckout: async () => true,
    commitOf: async (_cwd, ref) => (ref === 'missing' ? null : 'a'.repeat(40)),
  }
  const starter = new HubStarter(host, getSetting, io)
  return { starter, started, turns, cards, rows, prepared, stopped, owned }
}

const parent = (mode: HubParentContext['mode']): HubParentContext => ({
  threadId: 'agent_parent',
  parentId: 'agent_parent',
  projectPath: '/repo',
  cwd: '/repo',
  mode,
  agent: 'claude-code',
  instanceId: 'claude-code-default',
})

const task = (title: string, extra: Partial<HubTask> = {}): HubTask => ({
  title,
  brief: `Do ${title}`,
  location: 'worktree',
  ...extra,
})
const text = (r: { content: Array<{ text: string }> }) => r.content.map((c) => c.text).join('\n')

/** Lets the batch runner's chained promises settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  createMigratedDb()
})

describe('HubStarter', () => {
  it('opens one card in ask mode, and the same plan twice returns that card', async () => {
    const h = harness()
    const first = await h.starter.propose(parent('sandbox'), [task('A'), task('B')])
    expect(first.isError).toBeFalsy()
    expect(text(first)).toContain('Queued for the user')
    const again = await h.starter.propose(parent('sandbox'), [task('A'), task('B')])
    expect(text(again)).toContain('already waits')
    expect(h.cards).toHaveLength(1)
    expect(h.started).toEqual([])
  })

  it('starts at once in full access, on two providers, with a mode no higher than the parent', async () => {
    const h = harness()
    const res = await h.starter.propose(parent('auto'), [
      task('A'),
      task('B', { agent: 'codex' }),
      task('C', { mode: 'full-access' }),
    ])
    expect(h.cards).toEqual([])
    expect(text(res)).toContain('Starting 3 child chats')
    expect(text(res)).toContain('main checkout')
    expect(h.rows).toHaveLength(1)
    await settle()
    await settle()
    expect(h.started.map((s) => s.split(':').slice(1).join(':'))).toEqual(['claude:auto', 'codex:auto', 'claude:auto'])
    // Every child's dependency folders are ready before its first turn.
    expect(h.prepared).toHaveLength(3)
    expect(h.turns[0]!.providerText).toContain('<switchboard-hub-brief>')
    expect(h.turns[0]!.providerText).toContain('own_dependencies')
    expect(listHubChildren('agent_parent').every((c) => c.phase === 'open')).toBe(true)
  })

  it('refuses plan mode, a child as a parent, and a batch the disk cannot take', async () => {
    const h = harness({ freeBytes: 5 * GIB })
    expect((await h.starter.propose(parent('plan'), [task('A')])).isError).toBe(true)
    const disk = await h.starter.propose(parent('auto'), [task('A')])
    expect(text(disk)).toContain('Not enough disk')
    insertHubChild({
      childId: 'agent_child',
      parentId: 'agent_other',
      batchId: 'b0',
      ordinal: 0,
      title: 'C',
      brief: 'b',
      location: 'worktree',
      grantedMode: 'auto',
      depsMode: 'clone',
    })
    const nested = await harness().starter.propose({ ...parent('auto'), parentId: 'agent_child' }, [task('A')])
    expect(text(nested)).toContain('cannot start children')
  })

  it('runs at most 3 children per account, and the 4th starts when one turn ends', async () => {
    const h = harness()
    await h.starter.propose(parent('auto'), [task('A'), task('B'), task('C'), task('D')])
    for (let i = 0; i < 6; i++) await settle()
    expect(h.started).toHaveLength(3)
    const fourth = listHubChildren('agent_parent')[3]!
    expect(h.starter.waitingForSlot(fourth.childId)).toBe(true)
    h.starter.onTurnEnded(listHubChildren('agent_parent')[0]!.childId, { usedTokens: 10 })
    for (let i = 0; i < 3; i++) await settle()
    expect(h.started).toHaveLength(4)
  })

  it('marks one failed child and starts the others', async () => {
    const h = harness({ failWorktree: (r) => r.creationId.endsWith('-1') })
    await h.starter.propose(parent('auto'), [task('A'), task('B'), task('C')])
    for (let i = 0; i < 6; i++) await settle()
    const phases = listHubChildren('agent_parent').map((c) => c.phase)
    expect(phases).toEqual(['open', 'failed_start', 'open'])
    const wakes = listPendingHubWakes('agent_parent')
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({ kind: 'failed' })
    expect(wakes[0]!.summary).toContain('disk on fire')
  })

  it('approves a card with the mode the parent has then, and a denial starts nothing', async () => {
    const h = harness()
    await h.starter.propose(parent('sandbox'), [task('A', { mode: 'auto' })])
    const batchId = h.cards[0]!
    const res = await h.starter.approve(batchId, 'sandbox')
    expect(res.isError).toBeFalsy()
    expect(getHubBatch(batchId)!.status).toBe('approved')
    expect(getHubChild(listHubChildren('agent_parent')[0]!.childId)!.grantedMode).toBe('sandbox')

    const h2 = harness()
    await h2.starter.propose({ ...parent('sandbox'), parentId: 'agent_p2' }, [task('B')])
    h2.starter.closed(h2.cards[0]!, 'denied')
    expect(getHubBatch(h2.cards[0]!)!.status).toBe('denied')
    expect(listHubChildren('agent_p2')).toEqual([])
  })

  it('marks children a quit cut off mid-start as failed, with a wake', () => {
    insertHubChild({
      childId: 'agent_cut',
      parentId: 'agent_parent',
      batchId: 'b0',
      ordinal: 0,
      title: 'Cut',
      brief: 'b',
      location: 'worktree',
      grantedMode: 'auto',
      depsMode: 'clone',
    })
    harness().starter.recoverInterrupted()
    expect(getHubChild('agent_cut')!.phase).toBe('failed_start')
    expect(listPendingHubWakes('agent_parent')[0]).toMatchObject({ kind: 'failed', childId: 'agent_cut' })
  })

  it('honours the per-account setting', async () => {
    setSetting('hub.runningPerInstance', '1')
    const h = harness()
    await h.starter.propose(parent('auto'), [task('A'), task('B')])
    for (let i = 0; i < 6; i++) await settle()
    expect(h.started).toHaveLength(1)
  })

  it('never grants more than the card showed, even when the parent mode rose before the approval', async () => {
    const h = harness()
    await h.starter.propose(parent('sandbox'), [task('A', { mode: 'full-access' })])
    await h.starter.approve(h.cards[0]!, 'full-access')
    expect(listHubChildren('agent_parent')[0]!.grantedMode).toBe('sandbox')
  })

  it('checks the 12 open children cap again at approval', async () => {
    const h = harness()
    const eight = Array.from({ length: 8 }, (_, i) => task(`T${i}`))
    await h.starter.propose(parent('sandbox'), eight)
    await h.starter.propose(
      parent('sandbox'),
      eight.map((t) => ({ ...t, title: `${t.title}b` })),
    )
    expect((await h.starter.approve(h.cards[0]!, 'sandbox')).isError).toBeFalsy()
    const second = await h.starter.approve(h.cards[1]!, 'sandbox')
    expect(text(second)).toContain('at most 12')
    expect(listHubChildren('agent_parent')).toHaveLength(8)
  })

  it('does not hold a child behind a waiter on another account and parent', async () => {
    setSetting('hub.runningPerInstance', '1')
    const h = harness()
    await h.starter.propose(parent('auto'), [task('A'), task('B')])
    for (let i = 0; i < 6; i++) await settle()
    await h.starter.propose({ ...parent('auto'), parentId: 'agent_p2' }, [task('C', { agent: 'codex' })])
    for (let i = 0; i < 6; i++) await settle()
    expect(h.started.filter((x) => x.includes(':codex:'))).toHaveLength(1)
  })

  it("records every later turn of a launched child, not only the brief's", async () => {
    const h = harness()
    await h.starter.propose(parent('auto'), [task('A')])
    for (let i = 0; i < 6; i++) await settle()
    const id = listHubChildren('agent_parent')[0]!.childId
    h.starter.onTurnEnded(id, { usedTokens: 1 })
    h.starter.onTurnEnded(id, { usedTokens: 2 })
    expect(h.starter.lastTurnOf(id)?.usedTokens).toBe(2)
  })

  it('counts a clone at 5% of its folder and an install at the whole folder in the disk check', async () => {
    // 2 folders of 1 GiB each: a link needs nothing, a clone about 0.1 GiB, an install 2 GiB.
    const free = 5 * GIB + GIB / 2 + GIB / 4
    expect(
      text(await harness({ freeBytes: free, depsMode: 'link' }).starter.propose(parent('auto'), [task('A')])),
    ).toContain('Starting 1')
    createMigratedDb()
    expect(
      text(await harness({ freeBytes: free, depsMode: 'clone' }).starter.propose(parent('auto'), [task('A')])),
    ).toContain('Starting 1')
    createMigratedDb()
    expect(
      text(await harness({ freeBytes: free, depsMode: 'install' }).starter.propose(parent('auto'), [task('A')])),
    ).toContain('Not enough disk')
  })

  it('stops a child that changed its shared dependencies, with one blocked wake', async () => {
    let problems: string[] = []
    const h = harness({ problems: () => problems })
    await h.starter.propose(parent('auto'), [task('A')])
    for (let i = 0; i < 6; i++) await settle()
    const id = listHubChildren('agent_parent')[0]!.childId
    h.starter.onTurnEnded(id, { usedTokens: 1 })
    await settle()
    expect(h.stopped).toEqual([])
    problems = ['the packages in node_modules were installed or removed']
    h.starter.onTurnEnded(id, { usedTokens: 2 })
    h.starter.onTurnEnded(id, { usedTokens: 3 })
    for (let i = 0; i < 3; i++) await settle()
    expect(h.stopped).toEqual([id])
    const wakes = listPendingHubWakes('agent_parent')
    expect(wakes).toHaveLength(1)
    expect(wakes[0]).toMatchObject({ kind: 'blocked', childId: id })
    expect(wakes[0]!.summary).toContain('Changed shared dependencies')
    untrackDependencyLinks(id)
  })

  it('own_dependencies replaces the links and lifts the write guard', async () => {
    const h = harness()
    await h.starter.propose(parent('auto'), [task('A')])
    for (let i = 0; i < 6; i++) await settle()
    const id = listHubChildren('agent_parent')[0]!.childId
    expect(linkedDependencyAt(`/wt/${id}/node_modules/x.js`)).toBe(resolve(`/wt/${id}/node_modules`))
    addProject('/repo', 'repo')
    createConversation(id, '/repo', 'claude-code', 'A')
    setConversationWorktree(id, `/wt/${id}`, `hub/${id}`)
    const res = await h.starter.ownDependencies(id)
    expect(text(res)).toContain('node_modules: now your own copy.')
    expect(h.owned).toEqual([`/wt/${id}`])
    expect(getHubChild(id)!.depsMode).toBe('clone')
    expect(linkedDependencyAt(`/wt/${id}/node_modules/x.js`)).toBeNull()
    expect(text(await h.starter.ownDependencies(id))).toContain('no linked dependency folders')
  })

  it('tracks the links of open children again after a restart', () => {
    insertHubChild({
      childId: 'agent_open',
      parentId: 'agent_parent',
      batchId: 'b0',
      ordinal: 0,
      title: 'Open',
      brief: 'b',
      location: 'worktree',
      grantedMode: 'auto',
      depsMode: 'link',
      depsJson: JSON.stringify({ folders: [{ path: 'node_modules', pkgDir: '', mode: 'link', reason: null }] }),
    })
    updateHubChild('agent_open', { phase: 'open' })
    addProject('/repo', 'repo')
    createConversation('agent_open', '/repo', 'claude-code', 'Open')
    setConversationWorktree('agent_open', '/wt/open', 'hub/open')
    harness().starter.recoverInterrupted()
    expect(linkedDependencyAt('/wt/open/node_modules/a.js')).toBe(resolve('/wt/open/node_modules'))
    untrackDependencyLinks('agent_open')
  })
})
