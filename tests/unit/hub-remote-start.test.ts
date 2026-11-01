/**
 * Children on other machines, start path: the desktop's `HubStarter` sends
 * `hub-remote:start-child` through the real hub client (`RemoteHubClients`)
 * to a `WsHost` on 127.0.0.1, whose handler runs a second `HubStarter`
 * loaded again after `vi.resetModules`, so it has its own database, with fake
 * agents and fake git.
 */
import { createMigratedDb } from './helpers/test-db'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const VM_ACCOUNTS = new Set(['claude-vm', 'claude-vm2'])
vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string | null) => {
    if (id && id.endsWith('-vm') && !VM_ACCOUNTS.has(id)) throw new Error(`Provider instance not found: ${id}`)
    if (id === 'claude-gone') throw new Error('Provider instance not found: claude-gone')
    return { id: id ?? `${agentType}-default`, agentType }
  },
}))

const db = await import('../../src/main/db/database')
const { WsHost } = await import('../../src/main/backend/ws-host')
const { RemoteHubClients } = await import('../../src/main/hub/remote-hub-clients')
const { HubStarter } = await import('../../src/main/hub/hub-start')
const { HubWakeScheduler } = await import('../../src/main/hub/hub-wakes')
const { HubRemoteChannels } = await import('../../src/shared/ipc-channels')
const { hubRepoUrl, parseHubRemoteStartRequest } = await import('../../src/shared/hub-remote')

import type { HubParentContext, HubStartHost, HubStartIo } from '../../src/main/hub/hub-start'
import type { HubMachineDescription, HubMachineEntry, HubRemoteStartRequest } from '../../src/shared/hub-remote'
import type { HubTask } from '../../src/shared/hub'
import type { RuntimeMode } from '../../src/shared/provider-events'
import type { WorktreeCreationRequest } from '../../src/shared/worktree-creation'

const TOKEN = 'server-token-abc'
const GIB = 1024 ** 3
const SHA = 'b'.repeat(40)
const REPO = 'https://github.com/me/repo.git'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

beforeEach(() => {
  createMigratedDb()
})

const until = async (ok: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

interface Vm {
  /** This machine's own database module (a second copy of it). */
  dbm: typeof db
  url: string
  starter: InstanceType<typeof HubStarter>
  settings: Record<string, string>
  flag: { on: boolean }
  sessions: Array<{ threadId: string; runtimeMode?: RuntimeMode; cwd: string; instanceId?: string }>
  worktrees: WorktreeCreationRequest[]
  fetches: Array<[string, string, string, string]>
  clones: Array<[string, string, string]>
  dirs: Set<string>
  remotes: Map<string, Array<{ name: string; url: string }>>
}

/** A machine's backend: a WsHost with the production hub-remote handlers and its own HubStarter. */
async function bootVm(opts: { handler?: boolean; io?: Partial<HubStartIo> } = {}): Promise<Vm> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const host = new WsHost(wss, TOKEN)
  cleanups.push(() => {
    host.dispose()
    wss.close()
  })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  // A fresh module graph: this machine's HubStarter opens its own in-memory database.
  vi.resetModules()
  const vmDb = await import('../../src/main/db/database')
  const { HubStarter: VmStarter } = await import('../../src/main/hub/hub-start')
  const { registerHubRemoteHandlers } = await import('../../src/main/hub/hub-remote-describe')
  const vm = {
    dbm: vmDb,
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    settings: {} as Record<string, string>,
    flag: { on: true },
    sessions: [] as Vm['sessions'],
    worktrees: [] as WorktreeCreationRequest[],
    fetches: [] as Vm['fetches'],
    clones: [] as Vm['clones'],
    dirs: new Set(['/home/u/src/repo']),
    remotes: new Map([['/home/u/src/repo', [{ name: 'origin', url: 'git@github.com:me/repo.git' }]]]),
  } as Vm
  const vmHost: HubStartHost = {
    async createWorktree(request) {
      vm.worktrees.push(request)
      const id = request.owner.kind === 'conversation' ? request.owner.conversationId : ''
      return {
        status: 'ready',
        worktreePath: `${request.repository.projectPath}/.switchboard/worktrees/${id}`,
      } as never
    },
    async startSession(o) {
      vm.sessions.push(o)
      return {}
    },
    async submitTurn() {
      return { status: 'accepted' } as never
    },
    openCard: () => ({ ok: false, message: 'no cards on a child machine' }),
    announceRow() {},
    async stopChild() {},
    remoteChildren: () => ({ flagOn: vm.flag.on, onVm: true }),
  }
  vm.starter = new VmStarter(vmHost, (key) => vm.settings[key] ?? null, {
    homeDir: () => '/home/u',
    isDir: async (p) => vm.dirs.has(p),
    async clone(url, branch, dest) {
      vm.clones.push([url, branch, dest])
      vm.dirs.add(dest)
      vm.remotes.set(dest, [{ name: 'origin', url }])
    },
    configuredRemotes: async (p) => vm.remotes.get(p) ?? [],
    async fetchBase(cwd, remote, branch, sha) {
      vm.fetches.push([cwd, remote, branch, sha])
    },
    freeBytes: async () => 100 * GIB,
    checkoutBytes: async () => GIB,
    dirBytes: async () => GIB,
    planDeps: async () => [],
    prepareDeps: async () => ({ folders: [] }),
    checkDeps: async () => [],
    ...opts.io,
  })
  if (opts.handler !== false) {
    registerHubRemoteHandlers(host, {
      backendVersion: () => '1.0.0',
      agentAvailable: async () => true,
      runningSlotKeys: () => [],
      startChild: (request) => vm.starter.startRemote(request),
    })
  }
  return vm
}

