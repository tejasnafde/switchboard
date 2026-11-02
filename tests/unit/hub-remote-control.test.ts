/**
 * Children on other machines, after the start: a child machine (a `WsHost` on
 * 127.0.0.1 with the production `hub-remote:*` control handlers, its own
 * database loaded again after `vi.resetModules`) answers view, read, deliver,
 * interrupt, stop, move and stop-all for a child of that desktop's parent stub
 * only; the desktop calls it through the real hub client (`RemoteHubClients`)
 * and `HubRemoteControl`, which keeps a Stop for a machine that is not
 * connected in `hub_remote_pending` until its next connect.
 */
import { createMigratedDb } from './helpers/test-db'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import Database from 'better-sqlite3'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const db = await import('../../src/main/db/database')
const { ensureHubSchema } = await import('../../src/main/db/hubs')
const { WsHost } = await import('../../src/main/backend/ws-host')
const { RemoteHubClients, HubRemoteCallError } = await import('../../src/main/hub/remote-hub-clients')
const { HubRemoteControl, HUB_REMOTE_PENDING_MAX_ATTEMPTS } = await import('../../src/main/hub/hub-remote-control')
const { HubSettler } = await import('../../src/main/hub/hub-settle')
const { readChild } = await import('../../src/main/hub/hub-read')
const { toolText } = await import('../../src/main/mcp/mcp-session')
const { HubRemoteChannels } = await import('../../src/shared/ipc-channels')
const { childStateLabel } = await import('../../src/shared/hub')
const { HUB_REMOTE_READ_LATER_TEXT, HUB_REMOTE_STOP_LATER_TEXT } = await import('../../src/shared/hub-remote')
const {
  hubMoveTargetPlace,
  HUB_REMOTE_VIEW_MAX_AGE_MS,
  HUB_REMOTE_VIEW_MAX_CHILDREN,
  parseHubRemoteDeliverRequest,
  parseHubRemoteSettleRow,
  parseHubRemoteStopRequest,
} = await import('../../src/shared/hub-remote-control')

import type { ConnectionStatus } from '../../src/main/machines/connection-status'
import type { HubChildRow } from '../../src/main/db/hubs'
import type { HubRemoteServeDeps } from '../../src/main/hub/hub-remote-serve'
import type { HubRemoteChildState } from '../../src/shared/hub-remote-control'
import type { TransportSocket } from '../../src/shared/ws-transport'

const TOKEN = 'server-token-abc'
const PARENT = 'agent_parent'
const HEAD = 'a'.repeat(40)

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

const child = (childId: string, extra: Partial<HubChildRow> = {}, parentId = PARENT) => ({
  childId,
  parentId,
  batchId: `b_${childId}`,
  ordinal: 0,
  title: `Title ${childId}`,
  brief: 'Do it',
  location: 'worktree' as const,
  grantedMode: 'auto' as const,
  depsMode: 'none' as const,
  ...extra,
})

const state = (childId: string, extra: Partial<HubRemoteChildState> = {}): HubRemoteChildState => ({
  childId,
  phase: 'open',
  state: 'working',
  limit: 'none',
  waitingForSlot: false,
  account: 'claude-vm',
  model: 'opus',
  mode: 'auto',
  branch: `hub/${childId}`,
  worktree: '~/projects/app/.switchboard/worktrees/x',
  git: { ahead: 2, behind: 0, dirty: true, diffstat: '1 file changed' },
  lastTurn: { usedTokens: 42_000, costUsd: null },
  resources: { rssMb: 300, cpuPct: 12, processes: 4 },
  diskMb: 120,
  lastActivityAt: 1_000,
  lastWake: null,
  nativeSubagents: { running: 0, done: 1, failed: 0 },
  ...extra,
})

/** A socket that sees a backend from before this PR: its `ready` lacks `hub_remote_control_v1`. */
function noControlSocket(url: string): TransportSocket {
  const ws = new WebSocket(url)
  const add = ws.addEventListener.bind(ws) as TransportSocket['addEventListener']
  ws.addEventListener = ((type: string, listener: (e: unknown) => void) => {
    if (type !== 'message') return add(type as never, listener as never)
    add('message', (e: MessageEvent) => {
      const frame = JSON.parse(String(e.data)) as { k?: string; capabilities?: string[] }
      if (frame.k !== 'ready') return listener(e)
      frame.capabilities = frame.capabilities?.filter((c) => c !== 'hub_remote_control_v1')
      listener({ data: JSON.stringify(frame) })
    })
  }) as typeof ws.addEventListener
  return ws as unknown as TransportSocket
}

