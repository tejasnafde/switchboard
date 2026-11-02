/**
 * Children on other machines, launch and failure polish: which machines the
 * desktop connects at launch, the `restart` wakes a child machine writes after
 * its backend starts again, the accounts `hub-remote:describe` lists on a VM,
 * and the worktree a failed remote start leaves behind.
 */
import { createMigratedDb } from './helpers/test-db'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string | null) => ({ id: id ?? `${agentType}-default`, agentType }),
  listProviderInstances: () => [],
}))

import {
  addProject,
  claimHubParentStub,
  createConversation,
  ensureHubParent,
  getHubChild,
  insertHubChild,
  lastHubWakeOf,
  listHubOutbox,
  listOpenRemoteHubChildren,
  listPendingHubWakes,
  setConversationWorktree,
  updateHubChild,
} from '../../src/main/db/database'
import { machinesToReconnect, reconnectOnLaunch } from '../../src/main/hub/hub-launch-reconnect'
import { HubStarter, configureHubWorktrees, type HubStartHost } from '../../src/main/hub/hub-start'
import { accountHasLogin } from '../../src/main/hub/hub-remote-describe'
import { buildHubMachineDescription, planRemoteTask, type HubRemoteStartRequest } from '../../src/shared/hub-remote'
import type { ProviderInstanceWire } from '../../src/main/db/provider-instances'
import type { ConnectionStatus } from '../../src/main/machines/connection-status'

const GIB = 1024 ** 3
const SHA = 'b'.repeat(40)
const REPO = 'https://github.com/me/repo.git'
const DESK = 'hub-desk'

beforeEach(() => {
  createMigratedDb()
})

describe('reconnect on launch', () => {
  const deps = (over: Partial<Parameters<typeof machinesToReconnect>[0]> = {}) => ({
    flagOn: () => true,
    setting: () => null,
    openChildMachineIds: () => ['m1', 'm2', 'm1', 'gone'],
    savedMachineIds: () => ['m1', 'm2', 'm3'],
    statusOf: (): ConnectionStatus => 'offline',
    ...over,
  })

  it('picks each saved machine with open children once, and none that is already connecting', () => {
    expect(machinesToReconnect(deps())).toEqual(['m1', 'm2'])
    expect(machinesToReconnect(deps({ statusOf: (id) => (id === 'm1' ? 'connecting' : 'offline') }))).toEqual(['m2'])
  })

  it('picks none with the setting off, the flag off, or no open children', () => {
    expect(machinesToReconnect(deps({ setting: () => 'false' }))).toEqual([])
    expect(machinesToReconnect(deps({ flagOn: () => false }))).toEqual([])
    expect(machinesToReconnect(deps({ openChildMachineIds: () => [] }))).toEqual([])
    expect(machinesToReconnect(deps({ setting: () => 'true' }))).toEqual(['m1', 'm2'])
  })

  it('connects through the given path; a failed connect leaves the others going', async () => {
    const status = new Map<string, ConnectionStatus>()
    const tried: string[] = []
    await reconnectOnLaunch({
      ...deps(),
      statusOf: (id) => status.get(id) ?? 'offline',
      connect: async (id) => {
        tried.push(id)
        if (id === 'm1') throw new Error('Permission denied (publickey)')
        status.set(id, 'connected')
      },
    })
    expect(tried).toEqual(['m1', 'm2'])
    expect(status.get('m2')).toBe('connected')
  })

  it('reads only open children on other machines: no failed start, no local child', () => {
    insertHubChild({ ...childRow('agent_r1', 'agent_parent'), machineId: 'm1' })
    insertHubChild({ ...childRow('agent_r2', 'agent_parent'), machineId: 'm2' })
    updateHubChild('agent_r2', { phase: 'failed_start' })
    insertHubChild(childRow('agent_local', 'agent_parent'))
    expect(listOpenRemoteHubChildren().map((c) => c.machineId)).toEqual(['m1'])
  })
})

