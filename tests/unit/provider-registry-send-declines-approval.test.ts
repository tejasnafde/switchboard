/**
 * A message the user sends while an approval card waits answers the card:
 * the registry denies every open approval of the chat with a reason, then
 * steers (or queues) the message. A failed deny sends nothing.
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
  getProviderInstanceFull: (id: string) => ({
    id,
    agentType: 'claude-code',
    displayName: id,
    enabled: true,
    env: {},
    oauthDir: null,
  }),
  listOauthDirsForAgent: () => [],
}))

vi.mock('../../src/main/provider/remote-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/provider/remote-gate')>()
  return { ...actual, remoteProviderLoginPrompt: () => null }
})

/** A Claude session's rotated UUID, mapped back to the chat's root id. */
const rotated = new Map<string, string>([['session-uuid', 't1']])

vi.mock('../../src/main/db/database', () => ({
  recordThreadSession: () => {},
  recordConversationSegment: () => {},
  updateConversationSessionId: () => {},
  saveMessageIfAbsent: () => true,
  getConversationById: (id: string) => ({ id }),
  getConversationTitle: () => null,
  resolveRootThreadId: (id: string) => rotated.get(id) ?? id,
  getConversationRuntimeMode: () => null,
  getConversationModel: () => null,
  getConversationReasoningEffort: () => null,
  getConversationAgentType: () => null,
  getConversationProviderInstanceId: () => null,
  getSetting: () => null,
  getConversationExecutionRoot: () => null,
  commitConversationExecutionRoot: () => {},
  commitConversationProviderSwitch: () => {},
  getDb: () => ({}),
}))

import { ProviderRegistry } from '../../src/main/provider/provider-registry'
import { ProviderChannels } from '../../src/shared/ipc-channels'
import type { BackendHost } from '../../src/main/backend/host'
import type { ProviderAdapter, ProviderKind, ProviderSession, SessionStartOpts } from '../../src/main/provider/types'
import type {
  ApprovalDecision,
  RuntimeEvent,
  UserTurnSubmissionResult,
  UserTurnSubmissionV1,
} from '../../src/shared/provider-events'
import type { AtomicUserTurnContext } from '../../src/main/provider/durable-turn-acceptance'
import type { TurnDelivery } from '../../src/shared/turn-delivery'
import { TurnNotAcceptedError } from '../../src/main/provider/durable-turn-acceptance'
import { SEND_DECLINES_APPROVAL_REASON } from '../../src/main/provider/provider-registry'
import { stripSenderLine } from '../../src/shared/sender-line'

class FakeHost implements BackendHost {
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn)
  }
  on(): void {}
  emit(): void {}
  async invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
    const fn = this.handlers.get(channel)
    if (!fn) throw new Error(`no handler registered for ${channel}`)
    return (await fn(...args)) as T
  }
}

class RecordingAdapter implements ProviderAdapter {
  private onEvent: (e: RuntimeEvent) => void = () => {}
  calls: string[] = []
  failRespond = false
  constructor(readonly provider: ProviderKind) {}

  async startSession(opts: SessionStartOpts, onEvent: (e: RuntimeEvent) => void): Promise<ProviderSession> {
    this.onEvent = onEvent
    return {
      threadId: opts.threadId,
      provider: this.provider,
      status: 'idle',
      runtimeMode: 'sandbox',
      cwd: opts.cwd,
      createdAt: 0,
    }
  }
  emit(event: RuntimeEvent): void {
    this.onEvent(event)
  }
  async sendTurn(_t: string, message: string, _r?: unknown, _i?: unknown, delivery?: TurnDelivery): Promise<void> {
    this.calls.push(`send ${stripSenderLine(message)} ${delivery ?? 'default'}`)
  }
  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
  ): Promise<void> {
    if (this.failRespond) throw new Error('provider gone')
    this.calls.push(`respond ${requestId} ${decision} ${reason ?? '-'}`)
    this.onEvent({ type: 'request.closed', threadId, requestId, decision })
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async setRuntimeMode(): Promise<void> {}
  async isAvailable(): Promise<boolean> {
    return true
  }
}

/** Runs prepare and dispatch like the durable store; `refuseDispatch` is its `beginDispatch` saying no. */
function passThroughSubmission() {
  return {
    refuseDispatch: false,
    async submit(input: UserTurnSubmissionV1, context: AtomicUserTurnContext): Promise<UserTurnSubmissionResult> {
      try {
        await context.prepare()
        if (this.refuseDispatch) {
          return { status: 'pending', accepted: false, duplicate: true, state: 'pending', reason: 'refused' }
        }
        await context.dispatch(context.finalize ? await context.finalize(input) : input)
      } catch (error) {
        if (error instanceof TurnNotAcceptedError) {
          return { status: 'rejected', accepted: false, duplicate: false, state: 'rejected', error: error.message }
        }
        throw error
      }
      return { status: 'accepted', accepted: true, duplicate: false, state: 'completed', acceptedAt: 1 }
    },
  }
}

async function setup(provider: ProviderKind, threadId = 't1') {
  const host = new FakeHost()
  const adapter = new RecordingAdapter(provider)
  const submission = passThroughSubmission()
  const registry = new ProviderRegistry(host, new Map([[provider, adapter]]), undefined, submission)
  registry.registerIpcHandlers()
  await host.invoke(ProviderChannels.START_SESSION, { threadId, provider, cwd: '/tmp' })
  const submit = (text: string, delivery?: TurnDelivery) =>
    host.invoke<UserTurnSubmissionResult>(ProviderChannels.SUBMIT_USER_TURN, {
      version: 1,
      threadId,
      origin: `o-${text}`,
      providerText: text,
      ...(delivery ? { delivery } : {}),
    })
  const openApproval = (requestId: string) =>
    adapter.emit({
      type: 'request.opened',
      threadId: 't1',
      requestId,
      requestType: 'command',
      toolName: 'Bash',
      detail: 'rm -rf build',
    })
  return { host, adapter, registry, submission, submit, openApproval }
}