const description = (): HubMachineDescription => ({
  v: 1,
  flagOn: true,
  os: 'linux',
  arch: 'x64',
  backendVersion: '1.0.0',
  agents: [
    {
      agent: 'claude-code',
      accounts: [
        { instanceId: 'claude-vm', name: 'VM' },
        { instanceId: 'claude-vm2', name: 'VM 2' },
      ],
      models: ['opus'],
    },
  ],
  projects: [{ path: '~/src/repo', branch: 'main', remoteUrls: [REPO] }],
  freeDiskBytes: 100 * GIB,
  openChildren: 0,
  runSlots: [],
  minFreeGiB: 5,
})

const machineEntry = (id: string, name: string): HubMachineEntry => ({
  id,
  name,
  transport: 'gcloud-iap',
  status: 'connected',
  description: description(),
  ageMs: 1_000,
  problem: null,
  canStart: true,
})

/** The desktop: its HubStarter, with the real hub client to the given machines. */
function desktop(machines: Record<string, { name: string; url: string }>, settings: Record<string, string> = {}) {
  const clients = new RemoteHubClients({
    enabled: () => true,
    machines: () => Object.entries(machines).map(([id, m]) => ({ id, name: m.name, transportKind: 'gcloud-iap' })),
    statusOf: () => 'connected',
    urlOf: (id) => machines[id]?.url ?? null,
    tokenOf: () => TOKEN,
  })
  cleanups.push(() => clients.closeAll())
  const started: Array<{ threadId: string; runtimeMode?: RuntimeMode }> = []
  const cards: string[] = []
  const worktrees: string[] = []
  const host: HubStartHost = {
    async createWorktree(request) {
      const id = request.owner.kind === 'conversation' ? request.owner.conversationId : ''
      worktrees.push(id)
      return { status: 'ready', worktreePath: `/wt/${id}` } as never
    },
    async startSession(o) {
      started.push(o)
      return {}
    },
    async submitTurn() {
      return { status: 'accepted' } as never
    },
    openCard({ plan }) {
      cards.push(plan.batchId)
      return { ok: true, requestId: `sbmcp_${cards.length}` }
    },
    announceRow() {},
    async stopChild() {},
    remoteChildren: () => ({ flagOn: true, onVm: false }),
    machineEntries: async () => Object.entries(machines).map(([id, m]) => machineEntry(id, m.name)),
    startRemoteChild: (machineId, request) => clients.invoke(machineId, HubRemoteChannels.START_CHILD, request),
  }
  const io: Partial<HubStartIo> = {
    freeBytes: async () => 100 * GIB,
    checkoutBytes: async () => GIB,
    dirBytes: async () => GIB,
    planDeps: async () => [],
    prepareDeps: async () => ({ folders: [] }),
    checkDeps: async () => [],
    isMainCheckout: async () => false,
    commitOf: async () => SHA,
    remoteUrls: async () => [REPO],
    remoteBranchesContaining: async () => ['origin/main'],
    upstreamOf: async () => 'origin/main',
    remoteOfBranch: async (_cwd, b) => ({ url: 'https://tok@github.com/me/repo.git', branch: b.slice(7) }),
  }
  const starter = new HubStarter(host, (key) => settings[key] ?? null, io)
  return { starter, started, cards, clients, worktrees }
}

