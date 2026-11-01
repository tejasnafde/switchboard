/**
 * Children on other machines, the outbox: a child machine (a `WsHost` on
 * 127.0.0.1 with the production `hub-remote:*` handlers, its own database
 * loaded again after `vi.resetModules`) keeps what its children send their
 * parent stub in `hub_outbox`; the desktop pulls through the real hub client
 * (`RemoteHubClients`), imports each item once (`HubRemoteOutbox`) into its
 * own wakes or a lineage message, and acks it.
 */
import { createMigratedDb } from './helpers/test-db'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

vi.mock('../../src/main/logger', () => ({
  createMainLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}))

const db = await import('../../src/main/db/database')
const { WsHost } = await import('../../src/main/backend/ws-host')
const { RemoteHubClients } = await import('../../src/main/hub/remote-hub-clients')
const { HubRemoteOutbox, MESSAGE_ATTEMPTS } = await import('../../src/main/hub/hub-remote-outbox')
const { HubWakeScheduler } = await import('../../src/main/hub/hub-wakes')
const { HubStarter } = await import('../../src/main/hub/hub-start')
const { HubRemoteChannels } = await import('../../src/shared/ipc-channels')
const { PeerLinkBook, PEER_LINEAGE_MESSAGE_BUDGET } = await import('../../src/shared/peer-links')
const { parseHubOutboxAckRequest, parseHubOutboxItem, parseHubOutboxPullRequest, HUB_OUTBOX_PULL_MAX } =
  await import('../../src/shared/hub-remote')

import type { ConnectionStatus } from '../../src/main/machines/connection-status'
import type { HubRemoteOutboxHost } from '../../src/main/hub/hub-remote-outbox'
import type { HubChildRow } from '../../src/main/db/hubs'
import type { TransportSocket } from '../../src/shared/ws-transport'

const TOKEN = 'server-token-abc'
const PARENT = 'agent_parent'

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

const child = (childId: string, extra: Partial<HubChildRow> = {}) => ({
  childId,
  parentId: PARENT,
  batchId: `b_${childId}`,
  ordinal: 0,
  title: `Title ${childId}`,
  brief: 'Do it',
  location: 'worktree' as const,
  grantedMode: 'auto' as const,
  depsMode: 'none' as const,
  ...extra,
})

/** A socket that sees a backend from before the outbox: its `ready` lacks `hub_remote_outbox_v1`. */
function noOutboxSocket(url: string): TransportSocket {
  const ws = new WebSocket(url)
  const add = ws.addEventListener.bind(ws) as TransportSocket['addEventListener']
  ws.addEventListener = ((type: string, listener: (e: unknown) => void) => {
    if (type !== 'message') return add(type as never, listener as never)
    add('message', (e: MessageEvent) => {
      const frame = JSON.parse(String(e.data)) as { k?: string; capabilities?: string[] }
      if (frame.k !== 'ready') return listener(e)
      frame.capabilities = frame.capabilities?.filter((c) => c !== 'hub_remote_outbox_v1')
      listener({ data: JSON.stringify(frame) })
    })
  }) as typeof ws.addEventListener
  return ws as unknown as TransportSocket
}