describe('a user send while an approval card waits', () => {
  it('denies the card with a reason, then steers the message', async () => {
    const { adapter, registry, submit, openApproval } = await setup('claude')
    await submit('first')
    openApproval('r1')
    adapter.calls = []

    const result = await submit('do it differently')

    expect(result.accepted).toBe(true)
    expect(adapter.calls).toEqual([
      `respond r1 deny ${SEND_DECLINES_APPROVAL_REASON}`,
      'send do it differently default',
    ])
    expect(registry.getPendingRequests('t1')).toEqual([])
  })

  it('denies every open card of the chat', async () => {
    const { adapter, submit, openApproval } = await setup('codex')
    await submit('first')
    openApproval('r1')
    openApproval('r2')
    adapter.calls = []

    await submit('stop, try another way')

    expect(adapter.calls.filter((c) => c.startsWith('respond'))).toEqual([
      `respond r1 deny ${SEND_DECLINES_APPROVAL_REASON}`,
      `respond r2 deny ${SEND_DECLINES_APPROVAL_REASON}`,
    ])
    expect(adapter.calls.at(-1)).toBe('send stop, try another way default')
  })

  it('denies the card and queues the message on an agent that cannot steer', async () => {
    const { adapter, submit, openApproval } = await setup('opencode')
    await submit('first')
    openApproval('r1')
    adapter.calls = []

    const result = await submit('something else', 'queue')

    expect(result.accepted).toBe(true)
    expect(adapter.calls).toEqual([`respond r1 deny ${SEND_DECLINES_APPROVAL_REASON}`, 'send something else queue'])
  })

  it('sends nothing when the deny fails', async () => {
    const { adapter, registry, submit, openApproval } = await setup('claude')
    await submit('first')
    openApproval('r1')
    adapter.calls = []
    adapter.failRespond = true

    const result = await submit('do it differently')

    expect(result.accepted).toBe(false)
    expect(adapter.calls).toEqual([])
    expect(registry.getPendingRequests('t1').map((e) => e.type)).toEqual(['request.opened'])
  })

  it('denies the card on the legacy send channel too', async () => {
    const { adapter, host, openApproval } = await setup('claude')
    await host.invoke(ProviderChannels.SEND_TURN, 't1', 'first')
    openApproval('r1')
    adapter.calls = []

    await host.invoke(ProviderChannels.SEND_TURN, 't1', 'redirect')

    expect(adapter.calls).toEqual([`respond r1 deny ${SEND_DECLINES_APPROVAL_REASON}`, 'send redirect default'])
  })

  it('leaves an open question alone', async () => {
    const { adapter, registry, submit } = await setup('claude')
    await submit('first')
    adapter.emit({ type: 'question.asked', threadId: 't1', requestId: 'q1', questions: [] })
    adapter.calls = []

    await submit('more context')

    expect(adapter.calls).toEqual(['send more context default'])
    expect(registry.getPendingRequests('t1').map((e) => e.type)).toEqual(['question.asked'])
  })

  it('does not answer a card for a turn the user did not send', async () => {
    const { adapter, registry, submit, openApproval } = await setup('claude')
    await submit('first')
    openApproval('r1')
    adapter.calls = []

    await registry.submitManagedUserTurn({ version: 1, threadId: 't1', origin: 'managed', providerText: 'brief' })

    expect(adapter.calls).toEqual(['send brief default'])
    expect(registry.getPendingRequests('t1').map((e) => e.type)).toEqual(['request.opened'])
  })

  it('leaves the card open when the turn cannot enter dispatch', async () => {
    const { adapter, registry, submission, submit, openApproval } = await setup('claude')
    await submit('first')
    openApproval('r1')
    adapter.calls = []
    submission.refuseDispatch = true

    const result = await submit('do it differently')

    expect(result.accepted).toBe(false)
    expect(adapter.calls).toEqual([])
    expect(registry.getPendingRequests('t1').map((e) => e.type)).toEqual(['request.opened'])
  })

  it('leaves the card open when the turn checkpoint refuses', async () => {
    const { adapter, registry, submit, openApproval } = await setup('claude')
    await submit('first')
    openApproval('r1')
    adapter.calls = []
    vi.spyOn(Reflect.get(registry, 'checkpoints'), 'beginTurn').mockRejectedValueOnce(new Error('disk full'))

    const result = await submit('do it differently')

    expect(result.accepted).toBe(false)
    expect(adapter.calls).toEqual([])
    expect(registry.getPendingRequests('t1').map((e) => e.type)).toEqual(['request.opened'])
  })

  it('denies a card stored under the root id when the send names the rotated session id', async () => {
    const { adapter, submit } = await setup('claude', 'session-uuid')
    await submit('first')
    adapter.emit({
      type: 'request.opened',
      threadId: 't1',
      requestId: 'r1',
      requestType: 'command',
      toolName: 'Bash',
      detail: 'ls',
    })
    adapter.calls = []

    await submit('redirect')

    expect(adapter.calls).toEqual([`respond r1 deny ${SEND_DECLINES_APPROVAL_REASON}`, 'send redirect default'])
  })
})