const parent = (mode: RuntimeMode = 'auto'): HubParentContext => ({
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

/** Propose and approve a batch; resolves once no child of it is still `starting` on the desktop. */
async function runBatch(d: ReturnType<typeof desktop>, tasks: HubTask[], mode: RuntimeMode = 'auto') {
  const r = await d.starter.propose(parent(mode), tasks)
  expect(r.isError, JSON.stringify(r)).toBeFalsy()
  await d.starter.approve(d.cards.at(-1)!, mode)
  await until(() => db.listHubChildren('agent_parent').every((c) => c.phase !== 'starting'))
  return db.listHubChildren('agent_parent')
}

describe('hub-remote:start-child, desktop and child machine', () => {
  it('starts the child on its machine with a parent stub there, and records the machine here', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { name: 'Work VM', url: vm.url } })
    const [child] = await runBatch(d, [task('Remote', { machine: 'vm1', account: 'claude-vm2', model: 'opus' })])
    expect(child).toMatchObject({ phase: 'open', machineId: 'vm1', grantedMode: 'auto' })
    expect(d.started).toEqual([])

    const there = vm.dbm.getHubChild(child!.childId)
    expect(there).toMatchObject({
      parentId: 'agent_parent',
      phase: 'open',
      grantedMode: 'auto',
      providerInstanceId: 'claude-vm2',
      machineId: null,
      baseSha: SHA,
    })
    const installId = db.hubInstallId()
    expect(vm.dbm.getHubParent('agent_parent')).toMatchObject({ remoteHub: installId })
    expect(vm.fetches).toEqual([['/home/u/src/repo', 'origin', 'main', SHA]])
    expect(vm.worktrees[0]).toMatchObject({
      repository: { projectPath: '/home/u/src/repo', machineId: 'local' },
      checkout: { baseRef: SHA, location: 'managed-in-repo', branch: { namespace: 'hub' } },
      owner: { conversationId: child!.childId },
    })
    expect(vm.sessions).toMatchObject([{ threadId: child!.childId, runtimeMode: 'auto', instanceId: 'claude-vm2' }])
    // The child is open there: its gates hold for its parent stub.
    expect(vm.starter.parentOfOpenChild(child!.childId)).toBe('agent_parent')
    expect(db.listPendingHubWakes('agent_parent')).toEqual([])
  })

  it('answers a repeated start with the state it has and starts nothing again', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { name: 'Work VM', url: vm.url } })
    const [child] = await runBatch(d, [task('Remote', { machine: 'vm1' })])
    const again = (await d.clients.invoke('vm1', HubRemoteChannels.START_CHILD, {
      ...requestFor(child!.childId),
      desktopInstallId: db.hubInstallId(),
    })) as unknown
    expect(again).toEqual({ ok: true, phase: 'open', mode: 'auto' })
    expect(vm.sessions).toHaveLength(1)
    // Another hub naming the same child id is refused.
    const other = await d.clients.invoke('vm1', HubRemoteChannels.START_CHILD, {
      ...requestFor(child!.childId),
      desktopInstallId: 'hub-other',
    })
    expect(other).toMatchObject({ ok: false })
  })

  it('caps the mode at hub.remoteMaxMode there and records the mode used here', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { name: 'Work VM', url: vm.url } })
    const [child] = await runBatch(d, [task('Remote', { machine: 'vm1', mode: 'full-access' })], 'full-access')
    expect(child).toMatchObject({ phase: 'open', grantedMode: 'auto' })
    expect(vm.sessions[0]!.runtimeMode).toBe('auto')

    vm.settings['hub.remoteMaxMode'] = 'full-access'
    const [, second] = await runBatch(d, [task('Full', { machine: 'vm1', mode: 'full-access' })], 'full-access')
    expect(second).toMatchObject({ phase: 'open', grantedMode: 'full-access' })
  })

  it('refuses with the flag off there, naming the machine in the failed wake', async () => {
    const vm = await bootVm()
    vm.flag.on = false
    const d = desktop({ vm1: { name: 'Work VM', url: vm.url } })
    const [child] = await runBatch(d, [task('Remote', { machine: 'vm1' })])
    expect(child!.phase).toBe('failed_start')
    expect(db.listPendingHubWakes('agent_parent')[0]).toMatchObject({
      kind: 'failed',
      summary: 'Failed to start: Work VM does not take children: turn on hub_remote_children there.',
    })
    expect(vm.dbm.getHubChild(child!.childId)).toBeNull()
  })

  it('refuses over hub.remoteChildrenPerMachine there', async () => {
    const vm = await bootVm()
    vm.settings['hub.remoteChildrenPerMachine'] = '1'
    const d = desktop({ vm1: { name: 'Work VM', url: vm.url } })
    const [a, b] = await runBatch(d, [task('A', { machine: 'vm1' }), task('B', { machine: 'vm1' })])
    const phases = [a!.phase, b!.phase].sort()
    expect(phases).toEqual(['failed_start', 'open'])
    expect(db.listPendingHubWakes('agent_parent')[0]!.summary).toBe(
      'Failed to start: Work VM runs 1 children from other machines already (limit 1).',
    )
  })

  it('says to update a backend that has no start channel', async () => {
    const vm = await bootVm({ handler: false })
    const d = desktop({ vm1: { name: 'Work VM', url: vm.url } })
    const [child] = await runBatch(d, [task('Remote', { machine: 'vm1' })])
    expect(child!.phase).toBe('failed_start')
    expect(db.listPendingHubWakes('agent_parent')[0]!.summary).toBe('Failed to start: update the backend on Work VM.')
  })

  it('fails one machine without touching the other machine or the local child', async () => {
    const vm = await bootVm()
    const old = await bootVm({ handler: false })
    const d = desktop({ vm1: { name: 'Work VM', url: vm.url }, box: { name: 'Box', url: old.url } })
    const rows = await runBatch(d, [task('Here'), task('VM', { machine: 'vm1' }), task('Box', { machine: 'box' })])
    const by = (title: string) => rows.find((c) => c.title === title)!
    expect(by('Here')).toMatchObject({ phase: 'open', machineId: null })
    expect(by('VM')).toMatchObject({ phase: 'open', machineId: 'vm1' })
    expect(by('Box')).toMatchObject({ phase: 'failed_start', machineId: 'box' })
    expect(d.started.map((s) => s.threadId)).toEqual([by('Here').childId])
    expect(db.listPendingHubWakes('agent_parent').map((w) => w.childId)).toEqual([by('Box').childId])
  })
})