/** A child machine: its own database, the production control handlers, and deps that record what they were asked. */
async function bootVm() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  const host = new WsHost(wss, TOKEN)
  cleanups.push(() => {
    host.dispose()
    wss.close()
  })
  await new Promise<void>((resolve) => wss.on('listening', () => resolve()))
  vi.resetModules()
  const vmDb = await import('../../src/main/db/database')
  const { registerHubRemoteControlHandlers, HubRemoteChangeNotifier } =
    await import('../../src/main/hub/hub-remote-serve')
  const calls: Array<{ op: string; args: unknown[] }> = []
  const states = new Map<string, Partial<HubRemoteChildState>>()
  const deps: HubRemoteServeDeps = {
    childState: async (row) => state(row.childId, states.get(row.childId)),
    read: async (stubId, args) => {
      calls.push({ op: 'read', args: [stubId, args] })
      return toolText(`history of ${String(args.childId)}`)
    },
    deliver: async (c, text, delivery, fromLabel) => {
      calls.push({ op: 'deliver', args: [c.childId, text, delivery, fromLabel] })
    },
    interrupt: async (childId) => {
      calls.push({ op: 'interrupt', args: [childId] })
      return true
    },
    stop: async (childId, cascade) => {
      calls.push({ op: 'stop', args: cascade ? [childId, 'cascade'] : [childId] })
      return true
    },
    settleAll: async (stubId) => {
      calls.push({ op: 'settleAll', args: [stubId] })
      for (const c of vmDb.listHubChildren(stubId)) vmDb.updateHubChild(c.childId, { phase: 'settled' })
      return { ok: true }
    },
    settle: async (stubId, childId, parentHead) => {
      calls.push({ op: 'settle', args: [stubId, childId, parentHead] })
      // As `HubSettler.run` stores it.
      vmDb.updateHubChild(childId, {
        phase: 'settled',
        settleJson: JSON.stringify({ worktree: 'remove', keepReason: null }),
      })
      return {
        ok: true,
        row: {
          childId,
          title: 'vm title',
          branch: 'hub/x',
          merged: true,
          clean: true,
          blockers: [],
          worktree: 'remove',
        },
      }
    },
    move: async (stubId, parentMode, childId, instanceId) => {
      calls.push({ op: 'move', args: [stubId, parentMode, childId, instanceId] })
      return toolText(`Moved ${childId} to ${instanceId}.`)
    },
  }
  registerHubRemoteControlHandlers(host, deps)
  const notifier = new HubRemoteChangeNotifier((ids) => host.emit(HubRemoteChannels.CHILDREN_CHANGED, ids), 5)
  cleanups.push(() => notifier.dispose())
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  /** A child here of a desktop's parent: a parent stub owned by `installId`. */
  const adopt = (childId: string, installId: string, parentId = PARENT) => {
    vmDb.claimHubParentStub(parentId, installId)
    vmDb.insertHubChild(child(childId, {}, parentId))
    vmDb.updateHubChild(childId, { phase: 'open' })
  }
  /** A child of a parent chat on this machine. */
  const local = (childId: string, parentId: string) => {
    vmDb.ensureHubParent(parentId)
    vmDb.insertHubChild(child(childId, {}, parentId))
    vmDb.updateHubChild(childId, { phase: 'open' })
  }
  const ops = (op: string) => calls.filter((c) => c.op === op).map((c) => c.args)
  return { host, url, dbm: vmDb, calls, ops, states, adopt, local, notifier, HubRemoteChangeNotifier }
}

interface DesktopOpts {
  enabled?: { on: boolean }
  createSocket?: (url: string) => TransportSocket
  now?: () => number
  status?: ConnectionStatus
  callTimeoutMs?: number
  onChanged?: (parentId: string) => void
  lastSeenAt?: (machineId: string) => number | null
}