/** A child machine: its own database, the production handlers, and the host that emits `hub-remote:outbox`. */
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
  const { HubWakeScheduler: VmWakes } = await import('../../src/main/hub/hub-wakes')
  const { registerHubRemoteHandlers } = await import('../../src/main/hub/hub-remote-describe')
  registerHubRemoteHandlers(host, {
    backendVersion: () => '1.0.0',
    agentAvailable: async () => true,
    runningSlotKeys: () => [],
    startChild: async () => ({ ok: false, error: 'not in this test' }),
  })
  const emitted: string[] = []
  const wakes = new VmWakes({
    enabled: () => true,
    liveThread: () => null,
    idle: () => true,
    send: async () => true,
    interrupt: async () => {},
    commitUpdate: () => ({ messageId: 'm', at: 1 }),
    announce() {},
    changed() {},
    outboxAdded: () => {
      emitted.push(HubRemoteChannels.OUTBOX)
      host.emit(HubRemoteChannels.OUTBOX)
    },
  })
  cleanups.push(() => wakes.stop())
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`
  /** A child here of the desktop's parent: a parent stub owned by `installId`. */
  const adopt = (childId: string, installId: string, phase: 'starting' | 'open' = 'open') => {
    vmDb.claimHubParentStub(PARENT, installId)
    vmDb.insertHubChild(child(childId))
    if (phase !== 'starting') vmDb.updateHubChild(childId, { phase })
  }
  const report = (childId: string, summary: string) =>
    wakes.record({
      parentId: PARENT,
      childId,
      kind: 'report',
      summary,
      pointer: { childId, toolCallId: `tool_${summary}`, at: 1_000, transcriptPath: '/home/u/.claude/x.jsonl' },
    })
  const message = (childId: string, text: string) => {
    const id = vmDb.insertHubOutboxMessage({ childId, parentId: PARENT, text, delivery: 'queue' })
    host.emit(HubRemoteChannels.OUTBOX)
    return id
  }
  const unacked = () =>
    vmDb
      .getDb()
      .prepare('SELECT id FROM hub_outbox WHERE acked_at IS NULL ORDER BY created_at, id')
      .all()
      .map((r) => (r as { id: string }).id)
  return { host, url, dbm: vmDb, wakes, emitted, adopt, report, message, unacked }
}

interface DesktopOpts {
  enabled?: { on: boolean }
  pageSize?: number
  retryMs?: number
  /** Stands in front of a real call: return undefined to pass it through. */
  intercept?: (channel: string, args: unknown[]) => Promise<unknown> | undefined
  parentRunning?: () => boolean
  rateHasRoom?: () => boolean
  createSocket?: (url: string) => TransportSocket
}

/** The desktop: real hub client, importer, wake scheduler and starter; a lineage edge book standing in for delivery. */
function desktop(machines: Record<string, { url: string }>, opts: DesktopOpts = {}) {
  const status = new Map<string, ConnectionStatus>(Object.keys(machines).map((id) => [id, 'connected']))
  const enabled = opts.enabled ?? { on: true }
  const clients = new RemoteHubClients({
    enabled: () => enabled.on,
    machines: () => Object.keys(machines).map((id) => ({ id, name: `Machine ${id}`, transportKind: 'gcloud-iap' })),
    statusOf: (id) => status.get(id) ?? 'offline',
    urlOf: (id) => machines[id]?.url ?? null,
    tokenOf: () => TOKEN,
    ...(opts.createSocket ? { createSocket: opts.createSocket } : {}),
  })
  cleanups.push(() => clients.closeAll())
  const sent: Array<{ threadId: string; body: string }> = []
  const idle = { now: false }
  const wakes = new HubWakeScheduler(
    {
      enabled: () => true,
      liveThread: () => PARENT,
      idle: () => idle.now,
      send: async (threadId, body) => {
        sent.push({ threadId, body })
        return true
      },
      interrupt: async () => {},
      commitUpdate: (_p, ids, revision, _c, d) => {
        db.markHubWakesDelivered(ids, revision, d)
        return { messageId: 'row', at: revision }
      },
      announce() {},
      changed() {},
    },
    // Past the 15 s quiet time at once: one update turn as soon as the parent is idle.
    () => Date.now() + 60_000,
  )
  cleanups.push(() => wakes.stop())
  const starter = new HubStarter(
    {
      createWorktree: async () => ({ status: 'failed' }) as never,
      startSession: async () => ({}),
      submitTurn: async () => ({ status: 'accepted' }) as never,
      openCard: () => ({ ok: false, message: 'no' }),
      announceRow() {},
      async stopChild() {},
    },
    () => null,
  )
  cleanups.push(() => starter.dispose())
  const edges = new PeerLinkBook()
  const delivered: Array<{ childId: string; text: string }> = []
  const calls: Array<{ channel: string; args: unknown[] }> = []
  const host: HubRemoteOutboxHost = {
    enabled: () => enabled.on,
    installId: () => db.hubInstallId(),
    supportsOutbox: (id) => clients.supportsOutbox(id),
    invoke: (id, channel, ...args) => {
      calls.push({ channel, args })
      return opts.intercept?.(channel, args) ?? clients.invoke(id, channel, ...args)
    },
    recordWake: (w, inTx) => wakes.record(w, inTx),
    failedStart: (childId) => starter.remoteChildFailedStart(childId),
    parentRunning: opts.parentRunning ?? (() => true),
    rateHasRoom: opts.rateHasRoom ?? (() => true),
    deliverMessage: async ({ child: c, text }) => {
      // The registry's lineage edge: charged before delivery, refused once spent.
      const verdict = edges.checkSend(c.childId, c.parentId, Date.now())
      if (!verdict.linked) return { ok: false, reason: 'no lineage edge' }
      if (!verdict.ok) return { ok: false, reason: verdict.message }
      delivered.push({ childId: c.childId, text })
      return { ok: true }
    },
  }
  const outbox = new HubRemoteOutbox(host, { pageSize: opts.pageSize, retryMs: opts.retryMs ?? 60_000 })
  cleanups.push(() => outbox.dispose())
  // The registry's wiring (`setRemoteHubClients`).
  clients.setMachineListener((id, change) => {
    if (change === 'connected') void outbox.connected(id)
  })
  cleanups.push(clients.on(HubRemoteChannels.OUTBOX, (id) => void outbox.pull(id)))
  cleanups.push(clients.onResync((id) => void outbox.pull(id)))
  /** A desktop row for a child that runs on `machineId` (null: a local child). */
  const own = (childId: string, machineId: string | null, phase: 'starting' | 'open' = 'open') => {
    db.ensureHubParent(PARENT)
    db.insertHubChild(child(childId, machineId ? { machineId } : {}))
    if (phase !== 'starting') db.updateHubChild(childId, { phase })
    edges.syncLineage(
      db.listHubChildrenInPhase(phase, { includeRemote: true }).map((c) => [c.parentId, c.childId]),
      Date.now(),
    )
  }
  const setStatus = (id: string, s: ConnectionStatus) => {
    status.set(id, s)
    clients.statusChanged(id, s)
  }
  return { clients, outbox, host, wakes, starter, edges, delivered, sent, idle, calls, own, setStatus, enabled }
}

const pulls = (d: ReturnType<typeof desktop>) => d.calls.filter((c) => c.channel === HubRemoteChannels.OUTBOX_PULL)

describe('the outbox: a report on the child machine reaches the desktop', () => {
  it('lands as desktop wakes with the machine and one update turn, and the items are acked there', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.report('agent_c1', 'first')
    vm.report('agent_c1', 'second')
    // Nothing for the stub here: the wakes wait in the outbox.
    expect(vm.dbm.listPendingHubWakes(PARENT)).toEqual([])
    expect(vm.unacked()).toHaveLength(2)

    await d.outbox.connected('vm1')
    const wakes = db.listPendingHubWakes(PARENT)
    expect(wakes.map((w) => [w.childId, w.kind, w.summary, w.machineId])).toEqual([
      ['agent_c1', 'report', 'first', 'vm1'],
      ['agent_c1', 'report', 'second', 'vm1'],
    ])
    // The pointer keeps the tool call and drops the other machine's file path.
    expect(wakes[0]!.pointer).toEqual({ childId: 'agent_c1', toolCallId: 'tool_first', at: 1_000 })
    expect(vm.unacked()).toEqual([])

    d.idle.now = true
    d.wakes.poke(PARENT)
    await until(() => d.sent.length === 1)
    expect(d.sent[0]!.body).toContain('first')
    expect(d.sent[0]!.body).toContain('second')
    await new Promise((r) => setTimeout(r, 20))
    expect(d.sent).toHaveLength(1)
  })

  it('pulls on the machine event without being asked', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    // The first pull opens the client, which then hears the machine's events.
    await d.outbox.connected('vm1')
    vm.report('agent_c1', 'live')
    expect(vm.emitted).toEqual([HubRemoteChannels.OUTBOX])
    await until(() => db.listPendingHubWakes(PARENT).length === 1)
    await until(() => vm.unacked().length === 0)
  })

  it('ends a starting child failed_start from a failed wake written at its start there', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1', 'vm1', 'starting')
    vm.adopt('agent_c1', db.hubInstallId(), 'starting')
    // As `HubStarter.fail` does there: the phase, then the wake.
    vm.dbm.updateHubChild('agent_c1', { phase: 'failed_start' })
    vm.wakes.record({
      parentId: PARENT,
      childId: 'agent_c1',
      kind: 'failed',
      summary: 'Failed to start: x',
      pointer: null,
    })
    await d.outbox.connected('vm1')
    expect(db.getHubChild('agent_c1')).toMatchObject({ phase: 'failed_start', machineId: 'vm1' })
    expect(db.listPendingHubWakes(PARENT).map((w) => [w.kind, w.summary])).toEqual([['failed', 'Failed to start: x']])
  })

  it('leaves an open child open on a report or a stopped wake of a running child', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.wakes.record({ parentId: PARENT, childId: 'agent_c1', kind: 'stopped', summary: 'Ended', pointer: null })
    await d.outbox.connected('vm1')
    expect(db.getHubChild('agent_c1')?.phase).toBe('open')
  })
})

describe('the outbox: messages along the lineage edge', () => {
  it('delivers a message once, charging the edge', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    const id = vm.message('agent_c1', 'hello parent')
    await d.outbox.connected('vm1')
    await d.outbox.pull('vm1')
    expect(d.delivered).toEqual([{ childId: 'agent_c1', text: 'hello parent' }])
    expect(d.edges.checkSend('agent_c1', PARENT, Date.now())).toMatchObject({ linked: true, ok: true })
    expect(db.getHubRemoteImport('vm1', id)).toMatchObject({ outcome: 'imported', kind: 'message' })
    expect(vm.unacked()).toEqual([])
  })

  it('records a message the spent budget refuses, acks it and never tries it again', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    for (let i = 0; i < PEER_LINEAGE_MESSAGE_BUDGET; i++) d.edges.checkSend('agent_c1', PARENT, Date.now())
    const id = vm.message('agent_c1', 'one too many')
    await d.outbox.connected('vm1')
    expect(d.delivered).toEqual([])
    expect(db.getHubRemoteImport('vm1', id)).toMatchObject({ outcome: 'refused', reason: expect.any(String) })
    expect(vm.unacked()).toEqual([])
    await d.outbox.pull('vm1')
    expect(d.delivered).toEqual([])
  })

  it('keeps a message for a parent that is not running, then records it after the last try', async () => {
    const vm = await bootVm()
    const running = { now: false }
    const d = desktop({ vm1: { url: vm.url } }, { parentRunning: () => running.now, retryMs: 5 })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    const first = vm.message('agent_c1', 'later')
    await d.outbox.connected('vm1')
    expect(vm.unacked()).toEqual([first])
    // It is pulled again on the retry timer; once the parent runs it goes.
    running.now = true
    await until(() => d.delivered.length === 1)
    await until(() => vm.unacked().length === 0)

    running.now = false
    const second = vm.message('agent_c1', 'never')
    await until(() => db.getHubRemoteImport('vm1', second)?.outcome === 'refused', 5_000)
    expect(pulls(d).length).toBeGreaterThanOrEqual(MESSAGE_ATTEMPTS)
    expect(d.delivered).toHaveLength(1)
    await until(() => vm.unacked().length === 0)
  })

  it('delivers a backlog past the per-pair rate over later pulls without using up its tries', async () => {
    const vm = await bootVm()
    // Five messages per pull, as the per-pair rate allows five a minute.
    let room = 5
    const d = desktop(
      { vm1: { url: vm.url } },
      {
        retryMs: 5,
        rateHasRoom: () => room > 0,
        intercept: (channel) => {
          if (channel === HubRemoteChannels.OUTBOX_PULL) room = 5
          return undefined
        },
      },
    )
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    const n = 5 * (MESSAGE_ATTEMPTS + 2)
    for (let i = 0; i < n; i++) vm.message('agent_c1', `m${i}`)
    const deliver = d.host.deliverMessage
    d.host.deliverMessage = (m) => {
      room--
      return deliver(m)
    }
    await d.outbox.connected('vm1')
    await until(() => vm.unacked().length === 0, 5_000)
    expect(d.delivered.map((m) => m.text)).toEqual(Array.from({ length: n }, (_, i) => `m${i}`))
  })
})

describe('the outbox: pulls, acks and drops', () => {
  it('imports once when the ack is lost, and acks it on the next pull', async () => {
    const vm = await bootVm()
    let lose = true
    const d = desktop(
      { vm1: { url: vm.url } },
      {
        intercept: (channel) => {
          if (channel === HubRemoteChannels.OUTBOX_ACK && lose) {
            lose = false
            return Promise.reject(new Error('the socket dropped'))
          }
          return undefined
        },
      },
    )
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.report('agent_c1', 'once')
    vm.message('agent_c1', 'once too')
    await d.outbox.connected('vm1')
    expect(vm.unacked()).toHaveLength(2)
    await d.outbox.pull('vm1')
    expect(vm.unacked()).toEqual([])
    expect(db.listPendingHubWakes(PARENT)).toHaveLength(1)
    expect(d.delivered).toHaveLength(1)
  })

  it('pulls what was written while the machine was away once it connects again', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    await d.outbox.connected('vm1')
    d.setStatus('vm1', 'offline')
    vm.report('agent_c1', 'while away')
    await new Promise((r) => setTimeout(r, 30))
    expect(db.listPendingHubWakes(PARENT)).toEqual([])
    d.setStatus('vm1', 'connected')
    await until(() => db.listPendingHubWakes(PARENT).length === 1)
    await until(() => vm.unacked().length === 0)
  })

  it('reads pages past the limit until a short page', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { pageSize: 2 })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    for (let i = 0; i < 5; i++) vm.report('agent_c1', `r${i}`)
    await d.outbox.connected('vm1')
    expect(db.listPendingHubWakes(PARENT).map((w) => w.summary)).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
    expect(pulls(d)).toHaveLength(3)
    expect(vm.unacked()).toEqual([])
  })

  it('runs one pull at a time per machine and one more for a request during it', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.report('agent_c1', 'a')
    await Promise.all([d.outbox.pull('vm1'), d.outbox.pull('vm1'), d.outbox.pull('vm1')])
    expect(pulls(d)).toHaveLength(2)
    expect(db.listPendingHubWakes(PARENT)).toHaveLength(1)
  })

  it('drops an item for a child of another machine, a local child or an unknown child, with no wake or message', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } })
    d.own('agent_other', 'vm2')
    d.own('agent_local', null)
    const installId = db.hubInstallId()
    for (const id of ['agent_other', 'agent_local', 'agent_unknown']) vm.adopt(id, installId)
    const ids = [...['agent_other', 'agent_local', 'agent_unknown'].map((id) => vm.message(id, `from ${id}`))]
    vm.report('agent_other', 'fake')
    vm.report('agent_local', 'fake')
    await d.outbox.connected('vm1')
    expect(db.listPendingHubWakes(PARENT)).toEqual([])
    expect(d.delivered).toEqual([])
    expect(ids.map((id) => db.getHubRemoteImport('vm1', id)?.outcome)).toEqual(['dropped', 'dropped', 'dropped'])
    expect(ids.map((id) => db.getHubRemoteImport('vm1', id)?.reason)).toEqual([
      'a child of another machine',
      'a local child',
      'unknown child',
    ])
    expect(vm.unacked()).toEqual([])
  })

  it('answers only the items of the asking desktop, and acks only those', async () => {
    const vm = await bootVm()
    vm.adopt('agent_c1', 'hub-mine')
    vm.dbm.claimHubParentStub('agent_p2', 'hub-theirs')
    vm.dbm.insertHubChild({ ...child('agent_c2'), parentId: 'agent_p2' })
    vm.report('agent_c1', 'mine')
    vm.wakes.record({ parentId: 'agent_p2', childId: 'agent_c2', kind: 'report', summary: 'theirs', pointer: null })
    const mine = vm.dbm.listHubOutbox('hub-mine', { limit: 10 }).items
    const theirs = vm.dbm.listHubOutbox('hub-theirs', { limit: 10 }).items
    expect(mine.map((i) => i.childId)).toEqual(['agent_c1'])
    expect(vm.dbm.ackHubOutbox('hub-mine', [theirs[0]!.id])).toBe(0)
    expect(vm.dbm.ackHubOutbox('hub-mine', [mine[0]!.id])).toBe(1)
    expect(vm.dbm.ackHubOutbox('hub-mine', [mine[0]!.id])).toBe(0)
    expect(vm.unacked()).toEqual([theirs[0]!.id])
  })
})

describe('the outbox with the flag off, and an older machine', () => {
  it('pulls nothing with hub_remote_children off on the desktop; the child machine still answers a pull', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { enabled: { on: false } })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.report('agent_c1', 'kept')
    await d.outbox.connected('vm1')
    expect(d.calls).toEqual([])
    expect(db.listPendingHubWakes(PARENT)).toEqual([])

    // The machine's own flag is off (nothing set there): it answers the outbox all the same.
    const other = desktop({ vm1: { url: vm.url } })
    const answer = (await other.clients.invoke('vm1', HubRemoteChannels.OUTBOX_PULL, {
      v: 1,
      desktopInstallId: db.hubInstallId(),
    })) as { items: unknown[] }
    expect(answer.items).toHaveLength(1)
  })

  it('does not pull from a machine without hub_remote_outbox_v1', async () => {
    const vm = await bootVm()
    const d = desktop({ vm1: { url: vm.url } }, { createSocket: noOutboxSocket })
    d.own('agent_c1', 'vm1')
    vm.adopt('agent_c1', db.hubInstallId())
    vm.report('agent_c1', 'stays')
    await d.outbox.connected('vm1')
    expect(pulls(d)).toEqual([])
    expect(vm.unacked()).toHaveLength(1)
  })
})

describe('the outbox requests and items', () => {
  it('checks every field of a pull and an ack', () => {
    expect(parseHubOutboxPullRequest({ v: 1, desktopInstallId: 'hub-1' })).toEqual({
      ok: true,
      request: { v: 1, desktopInstallId: 'hub-1', limit: 100 },
    })
    expect(parseHubOutboxPullRequest({ v: 1, desktopInstallId: 'hub-1', limit: 9_999, after: 'ho_1' })).toEqual({
      ok: true,
      request: { v: 1, desktopInstallId: 'hub-1', after: 'ho_1', limit: HUB_OUTBOX_PULL_MAX },
    })
    for (const bad of [
      null,
      { v: 2, desktopInstallId: 'hub-1' },
      { v: 1, desktopInstallId: "x' OR 1=1 --" },
      { v: 1, desktopInstallId: 'hub-1', limit: 0 },
      { v: 1, desktopInstallId: 'hub-1', limit: 1.5 },
      { v: 1, desktopInstallId: 'hub-1', after: 7 },
    ])
      expect(parseHubOutboxPullRequest(bad).ok, JSON.stringify(bad)).toBe(false)
    expect(parseHubOutboxAckRequest({ v: 1, desktopInstallId: 'hub-1', ids: ['a', 'a', 'b'] })).toEqual({
      ok: true,
      request: { v: 1, desktopInstallId: 'hub-1', ids: ['a', 'b'] },
    })
    for (const bad of [
      { v: 1, desktopInstallId: 'hub-1', ids: 'a' },
      { v: 1, desktopInstallId: 'hub-1', ids: [1] },
      { v: 1, desktopInstallId: 'hub-1', ids: Array.from({ length: 501 }, (_, i) => `id${i}`) },
    ])
      expect(parseHubOutboxAckRequest(bad).ok).toBe(false)
  })

  it('refuses an item of the wrong shape, an unknown kind or an oversized body', () => {
    const base = { id: 'ho_1', childId: 'c', parentId: 'p', createdAt: 1 }
    const wake = { kind: 'report', summary: 's', pointer: null, childPhase: 'open' }
    expect(parseHubOutboxItem({ ...base, kind: 'wake', wake })).toMatchObject({ kind: 'wake' })
    expect(parseHubOutboxItem({ ...base, kind: 'wake', wake: { ...wake, kind: 'approve' } })).toBeNull()
    expect(
      parseHubOutboxItem({ ...base, kind: 'wake', wake: { ...wake, summary: 'x'.repeat(16 * 1024 + 1) } }),
    ).toBeNull()
    expect(parseHubOutboxItem({ ...base, kind: 'setting', wake })).toBeNull()
    expect(parseHubOutboxItem({ ...base, kind: 'message', message: { text: 'hi', delivery: 'queue' } })).toMatchObject({
      kind: 'message',
    })
    expect(
      parseHubOutboxItem({ ...base, kind: 'message', message: { text: 'x'.repeat(16 * 1024 + 1), delivery: 'queue' } }),
    ).toBeNull()
    expect(parseHubOutboxItem({ ...base, kind: 'message', message: { text: 'hi', delivery: 'now' } })).toBeNull()
  })
})

describe('the outbox tables on an older database', () => {
  it('gains the tables and columns, and moves a stub parent wake into the outbox once', () => {
    const old = createMigratedDb()
    old.exec(`
      DROP TABLE hub_outbox;
      DROP TABLE hub_remote_imports;
      DROP TABLE hub_wakes;
      CREATE TABLE hub_wakes (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, child_id TEXT NOT NULL, kind TEXT NOT NULL,
        summary TEXT NOT NULL, pointer_json TEXT, created_at INTEGER NOT NULL, delivered_revision INTEGER);
      INSERT INTO hub_parents (parent_id, remote_hub, updated_at) VALUES ('p_stub', 'hub-desk', 1);
      INSERT INTO hub_parents (parent_id, updated_at) VALUES ('p_here', 1);
      INSERT INTO hub_wakes (id, parent_id, child_id, kind, summary, pointer_json, created_at)
        VALUES ('hw_1', 'p_stub', 'c1', 'report', 'old report',
          '{"childId":"c1","toolCallId":"t1","at":5,"transcriptPath":"/home/u/x"}', 10);
      INSERT INTO hub_wakes (id, parent_id, child_id, kind, summary, pointer_json, created_at)
        VALUES ('hw_2', 'p_stub', 'c1', 'failed', 'bad pointer', 'not json', 11);
      INSERT INTO hub_wakes (id, parent_id, child_id, kind, summary, pointer_json, created_at)
        VALUES ('hw_3', 'p_here', 'c2', 'report', 'local', NULL, 12);
    `)
    db.migrate(old)
    db.migrate(old)
    expect(db.listPendingHubWakes('p_stub')).toEqual([])
    expect(db.listPendingHubWakes('p_here').map((w) => [w.id, w.machineId])).toEqual([['hw_3', null]])
    const { items, malformed } = db.listHubOutbox('hub-desk', { limit: 10 })
    expect(malformed).toEqual([])
    expect(items).toEqual([
      {
        id: 'ho_hw_1',
        childId: 'c1',
        parentId: 'p_stub',
        createdAt: 10,
        kind: 'wake',
        wake: { kind: 'report', summary: 'old report', pointer: { at: 5, toolCallId: 't1' }, childPhase: 'open' },
      },
      {
        id: 'ho_hw_2',
        childId: 'c1',
        parentId: 'p_stub',
        createdAt: 11,
        kind: 'wake',
        wake: { kind: 'failed', summary: 'bad pointer', pointer: null, childPhase: 'open' },
      },
    ])
    // The child machine reads its child's last wake from the outbox (the reaper and a repeated start do).
    expect(db.lastHubWakes('p_stub').get('c1')).toEqual({ kind: 'failed', summary: 'bad pointer' })
    expect(db.lastHubWakeOf('c1')).toMatchObject({ kind: 'failed', summary: 'bad pointer' })
  })

  it('prunes acked items after 7 days, and keeps unacked ones', () => {
    db.claimHubParentStub('p_stub', 'hub-desk')
    const a = db.insertHubOutboxMessage({ childId: 'c1', parentId: 'p_stub', text: 'a', delivery: 'queue' })
    db.insertHubOutboxMessage({ childId: 'c1', parentId: 'p_stub', text: 'b', delivery: 'queue' })
    const now = Date.now()
    db.ackHubOutbox('hub-desk', [a], now - 8 * 24 * 60 * 60_000)
    expect(db.pruneHubOutbox(7 * 24 * 60 * 60_000, now)).toBe(1)
    expect(db.listHubOutbox('hub-desk', { limit: 10 }).items.map((i) => i.kind)).toEqual(['message'])
    expect(db.countUnackedHubOutboxMessages('c1')).toBe(1)
  })
})