/** A request as the desktop would send it, for calls straight to a child machine. */
function requestFor(childId: string, over: Partial<HubRemoteStartRequest> = {}): HubRemoteStartRequest {
  return {
    v: 1,
    desktopInstallId: 'hub-desk',
    parentId: 'agent_parent',
    childId,
    title: 'Remote',
    brief: 'Do it',
    agent: 'claude-code',
    instanceId: 'claude-vm',
    model: null,
    grantedMode: 'auto',
    baseSha: SHA,
    fetch: { remoteBranch: 'main' },
    repoUrl: REPO,
    remoteProjectPath: '~/src/repo',
    clonePlanned: false,
    deps: 'link',
    ...over,
  }
}

describe('startRemote on the child machine', () => {
  it('clones a planned checkout first, then fetches and starts there', async () => {
    const vm = await bootVm()
    const answer = await vm.starter.startRemote(
      requestFor('agent_c1', { remoteProjectPath: '~/projects/repo', clonePlanned: true }),
    )
    expect(answer).toEqual({ ok: true, phase: 'open', mode: 'auto' })
    expect(vm.clones).toEqual([[REPO, 'main', '/home/u/projects/repo']])
    expect(vm.fetches).toEqual([['/home/u/projects/repo', 'origin', 'main', SHA]])
  })

  it('clones once for two children that plan the same clone', async () => {
    let vm!: Vm
    vm = await bootVm({
      io: {
        async clone(url, branch, dest) {
          vm.clones.push([url, branch, dest])
          // The folder exists at once; the remote only once the clone is done.
          vm.dirs.add(dest)
          await new Promise((r) => setTimeout(r, 30))
          vm.remotes.set(dest, [{ name: 'origin', url }])
        },
      },
    })
    const start = (id: string) =>
      vm.starter.startRemote(requestFor(id, { remoteProjectPath: '~/projects/repo', clonePlanned: true }))
    const answers = await Promise.all([start('agent_d1'), start('agent_d2')])
    expect(answers).toEqual([
      { ok: true, phase: 'open', mode: 'auto' },
      { ok: true, phase: 'open', mode: 'auto' },
    ])
    expect(vm.clones).toHaveLength(1)
  })

  it('answers a failure without this machine home folder', async () => {
    const vm = await bootVm({
      io: {
        async clone(_url, _branch, dest) {
          throw new Error(`${dest} already exists on this machine and is not empty.`)
        },
      },
    })
    const answer = await vm.starter.startRemote(
      requestFor('agent_h1', { remoteProjectPath: '~/projects/repo', clonePlanned: true }),
    )
    expect(answer).toEqual({ ok: false, error: '~/projects/repo already exists on this machine and is not empty.' })
  })

  it('refuses a missing folder when no clone was planned, and a folder of another remote', async () => {
    const vm = await bootVm()
    const missing = await vm.starter.startRemote(requestFor('agent_c2', { remoteProjectPath: '~/projects/repo' }))
    expect(missing).toEqual({
      ok: false,
      error: '~/projects/repo is not on this machine, and no clone was planned.',
    })
    vm.remotes.set('/home/u/src/repo', [{ name: 'origin', url: 'git@github.com:someone/else.git' }])
    const other = await vm.starter.startRemote(requestFor('agent_c3'))
    expect(other).toMatchObject({ ok: false, error: expect.stringContaining('is not a checkout of') })
    expect(vm.sessions).toEqual([])
    // Each failed child is a stored failed wake for the stub, never a turn.
    expect(vm.dbm.listPendingHubWakes('agent_parent').map((w) => w.kind)).toEqual(['failed', 'failed'])
  })

  it('refuses an account it does not have, and a request that does not parse', async () => {
    const vm = await bootVm()
    expect(await vm.starter.startRemote(requestFor('agent_c4', { instanceId: 'nope-vm' }))).toMatchObject({
      ok: false,
    })
    expect(await vm.starter.startRemote({ ...requestFor('agent_c5'), repoUrl: '/srv/repo.git' })).toEqual({
      ok: false,
      error: 'The start request has an invalid repoUrl.',
    })
    expect(vm.dbm.getHubChild('agent_c4')).toBeNull()
  })
})