/** The desktop: real hub client and control, its own rows for children on `vm1`. */
function desktop(machines: Record<string, { url: string }>, opts: DesktopOpts = {}) {
  const status = new Map<string, ConnectionStatus>(Object.keys(machines).map((id) => [id, opts.status ?? 'connected']))
  const enabled = opts.enabled ?? { on: true }
  const clients = new RemoteHubClients({
    enabled: () => enabled.on,
    machines: () => Object.keys(machines).map((id) => ({ id, name: `Machine ${id}`, transportKind: 'gcloud-iap' })),
    statusOf: (id) => status.get(id) ?? 'offline',
    urlOf: (id) => machines[id]?.url ?? null,
    tokenOf: () => TOKEN,
    ...(opts.createSocket ? { createSocket: opts.createSocket } : {}),
    ...(opts.callTimeoutMs ? { callTimeoutMs: opts.callTimeoutMs } : {}),
  })
  cleanups.push(() => clients.closeAll())
  const changed: string[] = []
  const invoked: string[] = []
  const stoppedStarting: Array<[string, boolean]> = []
  const makeControl = () =>
    new HubRemoteControl({
      enabled: () => enabled.on,
      installId: () => db.hubInstallId(),
      machineState: (id) => clients.machineState(id),
      machineName: (id) => clients.machineName(id),
      reconnecting: (id) => clients.reconnecting(id),
      ...(opts.lastSeenAt ? { lastSeenAt: opts.lastSeenAt } : {}),
      control: (id) => clients.controlOf(id),
      supportsControl: (id) => clients.supportsControl(id),
      invoke: (id, channel, ...args) => {
        invoked.push(channel)
        return clients.invoke(id, channel, ...args)
      },
      changed: (parentId) => {
        opts.onChanged?.(parentId)
        changed.push(parentId)
      },
      stoppedWhileStarting: (childId, there) => stoppedStarting.push([childId, there]),
      ...(opts.now ? { now: opts.now } : {}),
    })
  const control = makeControl()
  cleanups.push(
    clients.on(HubRemoteChannels.CHILDREN_CHANGED, (machineId, ids) => control.childrenChanged(machineId, ids)),
  )
  const own = (childId: string, machineId: string | null = 'vm1', parentId = PARENT) => {
    db.ensureHubParent(parentId)
    db.insertHubChild(child(childId, machineId ? { machineId } : {}, parentId))
    db.updateHubChild(childId, { phase: 'open' })
    return db.getHubChild(childId)!
  }
  const setStatus = (id: string, s: ConnectionStatus) => {
    status.set(id, s)
    clients.statusChanged(id, s)
  }
  return { clients, control, makeControl, own, setStatus, changed, invoked, enabled, stoppedStarting }
}

describe('view: the child machine answers its children, the desktop merges them', () => {
  it('reads the view, keeps it per machine, and shows its age and "offline" when the machine goes', async () => {
    const vm = await bootVm()
    let now = 1_000_000
    const d = desktop({ vm1: { url: vm.url } }, { now: () => now })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    await d.control.refreshParent(PARENT)
    const facts = d.control.factsOf(row)!
    expect(facts).toMatchObject({ machine: 'Machine vm1', connected: true, ageMs: 0, stopping: false })
    expect(facts.state).toMatchObject({ state: 'working', git: { ahead: 2 }, diskMb: 120, account: 'claude-vm' })
    expect(d.changed).toContain(PARENT)

    now += 3 * 60_000
    d.setStatus('vm1', 'offline')
    const offline = d.control.factsOf(row)!
    expect(offline).toMatchObject({ connected: false, ageMs: 180_000 })
    expect(offline.state?.state).toBe('working')
    const label = childStateLabel({
      state: 'working',
      waitingForSlot: false,
      remote: { machineId: 'vm1', machine: 'Machine vm1', connected: false, ageMs: 180_000, stopping: false },
    })
    expect(label).toBe('Machine vm1 offline, last seen 3 min ago')
  })

  it('with no view, ages an offline machine from when it was last seen, and marks a reconnect', () => {
    const now = 10_000_000
    const d = desktop(
      { vm1: { url: 'ws://127.0.0.1:1' } },
      { status: 'offline', now: () => now, lastSeenAt: () => now - 7_200_000 },
    )
    const row = d.own('agent_c1')
    expect(d.control.factsOf(row)).toMatchObject({ connected: false, state: null, ageMs: 7_200_000 })
    expect(d.control.factsOf(row)?.reconnecting).toBeUndefined()
    d.setStatus('vm1', 'connecting')
    expect(d.control.factsOf(row)).toMatchObject({ connected: false, reconnecting: true })
  })

  it('reads again on hub-remote:children-changed, and leaves out children it did not start there', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.adopt('agent_stranger', db.hubInstallId())
    await d.control.refreshParent(PARENT)
    expect(d.control.factsOf(row)!.state?.state).toBe('working')
    vm.states.set('agent_c1', { state: 'result_ready' })
    vm.notifier.changed(PARENT)
    await until(() => d.control.factsOf(row)!.state?.state === 'result_ready')
    expect(d.control.factsOf({ ...row, childId: 'agent_stranger' })?.state).toBeNull()
  })

  it('keeps every open child under the 64-row cap, then the newest settled ones', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    vm.dbm.claimHubParentStub(PARENT, db.hubInstallId())
    const ids = Array.from({ length: HUB_REMOTE_VIEW_MAX_CHILDREN + 6 }, (_, i) => `agent_v${i}`)
    for (const [i, id] of ids.entries()) {
      vm.dbm.insertHubChild(child(id, { ordinal: i }))
      // The two oldest stay open; every newer one is settled.
      vm.dbm.updateHubChild(id, { phase: i < 2 ? 'open' : 'settled' })
    }
    const answer = (await d.clients.invoke('vm1', HubRemoteChannels.VIEW, {
      v: 1,
      desktopInstallId: db.hubInstallId(),
      parentId: PARENT,
    })) as { children: HubRemoteChildState[] }
    const got = answer.children.map((c) => c.childId)
    expect(got).toHaveLength(HUB_REMOTE_VIEW_MAX_CHILDREN)
    expect(got.slice(0, 2)).toEqual(['agent_v0', 'agent_v1'])
    expect(got.at(-1)).toBe(ids.at(-1))
    expect(got).not.toContain('agent_v2')
  })

  it('sends children-changed ids in events of at most 64', async () => {
    const vm = await bootVm()
    const events: string[][] = []
    const notifier = new vm.HubRemoteChangeNotifier((ids) => events.push(ids), 1)
    cleanups.push(() => notifier.dispose())
    const parents = Array.from({ length: 130 }, (_, i) => `agent_p${i}`)
    for (const p of parents) {
      vm.dbm.claimHubParentStub(p, db.hubInstallId())
      notifier.changed(p)
    }
    await until(() => events.length === 3)
    expect(events.map((e) => e.length)).toEqual([64, 64, 2])
    expect(events.flat()).toEqual(parents)
  })

  it('reads a view at most every 15 s from a list call', async () => {
    const vm = await bootVm()
    let now = 5_000_000
    const d = desktop({ vm1: { url: vm.url } }, { now: () => now })
    d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    await d.control.refreshParent(PARENT)
    await d.control.refreshParent(PARENT)
    expect(d.invoked.filter((c) => c === HubRemoteChannels.VIEW)).toHaveLength(1)
    now += HUB_REMOTE_VIEW_MAX_AGE_MS
    await d.control.refreshParent(PARENT)
    expect(d.invoked.filter((c) => c === HubRemoteChannels.VIEW)).toHaveLength(2)
  })
})