function childRow(childId: string, parentId: string) {
  return {
    childId,
    parentId,
    batchId: `remote-${childId}`,
    ordinal: 0,
    title: 'Child',
    brief: 'b',
    location: 'worktree' as const,
    grantedMode: 'auto' as const,
    depsMode: 'none',
  }
}

function host(over: Partial<HubStartHost> = {}): HubStartHost & { stopped: string[] } {
  const stopped: string[] = []
  return {
    stopped,
    async createWorktree(request) {
      const id = request.owner.kind === 'conversation' ? request.owner.conversationId : ''
      const path = `/wt/${id}`
      createConversation(id, request.repository.projectPath, 'claude-code', 'Child')
      setConversationWorktree(id, path, `hub/${id}`)
      return { status: 'ready', worktreePath: path, branch: `hub/${id}` } as never
    },
    async startSession() {
      return {}
    },
    async submitTurn() {
      return { status: 'accepted' } as never
    },
    openCard: () => ({ ok: false, message: 'no cards here' }),
    announceRow() {},
    async stopChild(childId) {
      stopped.push(childId)
    },
    remoteChildren: () => ({ flagOn: true, onVm: true }),
    ...over,
  }
}

describe('a child machine after its backend restarts', () => {
  it('gives each open child of a parent stub one restart wake, in the outbox, and none to a local child', () => {
    claimHubParentStub('agent_parent', DESK)
    insertHubChild(childRow('agent_open', 'agent_parent'))
    updateHubChild('agent_open', { phase: 'open' })
    insertHubChild(childRow('agent_starting', 'agent_parent'))
    ensureHubParent('agent_local_parent')
    insertHubChild(childRow('agent_local', 'agent_local_parent'))
    updateHubChild('agent_local', { phase: 'open' })

    const starter = new HubStarter(host(), () => null)
    starter.recoverInterrupted()
    // A second start with no message in between adds no second wake.
    new HubStarter(host(), () => null).recoverInterrupted()

    const items = listHubOutbox(DESK, { limit: 50 }).items
    const kinds = items.map((i) => [i.childId, i.kind === 'wake' ? i.wake.kind : i.kind])
    expect(kinds).toEqual([
      ['agent_starting', 'failed'],
      ['agent_open', 'restart'],
    ])
    expect(getHubChild('agent_starting')!.phase).toBe('failed_start')
    expect(getHubChild('agent_open')!.phase).toBe('open')
    expect(lastHubWakeOf('agent_local')).toBeNull()
    expect(listPendingHubWakes('agent_local_parent')).toEqual([])
  })
})

describe('accounts hub-remote:describe lists on a machine reached over SSH', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    vi.unstubAllEnvs()
  })
  const wire = (over: Partial<ProviderInstanceWire>): ProviderInstanceWire =>
    ({
      id: 'x',
      agentType: 'claude-code',
      displayName: 'X',
      accentColor: null,
      authMode: 'oauth_dir',
      envKeys: [],
      oauthDir: null,
      effectiveOauthDir: null,
      effectiveOauthDirSource: 'default',
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
      ...over,
    }) as ProviderInstanceWire

  it('counts an account with a login file or a key, and not one with neither', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '')
    const signed = mkdtempSync(join(tmpdir(), 'sb-hub-login-'))
    const empty = mkdtempSync(join(tmpdir(), 'sb-hub-login-'))
    dirs.push(signed, empty)
    writeFileSync(join(signed, '.credentials.json'), '{"x":1}')
    expect(await accountHasLogin(wire({ effectiveOauthDir: signed }))).toBe(true)
    expect(await accountHasLogin(wire({ effectiveOauthDir: empty }))).toBe(false)
    expect(await accountHasLogin(wire({ effectiveOauthDir: empty, envKeys: ['ANTHROPIC_API_KEY'] }))).toBe(true)
    expect(await accountHasLogin(wire({ agentType: 'opencode', effectiveOauthDir: empty }))).toBe(true)
  })

  it('an agent left with no signed-in account is not listed, so a task on it is refused', () => {
    const d = buildHubMachineDescription({
      flagOn: true,
      os: 'linux',
      arch: 'x64',
      backendVersion: '1.0.0',
      availableAgents: ['claude-code', 'codex'],
      homeDir: '/home/u',
      instances: [{ id: 'claude-vm', agentType: 'claude-code', displayName: 'VM', enabled: true }],
      projects: [{ path: '/home/u/src/repo', branch: 'main', remoteUrls: [REPO] }],
      freeDiskBytes: 100 * GIB,
      openChildren: 0,
      runningSlotKeys: [],
      runningPerInstance: 3,
    })
    expect(d.agents.map((a) => a.agent)).toEqual(['claude-code'])
    const planned = planRemoteTask({
      n: 1,
      machineId: 'm1',
      agent: 'codex',
      location: 'worktree',
      entries: [
        {
          id: 'm1',
          name: 'gpu-box',
          transport: 'ssh',
          status: 'connected',
          description: d,
          ageMs: 1_000,
          problem: null,
          canStart: true,
        },
      ],
      parentRemoteUrls: [REPO],
    })
    expect(planned).toEqual({
      ok: false,
      message: 'Task 1: Codex has no login on gpu-box. Log in there first (claude, codex login, opencode auth login).',
    })
  })
})

