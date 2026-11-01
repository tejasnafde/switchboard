import { createMigratedDb } from './helpers/test-db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string | null) => ({ id: id ?? `${agentType}-default`, agentType }),
}))

import {
  createHubBatch,
  getHubBatch,
  getHubChild,
  listHubChildren,
  listPendingHubWakes,
} from '../../src/main/db/database'
import { HubStarter, type HubParentContext, type HubStartHost, type HubStartIo } from '../../src/main/hub/hub-start'
import { hubBatchDetail, parseHubTasks, type HubBatchView, type HubTask } from '../../src/shared/hub'
import {
  HUB_REMOTE_LATER_TEXT,
  parseRemoteBranches,
  pickFetchBranch,
  planRemoteTask,
  type HubMachineDescription,
  type HubMachineEntry,
} from '../../src/shared/hub-remote'
import { buildHubMcpTools, type HubMcpToolContext } from '../../src/main/mcp/hub-tools'

const GIB = 1024 ** 3
const SHA = 'a'.repeat(40)

const desc = (over: Partial<HubMachineDescription> = {}): HubMachineDescription => ({
  v: 1,
  flagOn: true,
  os: 'linux',
  arch: 'x64',
  backendVersion: '1.0.0',
  agents: [
    {
      agent: 'claude-code',
      accounts: [
        { instanceId: 'claude-vm', name: 'VM Claude' },
        { instanceId: 'claude-vm2', name: 'VM Claude 2' },
      ],
      models: ['opus', 'sonnet'],
    },
  ],
  projects: [{ path: '~/src/repo', branch: 'main', remoteUrls: ['https://github.com/Me/Repo.git'] }],
  freeDiskBytes: 100 * GIB,
  openChildren: 0,
  runSlots: [],
  minFreeGiB: 5,
  ...over,
})

const entry = (over: Partial<HubMachineEntry> = {}): HubMachineEntry => ({
  id: 'vm1',
  name: 'Work VM',
  transport: 'gcloud-iap',
  status: 'connected',
  description: desc(),
  ageMs: 1_000,
  problem: null,
  ...over,
})

function harness(
  opts: {
    entries?: () => HubMachineEntry[]
    gate?: { flagOn: boolean; onVm: boolean }
    remoteUrls?: string[]
    containing?: string[]
    upstream?: string | null
  } = {},
) {
  const started: string[] = []
  const cards: Array<{ batchId: string; detail: string; view: HubBatchView }> = []
  const host: HubStartHost = {
    async createWorktree(request) {
      const id = request.owner.kind === 'conversation' ? request.owner.conversationId : ''
      return { status: 'ready', worktreePath: `/wt/${id}`, branch: `hub/${id}` } as never
    },
    async startSession(o) {
      started.push(o.threadId)
      return {}
    },
    async submitTurn() {
      return { status: 'accepted' } as never
    },
    openCard({ plan, detail }) {
      cards.push({ batchId: plan.batchId, detail, view: plan.view })
      return { ok: true, requestId: `sbmcp_${cards.length}` }
    },
    announceRow() {},
    async stopChild() {},
    remoteChildren: () => opts.gate ?? { flagOn: true, onVm: false },
    machineEntries: async () => (opts.entries ?? (() => [entry()]))(),
  }
  const io: Partial<HubStartIo> = {
    freeBytes: async () => 100 * GIB,
    checkoutBytes: async () => GIB,
    dirBytes: async () => GIB,
    planDeps: async () => [],
    prepareDeps: async () => ({ folders: [] }),
    checkDeps: async () => [],
    isMainCheckout: async () => false,
    commitOf: async (_cwd, ref) => (ref === 'missing' ? null : SHA),
    remoteUrls: async () => opts.remoteUrls ?? ['git@github.com:me/repo.git'],
    remoteBranchesContaining: async () => opts.containing ?? ['fork/main', 'origin/main'],
    upstreamOf: async () => (opts.upstream === undefined ? 'origin/main' : opts.upstream),
  }
  return { starter: new HubStarter(host, () => null, io), started, cards }
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
const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  createMigratedDb()
})

describe('parseHubTasks: machine', () => {
  it('keeps a machine id and refuses a wrong type or one over 64 characters', () => {
    const ok = parseHubTasks([{ title: 'A', brief: 'b', machine: 'vm1' }])
    expect(ok.ok && ok.tasks[0]!.machine).toBe('vm1')
    const none = parseHubTasks([{ title: 'A', brief: 'b' }])
    expect(none.ok && none.tasks[0]!.machine).toBeUndefined()
    const bad = parseHubTasks([{ title: 'A', brief: 'b', machine: 7 }])
    expect(bad.ok).toBe(false)
    const long = parseHubTasks([{ title: 'A', brief: 'b', machine: 'x'.repeat(65) }])
    expect(!long.ok && long.message).toContain('at most 64')
  })
})