describe('read, deliver, interrupt and move go to the child machine', () => {
  it('routes read_child there with the same arguments', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    const r = await readChild(
      {
        parentId: PARENT,
        load: async () => [],
        remote: (c, args) => d.control.read(c, { ...args }),
      },
      { childId: 'agent_c1', at: 'tool_1', limit: 5 },
    )
    expect(r.content[0]).toEqual({ type: 'text', text: 'history of agent_c1' })
    expect(vm.ops('read')).toEqual([[PARENT, { at: 'tool_1', limit: 5, childId: 'agent_c1' }]])
  })

  it('delivers queue and steer as from the parent', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    await d.control.deliver(row, 'please rebase', 'queue', 'Parent chat')
    await d.control.deliver(row, 'stop that', 'steer', 'Parent chat')
    expect(vm.ops('deliver')).toEqual([
      ['agent_c1', 'please rebase', 'queue', 'Parent chat'],
      ['agent_c1', 'stop that', 'steer', 'Parent chat'],
    ])
  })

  it('runs the check before the write once the client is ready, and writes nothing when it throws', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    const seen: string[] = []
    await expect(
      d.control.deliver(row, 'please rebase', 'queue', 'Parent chat', () => {
        seen.push(d.clients.controlOf('vm1'))
        throw new Error('the edge is gone')
      }),
    ).rejects.toThrow('the edge is gone')
    // `yes` is known only from the machine's ready.
    expect(seen).toEqual(['yes'])
    expect(vm.ops('deliver')).toEqual([])
  })

  it('interrupts there and reports whether a turn ran', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    expect(await d.control.interrupt(row)).toBe(true)
    expect(vm.ops('interrupt')).toEqual([['agent_c1']])
  })

  it('moves to an account there; the desktop refuses an account of another machine', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    const r = await d.control.move(row, 'claude-vm-2', 'auto')
    expect(r).toEqual({ content: [{ type: 'text', text: 'Moved agent_c1 to claude-vm-2.' }] })
    expect(vm.ops('move')).toEqual([[PARENT, 'auto', 'agent_c1', 'claude-vm-2']])

    const accounts = [
      { machineId: 'vm1', instanceIds: ['claude-vm', 'claude-vm-2'] },
      { machineId: 'vm2', instanceIds: ['claude-other'] },
    ]
    expect(hubMoveTargetPlace({ targetId: 'claude-vm-2', machineId: 'vm1', accounts, localAccount: false })).toBe(
      'here',
    )
    expect(hubMoveTargetPlace({ targetId: 'claude-other', machineId: 'vm1', accounts, localAccount: false })).toBe(
      'elsewhere',
    )
    expect(hubMoveTargetPlace({ targetId: 'claude-default', machineId: 'vm1', accounts, localAccount: true })).toBe(
      'elsewhere',
    )
    expect(hubMoveTargetPlace({ targetId: 'nobody', machineId: 'vm1', accounts, localAccount: false })).toBe('unknown')
  })
})