describe('a failed start of a child from another machine', () => {
  const actions: Array<{ creationId: string; action: string }> = []
  beforeEach(() => {
    actions.length = 0
    addProject('/home/u/src/repo', 'repo')
    addProject('/repo', 'repo')
    configureHubWorktrees({
      createWorktreeTransaction: async () => {
        throw new Error('not used')
      },
      getWorktreeCreation: async (key: { creationId: string }) =>
        ({
          revision: 1,
          owner: { kind: 'conversation', conversationId: key.creationId.replace(/^remote-/, '').replace(/-0$/, '') },
        }) as never,
      actOnWorktreeCreation: async (input: { creationId: string; action: string }) => {
        actions.push({ creationId: input.creationId, action: input.action })
        return { cleanupDisposition: 'removed' } as never
      },
    } as never)
  })

  const request = (childId: string): HubRemoteStartRequest => ({
    v: 1,
    desktopInstallId: DESK,
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
    deps: 'none',
  })

  const io = {
    homeDir: () => '/home/u',
    isDir: async () => true,
    configuredRemotes: async () => [{ name: 'origin', url: REPO }],
    fetchBase: async () => {},
    freeBytes: async () => 100 * GIB,
    checkoutBytes: async () => GIB,
    dirBytes: async () => GIB,
    planDeps: async () => [],
    prepareDeps: async () => ({ folders: [] }),
    checkDeps: async () => [],
  }

  it('stops its session and removes the worktree and branch its creation made', async () => {
    const h = host({
      async submitTurn() {
        return { status: 'rejected', reason: 'no login' } as never
      },
    })
    const starter = new HubStarter(h, () => null, io)
    const answer = await starter.startRemote(request('agent_failed'))
    expect(answer).toMatchObject({ ok: false })
    expect(getHubChild('agent_failed')!.phase).toBe('failed_start')
    await vi.waitFor(() => expect(actions).toEqual([{ creationId: 'remote-agent_failed-0', action: 'remove' }]))
    expect(h.stopped).toEqual(['agent_failed'])
  })

  it('keeps the worktree of a local child that failed to start', async () => {
    ensureHubParent('agent_parent')
    insertHubChild(childRow('agent_local', 'agent_parent'))
    createConversation('agent_local', '/repo', 'claude-code', 'Child')
    setConversationWorktree('agent_local', '/wt/agent_local', 'hub/agent_local')
    const starter = new HubStarter(host(), () => null, io)
    // A local failed start goes through the same fail path; nothing is removed for it.
    ;(starter as unknown as { fail: (p: string, c: { childId: string }, e: unknown) => void }).fail(
      'agent_parent',
      { childId: 'agent_local' },
      new Error('boom'),
    )
    await new Promise((r) => setTimeout(r, 10))
    expect(getHubChild('agent_local')!.phase).toBe('failed_start')
    expect(actions).toEqual([])
  })
})
