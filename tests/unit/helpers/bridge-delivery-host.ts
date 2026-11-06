/**
 * A fake provider registry for the bridge's delivery service: the live
 * sessions, the queue, the Stop and the real durable atomic user-turn
 * acceptance on the test database. The bridge delivery tests and the relay
 * command tests drive the same host.
 */
import { getConversationRuntimeMode, getDb, resolveRootThreadId } from '../../../src/main/db/database'
import { SqliteTurnAcceptanceStore } from '../../../src/main/db/turn-acceptance'
import { AtomicUserTurnSubmission } from '../../../src/main/provider/durable-turn-acceptance'
import type { BridgeDeliveryHost } from '../../../src/main/bridge/delivery-service'
import type { SessionStartOpts } from '../../../src/main/provider/types'
import type { PendingBlockingEvent } from '../../../src/shared/pending-requests'
import type { RuntimeMode, UserTurnSubmissionResult, UserTurnSubmissionV1 } from '../../../src/shared/provider-events'
import type { QueuedTurnSummary } from '../../../src/shared/turn-delivery'
import type { AgentType } from '../../../src/shared/types'

export interface LiveChat {
  provider: string
  midTurn: boolean
  steerBlocked: boolean
}

export class FakeHost implements BridgeDeliveryHost {
  constructor(private readonly machine: string) {}

  flag = true
  live = new Map<string, LiveChat>()
  busyChats = new Set<string>()
  /** Owes a turn only for messages held in its queue: busy, but not running. */
  heldOnly = new Set<string>()
  startingThreads = new Set<string>()
  openChildren = new Set<string>()
  pending = new Map<string, PendingBlockingEvent[]>()
  queued = new Map<string, QueuedTurnSummary[]>()
  starts: SessionStartOpts[] = []
  dispatched: UserTurnSubmissionV1[] = []
  interrupts: string[] = []
  cancelled: string[] = []
  /** Runs instead of the default start. */
  onStart: ((opts: SessionStartOpts) => Promise<void>) | null = null
  /** The provider takes the turn, then the process "dies" before the answer. */
  dieAfterDispatch = false
  /** False while the provider has not taken the turn yet: a Stop then does nothing. */
  interruptLands = true
  instanceId = 'claude-code-work'
  private readonly atomic = new AtomicUserTurnSubmission({
    store: new SqliteTurnAcceptanceStore(() => getDb()),
    publish: () => {},
  })

  enabled = () => this.flag
  machineId = () => this.machine
  liveThread = (chatId: string) => {
    if (this.live.has(chatId)) return chatId
    const root = resolveRootThreadId(chatId)
    for (const id of this.live.keys()) if (resolveRootThreadId(id) === root) return id
    return null
  }
  starting = (threadId: string) => this.startingThreads.has(threadId)
  startSession = async (opts: SessionStartOpts) => {
    this.starts.push(opts)
    if (this.onStart) await this.onStart(opts)
    else this.live.set(opts.threadId, { provider: opts.provider, midTurn: false, steerBlocked: false })
    return { instanceId: this.instanceId }
  }
  submitTurn = async (input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult> => {
    const result = await this.atomic.submit(input, {
      clientScope: 'test-scope',
      conversationId: resolveRootThreadId(input.threadId),
      prepare: async () => {},
      dispatch: async (turn) => {
        this.dispatched.push(turn)
      },
    })
    if (this.dieAfterDispatch) throw new Error('backend died')
    return result
  }
  provider = (threadId: string) => this.live.get(threadId)?.provider ?? null
  midTurn = (threadId: string) => this.live.get(threadId)?.midTurn ?? false
  steerBlocked = (threadId: string) => this.live.get(threadId)?.steerBlocked ?? false
  busy = (chatId: string) =>
    this.busyChats.has(resolveRootThreadId(chatId)) || this.heldOnly.has(resolveRootThreadId(chatId))
  running = (chatId: string) => this.busyChats.has(resolveRootThreadId(chatId))
  chatMode = (chatId: string) => (getConversationRuntimeMode(resolveRootThreadId(chatId)) ?? 'sandbox') as RuntimeMode
  isOpenChild = (chatId: string) => this.openChildren.has(resolveRootThreadId(chatId))
  agentAvailable = async (agent: AgentType) => agent !== 'gemini'
  interrupt = async (threadId: string) => {
    this.interrupts.push(threadId)
    if (this.interruptLands) this.busyChats.delete(resolveRootThreadId(threadId))
  }
  queuedTurns = (threadId: string) => this.queued.get(threadId) ?? []
  cancelQueuedTurn = async (threadId: string, messageId: string) => {
    this.cancelled.push(messageId)
    const turn = this.queuedTurns(threadId).find((q) => q.messageId === messageId)!
    this.queued.set(
      threadId,
      this.queuedTurns(threadId).filter((q) => q.messageId !== messageId),
    )
    return { ok: true as const, turn }
  }
}