describe('the child machine acts only on a child of that desktop', () => {
  it('refuses a child of another hub and a local child, and answers not_found for an unknown id', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_other')
    d.own('agent_local')
    vm.adopt('agent_other', 'hub-someone-else', 'agent_other_parent')
    vm.local('agent_local', 'agent_vm_parent')
    const invoke = (ch: string, body: Record<string, unknown>) =>
      d.clients.invoke('vm1', ch, { v: 1, desktopInstallId: db.hubInstallId(), ...body })
    for (const childId of ['agent_other', 'agent_local']) {
      for (const ch of [HubRemoteChannels.INTERRUPT, HubRemoteChannels.STOP, HubRemoteChannels.READ_CHILD])
        expect(await invoke(ch, { childId }), `${ch} ${childId}`).toMatchObject({ ok: false, code: 'not_own' })
      expect(
        await invoke(HubRemoteChannels.DELIVER, { childId, text: 'x', delivery: 'queue', fromLabel: 'P' }),
      ).toMatchObject({ ok: false, code: 'not_own' })
      expect(
        await invoke(HubRemoteChannels.MOVE, { childId, instanceId: 'claude-vm', parentMode: 'auto' }),
      ).toMatchObject({ ok: false, code: 'not_own' })
    }
    expect(await invoke(HubRemoteChannels.VIEW, { parentId: 'agent_vm_parent' })).toMatchObject({ code: 'not_own' })
    expect(await invoke(HubRemoteChannels.STOP_ALL, { parentId: 'agent_other_parent' })).toMatchObject({
      code: 'not_own',
    })
    expect(await invoke(HubRemoteChannels.STOP, { childId: 'agent_nobody' })).toMatchObject({ code: 'not_found' })
    expect(vm.calls).toEqual([])
  })

  it('checks every field', () => {
    const base = { v: 1, desktopInstallId: 'hub-1', childId: 'agent_c1' }
    expect(parseHubRemoteDeliverRequest({ ...base, text: 'x', delivery: 'later', fromLabel: 'P' }).ok).toBe(false)
    expect(
      parseHubRemoteDeliverRequest({ ...base, text: 'x'.repeat(17 * 1024), delivery: 'queue', fromLabel: 'P' }).ok,
    ).toBe(false)
    expect(parseHubRemoteDeliverRequest({ ...base, text: 'x', delivery: 'queue', fromLabel: 'a\nb' }).ok).toBe(false)
    expect(parseHubRemoteStopRequest({ ...base, settle: { parentHead: 'HEAD' } }).ok).toBe(false)
    expect(parseHubRemoteStopRequest({ ...base, childId: '../x' }).ok).toBe(false)
    expect(parseHubRemoteStopRequest({ ...base, settle: { parentHead: HEAD } })).toEqual({
      ok: true,
      request: { ...base, settle: { parentHead: HEAD } },
    })
  })
})

describe('stop and pending stops', () => {
  it('stops there now while the machine is connected', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    expect(await d.control.stop(row, 'user')).toEqual({ pending: false, ran: true })
    expect(await d.control.stop(row, 'cascade')).toEqual({ pending: false, ran: true })
    expect(vm.ops('stop')).toEqual([['agent_c1'], ['agent_c1', 'cascade']])
    expect(db.listHubRemotePending()).toEqual([])
  })

  it('keeps a Stop while disconnected, survives a restart, sends it first on connect, once', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { status: 'offline' })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    expect(await d.control.stop(row, 'user')).toEqual({ pending: true, ran: false })
    // A second Stop of the same child is the same row.
    expect(await d.control.stop(row, 'user')).toEqual({ pending: true, ran: false })
    expect(db.listHubRemotePending().map((p) => [p.machineId, p.kind, p.targetId])).toEqual([
      ['vm1', 'stop', 'agent_c1'],
    ])
    expect(d.control.isStopping(row)).toBe(true)
    expect(
      childStateLabel({
        state: 'working',
        waitingForSlot: false,
        remote: { machineId: 'vm1', machine: 'Machine vm1', connected: false, ageMs: null, stopping: true },
      }),
    ).toBe('Stopping on Machine vm1')
    expect(vm.calls).toEqual([])

    // A restart: a new control over the same database still has it.
    const restarted = d.makeControl()
    expect(restarted.isStopping(row)).toBe(true)
    d.setStatus('vm1', 'connected')
    await restarted.connected('vm1')
    expect(vm.ops('stop')).toEqual([['agent_c1']])
    // The stop went before the view read.
    expect(d.invoked.indexOf(HubRemoteChannels.STOP)).toBeLessThan(d.invoked.indexOf(HubRemoteChannels.VIEW))
    expect(db.listHubRemotePending()).toEqual([])
    await restarted.connected('vm1')
    expect(vm.ops('stop')).toHaveLength(1)
  })

  it('counts a pending stop of a child the machine never got as done', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { status: 'offline' })
    const row = d.own('agent_gone')
    await d.control.stop(row, 'user')
    d.setStatus('vm1', 'connected')
    await d.control.connected('vm1')
    expect(db.listHubRemotePending()).toEqual([])
  })
})