describe('planRemoteTask', () => {
  const base = {
    n: 2,
    machineId: 'vm1',
    agent: 'claude-code' as const,
    location: 'worktree' as const,
    parentRemoteUrls: ['git@github.com:me/repo.git'],
  }
  const refusal = (over: Partial<Parameters<typeof planRemoteTask>[0]>) => {
    const r = planRemoteTask({ ...base, entries: [entry()], ...over })
    return r.ok ? null : r.message
  }

  it('refuses each problem with the task number', () => {
    expect(refusal({ machineId: 'nope' })).toBe('Task 2: no machine nope. Call list_machines.')
    expect(refusal({ entries: [entry({ status: 'offline' })] })).toBe('Task 2: connect Work VM first.')
    // A failed connection keeps its last description, which is not a connection.
    expect(refusal({ entries: [entry({ status: 'error' })] })).toBe('Task 2: connect Work VM first.')
    expect(refusal({ entries: [entry({ status: 'error', problem: 'update the backend on Work VM' })] })).toBe(
      'Task 2: update the backend on Work VM.',
    )
    expect(refusal({ entries: [entry({ description: null, ageMs: null })] })).toBe(
      'Task 2: update the backend on Work VM.',
    )
    expect(refusal({ entries: [entry({ ageMs: 10 * 60_000 })] })).toBe('Task 2: update the backend on Work VM.')
    expect(refusal({ entries: [entry({ description: desc({ flagOn: false }) })] })).toBe(
      'Task 2: Work VM does not take children: turn on hub_remote_children there.',
    )
    expect(refusal({ agent: 'codex' })).toBe(
      'Task 2: Codex has no login on Work VM. Log in there first (claude, codex login, opencode auth login).',
    )
    expect(refusal({ account: 'claude-desk' })).toBe(
      'Task 2: Work VM has no Claude Code account claude-desk. Call list_machines.',
    )
    expect(refusal({ model: 'gpt-9' })).toContain('Work VM has no Claude Code model gpt-9')
    expect(refusal({ location: 'project' })).toBe(
      'Task 2: a child on another machine works in a worktree; location project is refused there.',
    )
    expect(refusal({ parentRemoteUrls: ['/local/bare.git'] })).toBe(
      'Task 2: this project has no git remote, so Work VM cannot get it.',
    )
  })

  it('matches the project across https, ssh and scp forms and takes the first account by default', () => {
    for (const url of [
      'git@github.com:me/repo.git',
      'ssh://git@github.com:22/me/repo',
      'https://tok@github.com/me/repo',
    ]) {
      const r = planRemoteTask({ ...base, parentRemoteUrls: [url], entries: [entry()] })
      expect(r).toEqual({
        ok: true,
        plan: {
          machine: { id: 'vm1', name: 'Work VM', transport: 'gcloud-iap' },
          instanceId: 'claude-vm',
          remoteProjectPath: '~/src/repo',
          clonePlanned: false,
        },
      })
    }
    const named = planRemoteTask({ ...base, account: 'claude-vm2', entries: [entry()] })
    expect(named.ok && named.plan.instanceId).toBe('claude-vm2')
  })

  it('plans a clone into ~/projects/<repo> when no checkout there shares a remote', () => {
    const r = planRemoteTask({ ...base, entries: [entry({ description: desc({ projects: [] }) })] })
    expect(r.ok && r.plan).toMatchObject({ remoteProjectPath: '~/projects/repo', clonePlanned: true })
    const cased = planRemoteTask({
      ...base,
      parentRemoteUrls: ['https://github.com/Me/My-Repo.git/'],
      entries: [entry({ description: desc({ projects: [] }) })],
    })
    expect(cased.ok && cased.plan.remoteProjectPath).toBe('~/projects/My-Repo')
  })
})

describe('fetch branch', () => {
  it('drops symbolic refs and prefers the upstream', () => {
    expect(parseRemoteBranches('origin/HEAD refs/remotes/origin/main\norigin/main \nfork/main\n')).toEqual([
      'origin/main',
      'fork/main',
    ])
    expect(pickFetchBranch(['fork/main', 'origin/main'], 'origin/main')).toBe('origin/main')
    expect(pickFetchBranch(['fork/main'], 'origin/main')).toBe('fork/main')
    expect(pickFetchBranch([], 'origin/main')).toBeNull()
  })
})