describe('the start request', () => {
  it('sends a remote URL without credentials, keeping an ssh login', () => {
    expect(hubRepoUrl('https://tok@github.com/me/repo.git?x=1')).toBe('https://github.com/me/repo.git')
    expect(hubRepoUrl('ssh://git@host:22/me/repo')).toBe('ssh://git@host:22/me/repo')
    expect(hubRepoUrl('ssh://git:pw@host/me/repo')).toBe('ssh://host/me/repo')
    expect(hubRepoUrl('git@github.com:me/repo.git')).toBe('git@github.com:me/repo.git')
    expect(hubRepoUrl('/srv/repo.git')).toBeNull()
    expect(hubRepoUrl('file:///srv/repo.git')).toBeNull()
    expect(hubRepoUrl('ext::sh -c x')).toBeNull()
  })

  it('refuses unsafe fields', () => {
    const bad = (over: Record<string, unknown>) => parseHubRemoteStartRequest({ ...requestFor('agent_x'), ...over }).ok
    expect(bad({})).toBe(true)
    expect(bad({ remoteProjectPath: '~/../etc' })).toBe(false)
    expect(bad({ remoteProjectPath: 'relative/path' })).toBe(false)
    expect(bad({ fetch: { remoteBranch: '--upload-pack=x' } })).toBe(false)
    expect(bad({ repoUrl: 'https://u:p@github.com/me/repo' })).toBe(false)
    expect(bad({ grantedMode: 'root' })).toBe(false)
    expect(bad({ baseSha: 'HEAD' })).toBe(false)
  })
})