describe('a Stop of a child still starting here', () => {
  it('fails the row when its machine never got the start, and asks its state when it did', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { status: 'offline' })
    const never = d.own('agent_never')
    db.updateHubChild('agent_never', { phase: 'starting' })
    const there = d.own('agent_there')
    db.updateHubChild('agent_there', { phase: 'starting' })
    vm.adopt('agent_there', db.hubInstallId())
    await d.control.stop({ ...never, phase: 'starting' }, 'user')
    await d.control.stop({ ...there, phase: 'starting' }, 'user')
    // While the Stop waits, the start is not sent (`HubStartHost.remoteStopping`).
    expect(d.control.isStopping(never)).toBe(true)
    expect(d.stoppedStarting).toEqual([])
    d.setStatus('vm1', 'connected')
    await d.control.connected('vm1')
    expect(d.stoppedStarting).toEqual([
      ['agent_never', false],
      ['agent_there', true],
    ])
    expect(vm.ops('stop')).toEqual([['agent_there']])
  })
})

describe('a pending stop that gets no answer', () => {
  const host = (fail: () => Error) => {
    const changed: string[] = []
    const stoppedStarting: Array<[string, boolean]> = []
    const control = new HubRemoteControl({
      enabled: () => true,
      installId: () => db.hubInstallId(),
      machineState: () => 'connected',
      machineName: () => 'Machine vm1',
      control: () => 'yes',
      supportsControl: async () => true,
      invoke: async () => {
        throw fail()
      },
      changed: (parentId) => changed.push(parentId),
      stoppedWhileStarting: (childId, there) => stoppedStarting.push([childId, there]),
    })
    return { control, changed, stoppedStarting }
  }

  it('is kept on a dropped socket and a timeout, and dropped after the last try', async () => {
    db.ensureHubParent(PARENT)
    db.insertHubChild(child('agent_c1', { machineId: 'vm1' }))
    db.updateHubChild('agent_c1', { phase: 'open' })
    const row = db.getHubChild('agent_c1')!
    const closed = host(() => new Error('WebSocket closed'))
    expect(await closed.control.stop(row, 'user')).toEqual({ pending: true, ran: false })
    expect(db.listHubRemotePending()).toMatchObject([{ kind: 'stop', targetId: 'agent_c1', attempts: 1 }])

    // Not connected does not count as a try.
    const away = host(() => new HubRemoteCallError('not_connected', 'Machine vm1 is not connected'))
    await away.control.flush('vm1')
    expect(db.listHubRemotePending()).toMatchObject([{ attempts: 1 }])

    const slow = host(() => new HubRemoteCallError('timeout', 'Machine vm1 did not answer'))
    for (let i = 2; i < HUB_REMOTE_PENDING_MAX_ATTEMPTS; i++) await slow.control.flush('vm1')
    expect(db.listHubRemotePending()).toMatchObject([{ attempts: HUB_REMOTE_PENDING_MAX_ATTEMPTS - 1 }])
    await slow.control.flush('vm1')
    expect(db.listHubRemotePending()).toEqual([])
    expect(slow.changed).toEqual([PARENT])
  })

  it('asks the start of a child still starting again when its Stop is dropped', async () => {
    db.ensureHubParent(PARENT)
    db.insertHubChild(child('agent_c1', { machineId: 'vm1' }))
    db.updateHubChild('agent_c1', { phase: 'starting' })
    const row = db.getHubChild('agent_c1')!
    const slow = host(() => new HubRemoteCallError('timeout', 'Machine vm1 did not answer'))
    await slow.control.stop(row, 'user')
    for (let i = 1; i < HUB_REMOTE_PENDING_MAX_ATTEMPTS; i++) await slow.control.flush('vm1')
    expect(db.listHubRemotePending()).toEqual([])
    expect(slow.stoppedStarting).toEqual([['agent_c1', true]])
  })
})

