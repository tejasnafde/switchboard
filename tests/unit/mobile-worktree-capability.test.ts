import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeIapData } from '../../src/shared/iap-tunnel'
import { encodeFrame, type WsFrame } from '../../src/shared/ws-protocol'
import type { Transport } from '../../src/shared/transport'
import { SwitchboardClient } from '../../apps/mobile/src/lib/api'
import { IapTransport } from '../../apps/mobile/src/lib/iap-transport'
import { restoredWorktreeForm, shouldOfferWorktreeCreation } from '../../apps/mobile/src/lib/worktreeCapability'
import type { MobileNewSessionCreationState } from '../../apps/mobile/src/lib/newSessionCreation'

class FakeIapSocket {
  static instance: FakeIapSocket | null = null
  readyState = 1
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor() {
    FakeIapSocket.instance = this
  }

  send(): void {}
  close(): void {}

  receive(frame: WsFrame): void {
    const payload = new TextEncoder().encode(`${encodeFrame(frame)}\n`)
    const bytes = encodeIapData(payload)
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    this.onmessage?.({ data } as MessageEvent)
  }
}

function creationState(
  status: MobileNewSessionCreationState['status'],
  checkout: 'parent-checkout' | 'worktree' = 'parent-checkout',
): MobileNewSessionCreationState {
  return {
    status,
    intent: {
      connectionId: 'machine-1',
      machineId: 'machine-1',
      projectPath: '/repo',
      projectName: 'repo',
      checkout: checkout === 'worktree'
        ? { kind: 'worktree', baseRef: 'HEAD', branchSeed: 'repo', setupPolicy: 'skip' }
        : { kind: 'parent-checkout' },
      conversation: { id: 'conversation-1', agentType: 'codex' },
      provider: {},
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  FakeIapSocket.instance = null
})

describe('IapTransport backend capabilities', () => {
  it('distinguishes an unknown handshake from an old backend that omits capabilities', () => {
    vi.stubGlobal('WebSocket', FakeIapSocket)
    const transport = new IapTransport({
      target: { project: 'project', zone: 'zone', instance: 'vm', port: 9473 },
      accessToken: 'token',
    })
    expect(transport.supportsCapability('worktree_creation_v1')).toBeUndefined()

    FakeIapSocket.instance!.receive({
      k: 'ready', epoch: 'old-backend', seq: 0, replayed: 0, gap: false,
    })

    expect(transport.supportsCapability('worktree_creation_v1')).toBe(false)
    transport.close()
  })

  it('replaces the advertised set on a later ready frame', () => {
    vi.stubGlobal('WebSocket', FakeIapSocket)
    const transport = new IapTransport({
      target: { project: 'project', zone: 'zone', instance: 'vm', port: 9473 },
      accessToken: 'token',
    })
    const socket = FakeIapSocket.instance!
    socket.receive({
      k: 'ready',
      epoch: 'new-backend',
      seq: 0,
      replayed: 0,
      gap: false,
      capabilities: ['worktree_creation_v1'],
    })
    expect(transport.supportsCapability('worktree_creation_v1')).toBe(true)

    socket.receive({ k: 'ready', epoch: 'old-backend', seq: 0, replayed: 0, gap: false })

    expect(transport.supportsCapability('worktree_creation_v1')).toBe(false)
    transport.close()
  })
})

describe('SwitchboardClient backend capabilities', () => {
  it('exposes the transport handshake without converting unknown to unsupported', () => {
    let advertised: boolean | undefined
    const transport: Transport = {
      invoke: async () => undefined,
      send: () => undefined,
      on: () => () => undefined,
      supportsCapability: () => advertised,
    }
    const client = new SwitchboardClient(transport)

    expect(client.supportsCapability('worktree_creation_v1')).toBeUndefined()
    advertised = true
    expect(client.supportsCapability('worktree_creation_v1')).toBe(true)
    advertised = false
    expect(client.supportsCapability('worktree_creation_v1')).toBe(false)
  })
})

describe('React Native worktree option policy', () => {
  it('hides a new worktree request while capability support is unknown or absent', () => {
    const idle: MobileNewSessionCreationState = { status: 'idle' }
    expect(shouldOfferWorktreeCreation(undefined, idle)).toBe(false)
    expect(shouldOfferWorktreeCreation(false, idle)).toBe(false)
  })

  it('offers a new worktree when the backend advertises support', () => {
    expect(shouldOfferWorktreeCreation(true, { status: 'idle' })).toBe(true)
  })

  it('keeps an existing worktree recovery visible across a mixed-version reconnect', () => {
    expect(shouldOfferWorktreeCreation(false, creationState('cleanup_required', 'worktree'))).toBe(true)
    expect(shouldOfferWorktreeCreation(undefined, creationState('ambiguous', 'worktree'))).toBe(true)
  })

  it('does not treat a completed worktree creation as an active recovery', () => {
    expect(shouldOfferWorktreeCreation(false, creationState('ready', 'worktree'))).toBe(false)
  })

  it('restores the exact editable worktree intent after process death', () => {
    const state = creationState('cleanup_required', 'worktree')
    state.intent = {
      ...state.intent!,
      checkout: { kind: 'worktree', baseRef: 'origin/main', branchSeed: 'repo', setupPolicy: 'run' },
      provider: { kind: 'codex', instanceId: 'work', model: 'gpt-5', runtimeMode: 'plan' },
      firstMessage: 'Resume this exact launch.',
    }

    expect(restoredWorktreeForm(state.intent)).toEqual({
      checkoutKind: 'worktree',
      baseRef: 'origin/main',
      setupPolicy: 'run',
      provider: state.intent.provider,
      agentType: 'codex',
      firstMessage: 'Resume this exact launch.',
    })
  })
})