describe('real git: fetch from a configured remote at the base commit', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim()

  it('fetches the pushed base through the remote whose URL matches, and refuses a commit not on it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'sb-hub-remote-'))
    dirs.push(root)
    const origin = join(root, 'origin.git')
    const desk = join(root, 'desk')
    const vmCheckout = join(root, 'vm')
    git(root, 'init', '--bare', '-b', 'main', origin)
    git(root, 'clone', origin, desk)
    git(desk, 'commit', '--allow-empty', '-m', 'a')
    git(desk, 'push', 'origin', 'HEAD:main')
    git(root, 'clone', origin, vmCheckout)
    // The VM names the remote by its network URL; insteadOf maps it to the test's bare repo.
    git(vmCheckout, 'remote', 'set-url', 'origin', REPO)
    git(vmCheckout, 'config', `url.${origin}.insteadOf`, REPO)
    git(desk, 'commit', '--allow-empty', '-m', 'b')
    git(desk, 'push', 'origin', 'HEAD:main')
    const base = git(desk, 'rev-parse', 'HEAD')

    const worktrees: WorktreeCreationRequest[] = []
    const starter = new HubStarter(
      {
        async createWorktree(request) {
          worktrees.push(request)
          return { status: 'ready', worktreePath: join(vmCheckout, 'wt') } as never
        },
        startSession: async () => ({}),
        submitTurn: async () => ({ status: 'accepted' }) as never,
        openCard: () => ({ ok: false, message: 'none' }),
        announceRow() {},
        async stopChild() {},
        remoteChildren: () => ({ flagOn: true, onVm: true }),
      },
      () => null,
      {
        homeDir: () => root,
        freeBytes: async () => 100 * GIB,
        checkoutBytes: async () => 1,
        dirBytes: async () => 1,
        planDeps: async () => [],
        prepareDeps: async () => ({ folders: [] }),
      },
    )
    const answer = await starter.startRemote(
      requestFor('agent_git', { baseSha: base, remoteProjectPath: '~/vm', desktopInstallId: 'hub-git' }),
    )
    expect(answer).toEqual({ ok: true, phase: 'open', mode: 'auto' })
    expect(git(vmCheckout, 'cat-file', '-t', base)).toBe('commit')
    expect(worktrees[0]!.checkout.baseRef).toBe(base)
    // The scratch ref is gone again.
    expect(git(vmCheckout, 'for-each-ref', 'refs/switchboard')).toBe('')

    const stray = await starter.startRemote(
      requestFor('agent_git2', { baseSha: 'c'.repeat(40), remoteProjectPath: '~/vm', desktopInstallId: 'hub-git' }),
    )
    expect(stray).toMatchObject({ ok: false })
  })
})

describe('local paths skip a child on another machine', () => {
  const seedRemote = (phase: 'starting' | 'open') => {
    db.ensureHubParent('agent_parent')
    db.insertHubChild({
      childId: `agent_r_${phase}`,
      parentId: 'agent_parent',
      batchId: `hb_${phase}`,
      ordinal: 0,
      title: 'R',
      brief: 'b',
      location: 'worktree',
      grantedMode: 'auto',
      depsMode: 'none',
      providerInstanceId: 'claude-vm',
      machineId: 'vm1',
    })
    if (phase === 'open') db.updateHubChild(`agent_r_${phase}`, { phase: 'open' })
  }

  it('recovery leaves it starting with no wake; the reaper and sampler lists leave it out', () => {
    seedRemote('starting')
    seedRemote('open')
    const d = desktop({})
    d.starter.recoverInterrupted()
    expect(db.getHubChild('agent_r_starting')!.phase).toBe('starting')
    expect(db.listPendingHubWakes('agent_parent')).toEqual([])
    expect(db.listHubChildrenInPhase('open')).toEqual([])
    expect(db.listHubChildrenInPhase('open', { includeRemote: true }).map((c) => c.childId)).toEqual(['agent_r_open'])
  })

  it('counts it for its parent run slots, never for a local account', async () => {
    seedRemote('open')
    const d = desktop({}, { 'hub.runningPerParent': '1' })
    expect(d.starter.remoteSlots()).toEqual([{ providerInstanceId: 'vm1:claude-vm', parentId: 'agent_parent' }])
    await d.starter.propose(parent('auto'), [task('Local')])
    await until(() => db.listHubChildren('agent_parent').some((c) => c.title === 'Local'))
    const local = db.listHubChildren('agent_parent').find((c) => c.title === 'Local')!
    await until(() => d.starter.waitingForSlot(local.childId))
    expect(d.started).toEqual([])
  })
})