describe('a pending stop the machine answers', () => {
  const host = (answer: (channel: string, call: number) => unknown, changed?: () => void) => {
    const stoppedStarting: Array<[string, boolean]> = []
    let calls = 0
    const control = new HubRemoteControl({
      enabled: () => true,
      installId: () => db.hubInstallId(),
      machineState: () => 'connected',
      machineName: () => 'Machine vm1',
      control: () => 'yes',
      supportsControl: async () => true,
      invoke: async (_machineId, channel) => answer(channel, ++calls),
      changed: () => changed?.(),
      stoppedWhileStarting: (childId, there) => stoppedStarting.push([childId, there]),
    })
    return { control, stoppedStarting, calls: () => calls }
  }
  const open = (childId: string, phase: 'open' | 'starting' = 'open') => {
    db.ensureHubParent(PARENT)
    db.insertHubChild(child(childId, { machineId: 'vm1' }))
    db.updateHubChild(childId, { phase })
    return db.getHubChild(childId)!
  }
  const pending = (targetId: string) =>
    db.addHubRemotePending({ machineId: 'vm1', kind: 'stop', targetId, parentId: PARENT, payload: null })

  it('sends a stop queued while a pass runs in the same flush', async () => {
    open('agent_c1')
    open('agent_c2')
    pending('agent_c1')
    const h = host((_ch, n) => {
      if (n === 1) pending('agent_c2')
      return { v: 1, ok: true, ran: true }
    })
    await h.control.flush('vm1')
    expect(h.calls()).toBe(2)
    expect(db.listHubRemotePending()).toEqual([])
  })

  it('keeps the row when the local write after the answer throws', async () => {
    const row = open('agent_c1')
    db.addHubRemotePending({
      machineId: 'vm1',
      kind: 'settle',
      targetId: row.childId,
      parentId: PARENT,
      payload: { parentHead: HEAD },
    })
    const h = host(
      () => ({ v: 1, ok: true, ran: false }),
      () => {
        throw new Error('disk full')
      },
    )
    await h.control.flush('vm1')
    expect(db.listHubRemotePending()).toMatchObject([{ kind: 'settle', targetId: 'agent_c1', attempts: 1 }])
  })

  it('asks the start of a child still starting again when the machine refuses its Stop', async () => {
    open('agent_c1', 'starting')
    pending('agent_c1')
    const h = host(() => ({ v: 1, ok: false, code: 'failed', message: 'no' }))
    await h.control.flush('vm1')
    expect(db.listHubRemotePending()).toEqual([])
    expect(h.stoppedStarting).toEqual([['agent_c1', true]])
  })
})

describe('settle and archive', () => {
  const settler = (d: ReturnType<typeof desktop>, git = HEAD) =>
    new HubSettler(
      {
        sessionFacts: () => ({ running: false, cards: 0, queued: 0 }),
        agentPid: () => null,
        stop: async () => {},
        changed: () => {},
        forget: () => {},
        remote: {
          available: (c) => d.control.available(c),
          machineName: (c) => d.control.machineName(c),
          settle: (c, head) => d.control.settle(c, head),
        },
      },
      { git: async () => ({ code: 0, stdout: `${git}\n` }) },
    )

  it('settles a remote child there with the parent HEAD, then marks the desktop row settled', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    const r = await settler(d).run(PARENT, '/parent', 'auto')
    expect(r.ok).toBe(true)
    expect(r.text).toContain('Worktrees removed: Title agent_c1.')
    expect(vm.ops('settle')).toEqual([[PARENT, 'agent_c1', HEAD]])
    const after = db.getHubChild('agent_c1')!
    expect(after.phase).toBe('settled')
    expect(JSON.parse(after.settleJson!)).toMatchObject({ worktree: 'remove', machineId: 'vm1' })
  })

  it('keeps a settle pending while the machine is not connected, and settles on connect', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { status: 'offline' })
    d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    const r = await settler(d).run(PARENT, '/parent', 'auto')
    expect(r).toEqual({
      ok: true,
      rows: [],
      text:
        'Nothing was settled.\nNot settled yet, each settles on its machine when that machine connects: ' +
        'Title agent_c1 (Machine vm1).',
    })
    expect(db.getHubChild('agent_c1')!.phase).toBe('open')
    d.setStatus('vm1', 'connected')
    await d.control.connected('vm1')
    expect(vm.ops('settle')).toEqual([[PARENT, 'agent_c1', HEAD]])
    expect(db.getHubChild('agent_c1')!.phase).toBe('settled')
  })

  it('counts only the settled children in the "Settled" line', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url }, vm2: { url: vm.url } })
    d.own('agent_c1')
    d.own('agent_c2', 'vm2')
    vm.adopt('agent_c1', db.hubInstallId())
    d.setStatus('vm2', 'offline')
    const r = await settler(d).run(PARENT, '/parent', 'auto')
    expect(r.ok && r.rows.map((x) => x.childId)).toEqual(['agent_c1'])
    expect(r.text).toMatch(/^Settled 1 child\./)
    expect(r.text).toContain('when that machine connects: Title agent_c2 (Machine vm2).')
  })

  it('answers a retried settle with the row it stored, after the first answer was lost', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    // The first settle ran there, but its answer never came back.
    await d.clients.invoke('vm1', HubRemoteChannels.STOP, {
      v: 1,
      desktopInstallId: db.hubInstallId(),
      childId: 'agent_c1',
      settle: { parentHead: HEAD },
    })
    const r = await d.control.settle(row, HEAD)
    expect(r).toMatchObject({ status: 'settled', row: { worktree: 'remove' } })
    expect(vm.ops('settle')).toHaveLength(1)
    expect(JSON.parse(db.getHubChild('agent_c1')!.settleJson!)).toMatchObject({ worktree: 'remove' })
  })

  it('records no worktree when the answer has no settle row', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.dbm.updateHubChild('agent_c1', { phase: 'settled' })
    const r = await d.control.settle(row, HEAD)
    expect(r).toMatchObject({ status: 'settled', row: { worktree: 'none' } })
    expect(JSON.parse(db.getHubChild('agent_c1')!.settleJson!)).toEqual({
      worktree: null,
      keepReason: null,
      machineId: 'vm1',
    })
  })

  it('keeps the blockers of a settle row, strings only', () => {
    const row = parseHubRemoteSettleRow(
      { merged: true, clean: true, worktree: 'keep', blockers: ['a turn ran', 7, 'x'.repeat(20_000)] },
      'agent_c1',
      'T',
    )
    expect(row?.blockers.map((b) => b.length)).toEqual([10, 16 * 1024])
    expect(parseHubRemoteSettleRow({ merged: null, clean: null, worktree: 'none' }, 'a', 'T')?.blockers).toEqual([])
  })

  it('sends stop-all for an archive: the children there settle, the desktop rows settle', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1')
    d.own('agent_c2')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.adopt('agent_c2', db.hubInstallId())
    expect(await d.control.stopAll('vm1', PARENT)).toEqual({ pending: false })
    expect(vm.ops('settleAll')).toEqual([[PARENT]])
    expect(vm.dbm.listHubChildren(PARENT)).toEqual([])
    expect(db.listHubChildren(PARENT)).toEqual([])
    // Idempotent: nothing is open there any more.
    expect(await d.control.stopAll('vm1', PARENT)).toEqual({ pending: false })
  })
})