describe('hubBatchDetail with machines', () => {
  it('names the machine per row, the clone, and one disk line per machine', () => {
    const view: HubBatchView = {
      batchId: 'hb',
      rows: [
        {
          title: 'Local',
          agent: 'claude-code',
          account: null,
          model: null,
          mode: 'auto',
          location: 'worktree',
          baseRef: 'HEAD (aaaaaaa)',
          deps: 'link',
          machine: null,
        },
        {
          title: 'Far',
          agent: 'claude-code',
          account: 'claude-vm',
          model: 'opus',
          mode: 'auto',
          location: 'worktree',
          baseRef: 'HEAD (aaaaaaa)',
          deps: 'none',
          machine: { id: 'vm1', name: 'Work VM', transport: 'gcloud-iap' },
          clone: true,
          remoteProjectPath: '~/projects/repo',
        },
        {
          title: 'Box',
          agent: 'codex',
          account: 'codex-box',
          model: null,
          mode: 'sandbox',
          location: 'worktree',
          baseRef: 'main (aaaaaaa)',
          deps: 'none',
          machine: { id: 'box', name: 'Box', transport: 'ssh' },
          clone: false,
          remoteProjectPath: '~/src/repo',
        },
      ],
      needBytes: GIB,
      freeBytes: 50 * GIB,
      remoteDisk: [
        { machineId: 'vm1', name: 'Work VM', needBytes: 2 * GIB, freeBytes: 30 * GIB },
        { machineId: 'box', name: 'Box', needBytes: null, freeBytes: null },
      ],
      mainCheckout: false,
    }
    expect(hubBatchDetail(view)).toBe(
      [
        'Start 3 child chats:',
        '1. Local - claude-code, auto, worktree off HEAD (aaaaaaa), deps: link',
        '2. Far - claude-code opus, auto, worktree off HEAD (aaaaaaa) on Work VM (IAP), clones into ~/projects/repo on Work VM',
        '3. Box - codex, sandbox, worktree off main (aaaaaaa) on Box (SSH)',
        'Disk: needs about 1.0 GiB, 50.0 GiB free.',
        'Disk on Work VM: needs about 2.0 GiB, 30.0 GiB free.',
        'Disk on Box: needs an unknown amount, free space unknown.',
      ].join('\n'),
    )
  })
})

