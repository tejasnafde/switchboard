/**
 * The registry's two ends of the outbox, against the real registry:
 *
 * - on a child machine, an open child whose parent is a stub sends its parent
 *   a message through the outbox, only along that lineage edge, and the
 *   machine says so with `hub-remote:outbox`;
 * - on the desktop, an imported message of a child on another machine goes to
 *   its parent along the lineage edge, charging that edge's budget first.
 */
import { describe, expect, it, vi } from 'vitest'
import './helpers/registry-session-mocks'

vi.mock('../../src/main/db/provider-instances', () => ({
  resolveProviderInstance: (agentType: string, id?: string) => ({
    id: id ?? `${agentType}-default`,
    agentType,
    displayName: id ?? `${agentType}-default`,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  getProviderInstanceFull: () => null,
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

const state = vi.hoisted(() => ({
  outbox: [] as Array<{ childId: string; parentId: string; text: string; delivery: string }>,
  saved: [] as Array<{ id: string; conversationId: string }>,
  /** `labs.hub_remote_children`. */
  remoteFlag: false,
}))
const children = vi.hoisted(() => [
  // On a child machine: its parent runs on another machine's hub.
  { childId: 'vmchild', parentId: 'stub1', title: 'VM child', phase: 'open', machineId: null },
  // On the desktop: a child that runs on machine vm1, and a local one.
  { childId: 'rchild', parentId: 'parent1', title: 'Remote child', phase: 'open', machineId: 'vm1' },
  { childId: 'lchild', parentId: 'parent1', title: 'Local child', phase: 'open', machineId: null },
])

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: (id: string, conversationId: string) => {
    state.saved.push({ id, conversationId })
    return true
  },
  rewriteSystemMarker: () => null,
  getConversationById: (id: string) => ({ id, project_path: process.cwd() }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: (key: string) =>
    key === 'labs.hub_children' || (key === 'labs.hub_remote_children' && state.remoteFlag) ? 'true' : null,
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
  deleteUserMessage: () => {},
  isConversationArchived: () => false,
  openChildParentId: (id: string) => children.find((c) => c.childId === id)?.parentId ?? null,
  listHubChildrenInPhase: (phase: string) => children.filter((c) => c.phase === phase),
  threadFamilyIds: (id: string) => [id],
  listHubChildren: (parentId: string) =>
    state.remoteFlag ? children.filter((c) => c.parentId === parentId && c.phase !== 'settled') : [],
  lastHubWakes: () => new Map(),
  listPendingHubWakes: () => [],
  getHubParent: (id: string) =>
    id === 'stub1' ? { parentId: id, held: false, heldReason: null, heldAt: null, remoteHub: 'hub-desk' } : null,
  getHubChild: (id: string) => children.find((c) => c.childId === id) ?? null,
  insertHubOutboxMessage: (m: { childId: string; parentId: string; text: string; delivery: string }) => {
    state.outbox.push(m)
    return `ho_${state.outbox.length}`
  },
  countUnackedHubOutboxMessages: (childId: string) => state.outbox.filter((m) => m.childId === childId).length,
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { createPeerToolHandlers } from '../../src/main/provider/peer-tools'
import { HubRemoteChannels, ProviderChannels } from '../../src/shared/ipc-channels'
import {
  HUB_REMOTE_STOP_LATER_TEXT,
  HUB_OUTBOX_MESSAGE_SENT_TEXT,
  HUB_OUTBOX_MESSAGES_FULL_TEXT,
  HUB_OUTBOX_MESSAGES_PER_CHILD_MAX,
} from '../../src/shared/hub-remote'
import { PEER_LINEAGE_MESSAGE_BUDGET } from '../../src/shared/peer-links'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderKind, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type { RuntimeEvent } from '../../src/shared/provider-events'
import type { HubChildRow } from '../../src/main/db/hubs'
import type { HubRemoteOutboxHost } from '../../src/main/hub/hub-remote-outbox'

class FakeHost implements BackendHost {
  readonly emitted: string[] = []
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(channel: string): void {
    this.emitted.push(channel)
  }
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

class Adapter implements ProviderAdapter {
  readonly provider: ProviderKind = 'claude'
  sends: Array<{ threadId: string; message: string }> = []
  async startSession(opts: SessionStartOpts, _onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    return {
      threadId: opts.threadId,
      provider: this.provider,
      status: 'idle',
      runtimeMode: 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  async sendTurn(threadId: string, message: string): Promise<void> {
    this.sends.push({ threadId, message })
  }
  async respondToRequest(): Promise<void> {}
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

type Internals = {
  deliverRemoteChildMessage(
    child: HubChildRow,
    text: string,
    delivery: 'queue' | 'steer',
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  peerLinks: { checkSend(from: string, to: string, now: number): { linked: boolean; ok?: boolean } }
  hubRemoteOutboxHost(clients: unknown): HubRemoteOutboxHost
  hubRemote: unknown
}

/** The desktop's control, as a fake that records what would go to the child's machine. */
function fakeControl(opts: { available?: boolean; refuse?: string } = {}) {
  const calls: Array<{ op: string; args: unknown[] }> = []
  return {
    calls,
    available: () => opts.available ?? true,
    machineName: () => 'Machine vm1',
    isStopping: () => false,
    factsOf: () => null,
    deliver: async (...args: unknown[]) => {
      calls.push({ op: 'deliver', args: [(args[0] as HubChildRow).childId, ...args.slice(1)] })
      if (opts.refuse) throw new Error(opts.refuse)
    },
    stop: async (c: HubChildRow) => {
      calls.push({ op: 'stop', args: [c.childId] })
      return { pending: true, ran: false }
    },
    stopAll: async (machineId: string, parentId: string) => {
      calls.push({ op: 'stopAll', args: [machineId, parentId] })
      return { pending: false }
    },
    interrupt: async (c: HubChildRow) => {
      calls.push({ op: 'interrupt', args: [c.childId] })
      return true
    },
  }
}

async function setup() {
  state.outbox.length = 0
  state.saved.length = 0
  state.remoteFlag = false
  const host = new FakeHost()
  const adapter = new Adapter()
  const registry = new ProviderRegistry(host, new Map<ProviderKind, ProviderAdapter>([['claude', adapter]]))
  registry.registerIpcHandlers()
  for (const threadId of ['vmchild', 'parent1', 'lchild', 'other'])
    await host.invoke(ProviderChannels.START_SESSION, { threadId, provider: 'claude', cwd: process.cwd() })
  const row = (childId: string) => children.find((c) => c.childId === childId) as unknown as HubChildRow
  return { host, adapter, registry, internals: registry as unknown as Internals, row }
}

describe('a child whose parent runs on another machine', () => {
  it('sends its parent a message through the outbox, says so, and tells the hub client', async () => {
    const { host, adapter, registry } = await setup()
    expect(registry.isLineagePeer('vmchild', 'stub1')).toBe(true)
    expect(registry.listPeerSessions('vmchild').find((s) => s.sessionId === 'stub1')).toEqual({
      sessionId: 'stub1',
      title: 'Parent chat (on another machine)',
      folder: '',
      midTurn: false,
      linked: false,
      hub: 'parent',
    })
    const result = await createPeerToolHandlers(registry, 'vmchild').sendMessage({
      sessionId: 'stub1',
      message: 'found the bug',
      delivery: 'steer',
    })
    expect(result).toEqual({ content: [{ type: 'text', text: HUB_OUTBOX_MESSAGE_SENT_TEXT }] })
    expect(state.outbox).toEqual([{ childId: 'vmchild', parentId: 'stub1', text: 'found the bug', delivery: 'steer' }])
    expect(host.emitted).toContain(HubRemoteChannels.OUTBOX)
    expect(adapter.sends).toEqual([])
  })

  it('keeps every other target on the ordinary rules, and caps the size and the unacked messages', async () => {
    const { registry } = await setup()
    const send = (target: string, text: string) =>
      registry.deliverPeerMessage({ fromThreadId: 'vmchild', targetThreadId: target, text, initiator: 'agent' })
    await expect(send('other', 'hi')).rejects.toThrow('only its parent')
    await expect(send('stub1', 'x'.repeat(16 * 1024 + 1))).rejects.toThrow('byte limit')
    for (let i = 0; i < HUB_OUTBOX_MESSAGES_PER_CHILD_MAX; i++) await send('stub1', `m${i}`)
    await expect(send('stub1', 'one more')).rejects.toThrow(HUB_OUTBOX_MESSAGES_FULL_TEXT)
    expect(state.outbox).toHaveLength(HUB_OUTBOX_MESSAGES_PER_CHILD_MAX)
  })

  it('never relays a send from a chat that is not the child', async () => {
    const { registry } = await setup()
    await expect(
      registry.deliverPeerMessage({ fromThreadId: 'other', targetThreadId: 'stub1', text: 'hi', initiator: 'agent' }),
    ).rejects.toThrow('not running')
    expect(state.outbox).toEqual([])
  })
})

describe('an imported message of a child on another machine, on the desktop', () => {
  it('goes to the parent framed as the child, charging the lineage edge, with no chat row for the child', async () => {
    const { adapter, internals, row } = await setup()
    expect(await internals.deliverRemoteChildMessage(row('rchild'), 'done with step 1', 'queue')).toEqual({ ok: true })
    expect(adapter.sends).toHaveLength(1)
    expect(adapter.sends[0]!.threadId).toBe('parent1')
    expect(adapter.sends[0]!.message).toContain('Remote child')
    expect(adapter.sends[0]!.message).toContain('done with step 1')
    expect(state.saved.map((s) => s.conversationId)).toEqual(['parent1'])

    // The delivery used one of the edge's messages: 59 are left, then it refuses.
    for (let i = 0; i < PEER_LINEAGE_MESSAGE_BUDGET - 1; i++)
      expect(internals.peerLinks.checkSend('rchild', 'parent1', Date.now())).toMatchObject({ ok: true })
    const spent = await internals.deliverRemoteChildMessage(row('rchild'), 'one more', 'queue')
    expect(spent).toMatchObject({ ok: false, reason: expect.stringContaining('used all 60 messages') })
    expect(adapter.sends).toHaveLength(1)
  })

  it('refuses a local child and a child that is not open', async () => {
    const { adapter, internals, row } = await setup()
    expect(await internals.deliverRemoteChildMessage(row('lchild'), 'x', 'queue')).toMatchObject({ ok: false })
    expect(
      await internals.deliverRemoteChildMessage({ ...row('rchild'), phase: 'failed_start' }, 'x', 'queue'),
    ).toMatchObject({ ok: false, reason: 'the child is not open' })
    expect(adapter.sends).toEqual([])
  })

  it('holds a message past the per-pair rate for a later pull instead of refusing it', async () => {
    const { adapter, internals, row } = await setup()
    const host = internals.hubRemoteOutboxHost({})
    // A backlog after the machine was away: five go in the minute, the sixth waits.
    for (let i = 0; i < 5; i++) {
      expect(host.rateHasRoom(row('rchild'))).toBe(true)
      expect(await host.deliverMessage({ child: row('rchild'), text: `m${i}`, delivery: 'queue' })).toEqual({
        ok: true,
      })
    }
    expect(host.rateHasRoom(row('rchild'))).toBe(false)
    expect(host.parentRunning('parent1')).toBe(true)
    expect(adapter.sends).toHaveLength(5)
  })
})

describe('a parent message to its child on another machine (flag hub_remote_children)', () => {
  it('charges the lineage edge here once, then delivers there as queue or steer', async () => {
    const { registry, internals, adapter } = await setup()
    state.remoteFlag = true
    const control = fakeControl()
    internals.hubRemote = control
    const send = (text: string, delivery: 'queue' | 'steer') =>
      registry.deliverPeerMessage({
        fromThreadId: 'parent1',
        targetThreadId: 'rchild',
        text,
        initiator: 'agent',
        delivery,
      })
    await send('rebase first', 'queue')
    await send('stop that', 'steer')
    expect(control.calls).toEqual([
      { op: 'deliver', args: ['rchild', 'rebase first', 'queue', 'Parent chat'] },
      { op: 'deliver', args: ['rchild', 'stop that', 'steer', 'Parent chat'] },
    ])
    expect(adapter.sends).toEqual([])
    // Two of the edge's 60 messages are spent: 58 are left, then it refuses before any call there.
    for (let i = 0; i < PEER_LINEAGE_MESSAGE_BUDGET - 2; i++)
      expect(internals.peerLinks.checkSend('parent1', 'rchild', Date.now())).toMatchObject({ ok: true })
    await expect(send('one more', 'queue')).rejects.toThrow('used all 60 messages')
    expect(control.calls).toHaveLength(2)
  })

  it('gives the charge back when the machine refuses, and refuses a user send', async () => {
    const { registry, internals } = await setup()
    state.remoteFlag = true
    internals.hubRemote = fakeControl({ refuse: 'Machine vm1 is not connected' })
    await expect(
      registry.deliverPeerMessage({ fromThreadId: 'parent1', targetThreadId: 'rchild', text: 'x', initiator: 'agent' }),
    ).rejects.toThrow('not connected')
    for (let i = 0; i < PEER_LINEAGE_MESSAGE_BUDGET; i++)
      expect(internals.peerLinks.checkSend('parent1', 'rchild', Date.now())).toMatchObject({ ok: true })
    await expect(
      registry.deliverPeerMessage({ fromThreadId: 'parent1', targetThreadId: 'rchild', text: 'x', initiator: 'user' }),
    ).rejects.toThrow()
  })

  it('keeps the old "not running" refusal with the flag off', async () => {
    const { registry, internals } = await setup()
    const control = fakeControl()
    internals.hubRemote = control
    await expect(
      registry.deliverPeerMessage({ fromThreadId: 'parent1', targetThreadId: 'rchild', text: 'x', initiator: 'agent' }),
    ).rejects.toThrow('not running')
    expect(control.calls).toEqual([])
  })

  it('on the child machine: arrives framed as from the parent, with no budget charged there', async () => {
    const { host, adapter, internals } = await setup()
    const answer = await host.invoke(HubRemoteChannels.DELIVER, {
      v: 1,
      desktopInstallId: 'hub-desk',
      childId: 'vmchild',
      text: 'please rebase',
      delivery: 'queue',
      fromLabel: 'Big task',
    })
    expect(answer).toEqual({ v: 1, ok: true })
    expect(adapter.sends).toHaveLength(1)
    expect(adapter.sends[0]!.threadId).toBe('vmchild')
    expect(adapter.sends[0]!.message).toContain('Big task')
    expect(adapter.sends[0]!.message).toContain('please rebase')
    // The edge here was not charged: all 60 are still there.
    for (let i = 0; i < PEER_LINEAGE_MESSAGE_BUDGET; i++)
      expect(internals.peerLinks.checkSend('stub1', 'vmchild', Date.now())).toMatchObject({ ok: true })
    // Another hub's install id, and a desktop row's child, are refused.
    expect(
      await host.invoke(HubRemoteChannels.DELIVER, {
        v: 1,
        desktopInstallId: 'hub-other',
        childId: 'vmchild',
        text: 'x',
        delivery: 'queue',
        fromLabel: 'P',
      }),
    ).toMatchObject({ ok: false, code: 'not_own' })
    expect(
      await host.invoke(HubRemoteChannels.STOP, { v: 1, desktopInstallId: 'hub-desk', childId: 'lchild' }),
    ).toMatchObject({ ok: false, code: 'not_own' })
  })
})

describe('Stop of a child on another machine, through the registry', () => {
  it("routes the user's Stop to the child's machine", async () => {
    const { host, internals } = await setup()
    state.remoteFlag = true
    const control = fakeControl()
    internals.hubRemote = control
    await host.invoke(ProviderChannels.INTERRUPT, 'rchild')
    expect(control.calls).toEqual([{ op: 'stop', args: ['rchild'] }])
  })

  it('keeps the old text for a machine without the control channels', async () => {
    const { host, internals } = await setup()
    state.remoteFlag = true
    internals.hubRemote = fakeControl({ available: false })
    await expect(host.invoke(ProviderChannels.INTERRUPT, 'rchild')).rejects.toThrow(HUB_REMOTE_STOP_LATER_TEXT)
  })

  it('keeps the old text with the flag off', async () => {
    const { host, internals } = await setup()
    const control = fakeControl()
    internals.hubRemote = control
    await expect(host.invoke(ProviderChannels.INTERRUPT, 'rchild')).rejects.toThrow(HUB_REMOTE_STOP_LATER_TEXT)
    expect(control.calls).toEqual([])
  })
})