describe('older backend and the flag', () => {
  it('keeps the old texts for a machine without hub_remote_control_v1', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { createSocket: noControlSocket })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    expect(await d.clients.supportsControl('vm1')).toBe(false)
    expect(d.control.available(row)).toBe(false)
    await expect(d.control.stop(row, 'user')).rejects.toThrow(HUB_REMOTE_STOP_LATER_TEXT)
    const read = await readChild(
      {
        parentId: PARENT,
        load: async () => [],
        remote: (c, a) => (d.control.available(c) ? d.control.read(c, a) : null),
      },
      { childId: 'agent_c1' },
    )
    expect(read).toEqual({ content: [{ type: 'text', text: HUB_REMOTE_READ_LATER_TEXT }], isError: true })
    expect(vm.calls).toEqual([])
    expect(db.listHubRemotePending()).toEqual([])
  })

  it('answers false when the machine never sends ready', async () => {
    const vm = await bootVm()
    const silent = (url: string): TransportSocket => {
      const ws = new WebSocket(url)
      const add = ws.addEventListener.bind(ws) as TransportSocket['addEventListener']
      ws.addEventListener = ((type: string, listener: (e: unknown) => void) => {
        if (type !== 'message') return add(type as never, listener as never)
        add('message', (e: MessageEvent) => {
          if ((JSON.parse(String(e.data)) as { k?: string }).k !== 'ready') listener(e)
        })
      }) as typeof ws.addEventListener
      return ws as unknown as TransportSocket
    }
    const d = desktop({ vm1: { url: vm.url } }, { createSocket: silent, callTimeoutMs: 200 })
    const started = Date.now()
    expect(await d.clients.supportsControl('vm1')).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('sends nothing with hub_remote_children off', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { enabled: { on: false } })
    const row = d.own('agent_c1')
    vm.adopt('agent_c1', db.hubInstallId())
    await expect(d.control.stop(row, 'user')).rejects.toThrow(/off/)
    await d.control.refreshParent(PARENT)
    await d.control.connected('vm1')
    expect(d.invoked).toEqual([])
    expect(vm.calls).toEqual([])
  })
})

describe('migration', () => {
  it('adds hub_remote_pending to a database from before it, and runs twice', () => {
    const old = new Database(':memory:')
    old.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    ensureHubSchema(old)
    old.exec('DROP TABLE hub_remote_pending')
    ensureHubSchema(old)
    ensureHubSchema(old)
    const cols = (old.prepare('PRAGMA table_info(hub_remote_pending)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    expect(cols).toEqual(['machine_id', 'kind', 'target_id', 'parent_id', 'payload_json', 'created_at', 'attempts'])
  })
})