describe('HubStarter with a remote task', () => {
  it('refuses another machine with the flag off and from a parent on a VM', async () => {
    const off = harness({ gate: { flagOn: false, onVm: false } })
    expect(text(await off.starter.propose(parent('auto'), [task('A'), task('B', { machine: 'vm1' })]))).toBe(
      'Task 2: Starting children on other machines is off.',
    )
    const vm = harness({ gate: { flagOn: true, onVm: true } })
    expect(text(await vm.starter.propose(parent('auto'), [task('A', { machine: 'vm1' })]))).toBe(
      'Task 1: A chat on a remote machine starts children on its own machine only.',
    )
    // `local` is the parent's own machine, so the gate does not apply.
    const local = harness({ gate: { flagOn: false, onVm: true } })
    expect((await local.starter.propose(parent('auto'), [task('A', { machine: 'local' })])).isError).toBeFalsy()
  })

  it('refuses the whole batch with the first problem', async () => {
    const h = harness()
    const r = await h.starter.propose(parent('sandbox'), [task('A'), task('B', { machine: 'gone' })])
    expect(r.isError).toBe(true)
    expect(text(r)).toBe('Task 2: no machine gone. Call list_machines.')
    expect(h.cards).toEqual([])
    expect(listHubChildren('agent_parent')).toEqual([])
  })

  it('refuses a base commit no remote branch holds, and a parent project with no remote', async () => {
    const h = harness({ containing: [] })
    expect(text(await h.starter.propose(parent('auto'), [task('A', { machine: 'vm1' })]))).toBe(
      'Task 1: commit aaaaaaa is not on any remote. Push it first.',
    )
    const noRemote = harness({ remoteUrls: [] })
    expect(text(await noRemote.starter.propose(parent('auto'), [task('A', { machine: 'vm1' })]))).toBe(
      'Task 1: this project has no git remote, so Work VM cannot get it.',
    )
  })

  it("refuses a batch the remote machine's disk cannot take, naming the machine", async () => {
    const h = harness({ entries: () => [entry({ description: desc({ freeDiskBytes: 5.5 * GIB, minFreeGiB: 5 }) })] })
    const r = await h.starter.propose(parent('auto'), [task('A', { machine: 'vm1' })])
    expect(text(r)).toMatch(/^On Work VM: Not enough disk/)
  })

  it.each(['auto', 'full-access', 'accept-edits'] as const)(
    'opens the card in %s when a row is remote',
    async (mode) => {
      const h = harness({ entries: () => [entry({ description: desc({ projects: [] }) })] })
      const r = await h.starter.propose(parent(mode), [task('Here'), task('There', { machine: 'vm1', model: 'opus' })])
      expect(text(r)).toContain('Queued for the user')
      expect(h.cards).toHaveLength(1)
      expect(h.started).toEqual([])
      const view = h.cards[0]!.view
      expect(view.rows[0]!.machine).toBeNull()
      expect(view.rows[1]).toMatchObject({
        machine: { id: 'vm1', name: 'Work VM', transport: 'gcloud-iap' },
        account: 'claude-vm',
        clone: true,
        remoteProjectPath: '~/projects/repo',
      })
      // Its checkout plus the clone's own.
      expect(view.remoteDisk).toEqual([{ machineId: 'vm1', name: 'Work VM', needBytes: 2 * GIB, freeBytes: 100 * GIB }])
      expect(h.cards[0]!.detail).toContain('on Work VM (IAP), clones into ~/projects/repo on Work VM')
      const plan = JSON.parse(getHubBatch(h.cards[0]!.batchId)!.planJson)
      expect(plan.children[1]).toMatchObject({
        machine: { id: 'vm1' },
        remoteProjectPath: '~/projects/repo',
        clonePlanned: true,
        fetch: { remoteBranch: 'origin/main' },
        baseSha: SHA,
      })
    },
  )

  it('at approval fails the children of a machine that went away, ends the rest as later, and starts local ones', async () => {
    let entries = [entry(), entry({ id: 'box', name: 'Box', transport: 'ssh' })]
    const h = harness({ entries: () => entries })
    await h.starter.propose(parent('auto'), [
      task('Here'),
      task('VM', { machine: 'vm1' }),
      task('Box', { machine: 'box' }),
    ])
    entries = [entry(), entry({ id: 'box', name: 'Box', transport: 'ssh', status: 'error' })]
    const res = await h.starter.approve(h.cards[0]!.batchId, 'auto')
    expect(res.isError).toBeFalsy()
    await settle()
    const [here, vm, box] = listHubChildren('agent_parent')
    expect(h.started).toEqual([here!.childId])
    expect(getHubChild(here!.childId)!.phase).toBe('open')
    expect(getHubChild(vm!.childId)!.phase).toBe('failed_start')
    expect(getHubChild(box!.childId)!.phase).toBe('failed_start')
    const wakes = listPendingHubWakes('agent_parent')
    expect(wakes.find((w) => w.childId === vm!.childId)).toMatchObject({
      kind: 'failed',
      summary: `Failed to start: ${HUB_REMOTE_LATER_TEXT}`,
    })
    expect(wakes.find((w) => w.childId === box!.childId)).toMatchObject({
      kind: 'failed',
      summary: 'Failed to start: Box is not connected.',
    })
  })

  it('fails a child whose account is gone from its machine at approval', async () => {
    let entries = [entry()]
    const h = harness({ entries: () => entries })
    await h.starter.propose(parent('auto'), [task('VM', { machine: 'vm1', account: 'claude-vm2' })])
    const agents = [{ agent: 'claude-code' as const, accounts: [{ instanceId: 'claude-vm', name: 'x' }], models: [] }]
    entries = [entry({ description: desc({ agents }) })]
    await h.starter.approve(h.cards[0]!.batchId, 'auto')
    await settle()
    expect(listPendingHubWakes('agent_parent')[0]!.summary).toContain(
      'no longer has the Claude Code account claude-vm2',
    )
  })

  it('approves a plan stored before machines existed as local children', async () => {
    const h = harness()
    const child = {
      childId: 'agent_old',
      ordinal: 0,
      title: 'Old',
      brief: 'b',
      location: 'worktree',
      baseRef: 'HEAD',
      baseSha: SHA,
      branchSeed: 'Old',
      agent: 'claude-code',
      instanceId: null,
      model: null,
      requestedMode: null,
      shownMode: 'auto',
      deps: 'none',
      depsPlan: [],
    }
    createHubBatch({
      batchId: 'hb_old',
      parentId: 'agent_parent',
      cardRequestId: 'sbmcp_old',
      planJson: JSON.stringify({ projectPath: '/repo', children: [child] }),
      planDigest: 'd',
    })
    expect((await h.starter.approve('hb_old', 'auto')).isError).toBeFalsy()
    await settle()
    expect(h.started).toEqual(['agent_old'])
  })
})

describe('start_children schema', () => {
  const ctx = (machines: boolean) =>
    ({ machines, starter: {}, parent: () => parent('auto') }) as unknown as HubMcpToolContext
  const props = (machines: boolean) =>
    (
      buildHubMcpTools(ctx(machines))[0]!.inputSchema as {
        properties: { tasks: { items: { properties: Record<string, { description?: string }> } } }
      }
    ).properties.tasks.items.properties
  it('documents machine only while list_machines is offered', () => {
    expect(props(false).machine).toBeUndefined()
    expect(props(false).account!.description).toBe('A provider account id. Default: the account of this chat.')
    expect(props(true).machine).toBeDefined()
    expect(props(true).account!.description).toContain('list_machines')
  })
})