describe('a local batch', () => {
  it('prepares every child while an earlier one waits for a run slot', async () => {
    const d = desktop({}, { 'hub.runningPerInstance': '1' })
    const r = await d.starter.propose(parent('auto'), [task('A'), task('B'), task('C')])
    expect(r.isError, JSON.stringify(r)).toBeFalsy()
    await until(() => d.worktrees.length === 3)
    expect(d.started).toHaveLength(1)
  })
})

describe('a parent stub', () => {
  it('keeps its wakes stored and never gets a turn', async () => {
    expect(db.claimHubParentStub('agent_stub', 'hub-desk')).toBe(true)
    expect(db.claimHubParentStub('agent_stub', 'hub-other')).toBe(false)
    const sent: string[] = []
    const wakes = new HubWakeScheduler({
      enabled: () => true,
      liveThread: () => 'agent_stub',
      idle: () => true,
      send: async (threadId) => {
        sent.push(threadId)
        return true
      },
      interrupt: async () => {},
      commitUpdate: () => ({ messageId: 'm', at: 1 }),
      announce() {},
      changed() {},
    })
    cleanups.push(() => wakes.stop())
    wakes.record({ parentId: 'agent_stub', childId: 'agent_child', kind: 'report', summary: 'done', pointer: null })
    wakes.start()
    wakes.poke('agent_stub')
    await new Promise((r) => setTimeout(r, 20))
    expect(sent).toEqual([])
    expect(db.listPendingHubWakes('agent_stub')).toHaveLength(1)
  })
})

describe('an older database', () => {
  it('gains remote_hub and machine_id, and its rows read as local', () => {
    const old = createMigratedDb()
    old.exec(`
      DROP TABLE hub_children;
      DROP TABLE hub_parents;
      CREATE TABLE hub_parents (parent_id TEXT PRIMARY KEY, held INTEGER NOT NULL DEFAULT 0, held_reason TEXT,
        held_at INTEGER, updated_at INTEGER NOT NULL);
      CREATE TABLE hub_children (child_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, batch_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, location TEXT NOT NULL, creation_id TEXT,
        branch TEXT, base_ref TEXT, base_sha TEXT, provider_instance_id TEXT, requested_model TEXT,
        granted_mode TEXT NOT NULL, deps_mode TEXT NOT NULL, deps_json TEXT, phase TEXT NOT NULL,
        moved_after_limit_turn_id TEXT, settled_at INTEGER, settle_json TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, UNIQUE (batch_id, ordinal));
      INSERT INTO hub_parents (parent_id, updated_at) VALUES ('p_old', 1);
      INSERT INTO hub_children (child_id, parent_id, batch_id, ordinal, title, brief, location, granted_mode,
        deps_mode, phase, created_at, updated_at) VALUES ('c_old', 'p_old', 'b', 0, 't', 'b', 'worktree', 'auto',
        'none', 'open', 1, 1);
    `)
    db.migrate(old)
    db.migrate(old)
    expect(db.getHubParent('p_old')).toMatchObject({ remoteHub: null })
    expect(db.getHubChild('c_old')).toMatchObject({ machineId: null, phase: 'open' })
    expect(db.listHubChildrenInPhase('open').map((c) => c.childId)).toEqual(['c_old'])
  })
})
