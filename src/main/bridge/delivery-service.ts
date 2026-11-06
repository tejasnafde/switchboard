/**
 * The bridge's owner delivery: start_chat, send_to_chat and stop_chat in the
 * projects the owner allowed on this desktop.
 *
 * One typed service. The local MCP wrapper (`mcp/bridge-tools.ts`) calls it
 * for an agent thread; the relay endpoint will call the same methods for the
 * owner. A chat starts through the managed session service and every message
 * goes in through the durable atomic user-turn acceptance, as an ordinary
 * user turn: it cannot answer a pending approval, and the chat keeps its own
 * permission gates. Nothing here goes through the agent-to-agent peer gate.
 *
 * Every call reserves `(operation, idempotency_key)` with its input hash
 * before any provider action. The same key and body answers from that record;
 * another body is `idempotency_conflict`. A message's origin is `bridge-<call
 * id>`, so a retry after a crash finds the turn the provider already took and
 * never sends it twice.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import {
  bridgeError,
  bridgeInputHash,
  resolveBridgeMode,
  type BridgeCallState,
  type BridgeChatRef,
  type BridgeError,
  type BridgeErrorCode,
  type BridgeOperation,
} from '@shared/bridge'
import { modelsForAgent } from '@shared/models'
import {
  echoMessageId,
  RUNTIME_MODES,
  type RuntimeMode,
  type UserTurnSubmissionResult,
  type UserTurnSubmissionV1,
} from '@shared/provider-events'
import {
  peerDelivery,
  type QueuedTurnActionResult,
  type QueuedTurnSummary,
  type TurnDelivery,
} from '@shared/turn-delivery'
import { isAgentType, providerKindFor, type AgentType } from '@shared/types'
import {
  bridgeCallRetired,
  createConversation,
  findBridgeCall,
  getBridgeCall,
  getConversationById,
  getConversationExecutionRoot,
  getConversationForkMetadata,
  getDb,
  listBridgeOrigins,
  recordBridgeOrigin,
  reserveBridgeCall,
  resolveRootThreadId,
  setConversationModel,
  setConversationProviderInstanceId,
  setConversationRuntimeMode,
  updateBridgeCallState,
  type BridgeCallRecord,
} from '../db/database'
import { turnAcceptanceStateByOrigin } from '../db/turn-acceptance'
import { createMainLogger } from '../logger'
import type { SessionStartOpts } from '../provider/types'
import { bridgeProjectAgents, type AllowedProject, type BridgeReadService, type BridgeResult } from './read-service'

const log = createMainLogger('bridge:delivery')

export const BRIDGE_MESSAGE_MAX_CHARS = 20_000
const IDEMPOTENCY_KEY_MAX_CHARS = 200
const ORIGIN_PREFIX = 'bridge-'
/** The chat row id of a queued bridge message starts with this. */
const QUEUED_BRIDGE_PREFIX = echoMessageId(ORIGIN_PREFIX)

/** What the provider registry does for the service. */
export interface BridgeDeliveryHost {
  /** The `instinct_bridge` flag, read on every call. */
  enabled(): boolean
  machineId(): string
  /** The id a live session runs under for any id of the chat, or null. */
  liveThread(chatId: string): string | null
  /** A session start for this thread is in flight. */
  starting(threadId: string): boolean
  /** Resolves to the started session; `instanceId` is the account it resolved to. */
  startSession(opts: SessionStartOpts): Promise<{ instanceId?: string }>
  submitTurn(input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult>
  /** The live session's provider. */
  provider(threadId: string): string | null
  /** An accepted turn has not completed on this live thread. */
  midTurn(threadId: string): boolean
  /** The running turn is compacting or being stopped, so a steer would be lost. */
  steerBlocked(threadId: string): boolean
  /** Any id of the chat runs, prepares or still owes a turn. */
  busy(chatId: string): boolean
  /** Any id of the chat runs or prepares a turn; held queued messages do not count. */
  running(chatId: string): boolean
  /** The chat's current runtime mode: the live session's, else the saved one. */
  chatMode(chatId: string): RuntimeMode
  isOpenChild(chatId: string): boolean
  agentAvailable(agent: AgentType): Promise<boolean>
  /** The user's Stop: interrupts the turn and disarms its automatic resume. */
  interrupt(threadId: string): Promise<unknown>
  queuedTurns(threadId: string): QueuedTurnSummary[]
  cancelQueuedTurn(threadId: string, messageId: string): Promise<QueuedTurnActionResult>
}

/**
 * Who asks. A local agent is identified by its MCP token: it cannot act from
 * plan mode and cannot start or drive work in a mode wider than its own.
 */
export interface BridgeCaller {
  kind: 'local-agent'
  chatId: string
  mode: RuntimeMode
}

export interface StartChatInput {
  project: string
  message: string
  agent?: string
  model?: string
  mode?: string
  idempotency_key: string
}

export interface SendToChatInput {
  chat: unknown
  message: string
  delivery?: TurnDelivery
  idempotency_key: string
}

export interface StopChatInput {
  chat: unknown
  idempotency_key: string
}

interface ReceiptBase {
  call_id: string
  observed_at: string
  machine_ids: string[]
  /** `accepted`: the turn or stop is recorded, not that the agent finished. `dispatching`: an earlier attempt is still in flight. */
  state: BridgeCallState
  /** True when this answers an earlier call with the same key. */
  replayed: boolean
  chat: BridgeChatRef
}

export interface BridgeStartReceipt extends ReceiptBase {
  project: { project_id: string; label: string }
  message_id: string
  agent: AgentType
  model: string | null
  mode: RuntimeMode
}

/** `turn`: the chat was idle and the message started a turn. */
export type BridgeActualDelivery = 'turn' | 'steer' | 'queue'

export interface BridgeSendReceipt extends ReceiptBase {
  message_id: string
  delivery: { requested: TurnDelivery; actual: BridgeActualDelivery | null }
}

export interface BridgeStopReceipt extends ReceiptBase {
  /** `stopped` only once the chat has no turn left; a stop that cannot confirm that is `stop_unconfirmed`. */
  status: 'stopping' | 'stopped' | null
}

type CallTarget =
  | {
      op: 'start_chat'
      chat_id: string
      project_id: string
      label: string
      origin: string
      agent: AgentType
      model: string | null
      mode: RuntimeMode
    }
  | { op: 'send_to_chat'; chat_id: string; project_id: string; origin: string; requested: TurnDelivery }
  | { op: 'stop_chat'; chat_id: string; project_id: string }

type CallResult = { actual?: BridgeActualDelivery; status?: 'stopping' | 'stopped' }

type ReceiptOf = BridgeStartReceipt | BridgeSendReceipt | BridgeStopReceipt
type Opened = { kind: 'answer'; answer: BridgeResult<ReceiptOf> } | { kind: 'new'; key: string; hash: string }

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function narrower(a: RuntimeMode, b: RuntimeMode): RuntimeMode {
  return RUNTIME_MODES.indexOf(a) <= RUNTIME_MODES.indexOf(b) ? a : b
}

function wider(a: RuntimeMode, b: RuntimeMode): boolean {
  return RUNTIME_MODES.indexOf(a) > RUNTIME_MODES.indexOf(b)
}

/** The folder resolves inside the allowed root (itself or below it). */
function insideRoot(path: string | null | undefined, root: string): boolean {
  if (!path) return false
  try {
    const real = realpathSync.native(path)
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep)
  } catch (err) {
    log.warn('execution root does not resolve', { code: (err as NodeJS.ErrnoException).code })
    return false
  }
}

const fail = (error: BridgeError): { ok: false; error: BridgeError } => ({ ok: false, error })

export class BridgeDeliveryService {
  /** Calls running in this process: a retry of one answers `dispatching`. */
  private readonly active = new Set<string>()
  /** Starts past the one-group check and not yet finished: call id to its new chat. */
  private readonly startsInFlight = new Map<string, string>()
  /** Per root chat, how many stops it has had: a start or send that saw another count was stopped meanwhile. */
  private readonly stops = new Map<string, number>()

  constructor(
    private readonly host: BridgeDeliveryHost,
    private readonly reads: BridgeReadService,
    private readonly now: () => number = Date.now,
    private readonly timing = { stopConfirmMs: 20_000, stopPollMs: 200 },
  ) {}

  // ─── start_chat ───────────────────────────────────────────────

  async startChat(caller: BridgeCaller, input: StartChatInput): Promise<BridgeResult<BridgeStartReceipt>> {
    const opened = this.open('start_chat', caller, input)
    if (opened.kind === 'answer') return opened.answer as BridgeResult<BridgeStartReceipt>
    if (caller.mode === 'plan') return fail(planDenied())
    const machineId = this.host.machineId()
    const resolved = this.reads.resolveProject(this.reads.allowed(machineId), input.project)
    if (!resolved.ok) return resolved
    const project = resolved.value
    const { policy } = project
    const target = { project_id: policy.project_id }

    const cap = narrower(policy.maximum_mode, caller.mode)
    const mode = resolveBridgeMode(input.mode, { default_mode: narrower(policy.default_mode, cap), maximum_mode: cap })
    if (!mode.ok)
      return fail(
        bridgeError('mode_not_allowed', `This project allows modes up to ${cap} for this caller.`, { target }),
      )

    // Only agents that can start here are offered, so a choice from the list never fails the same way.
    const choices = (
      await Promise.all(bridgeProjectAgents(policy).map(async (a) => ((await this.host.agentAvailable(a)) ? a : null)))
    ).filter((a): a is AgentType => a !== null)
    const agent =
      input.agent ?? policy.default_agent ?? (choices.includes('claude-code') ? 'claude-code' : (choices[0] ?? null))
    if (!agent || !isAgentType(agent) || !choices.includes(agent))
      return fail(
        bridgeError('agent_unavailable', 'That agent is not available for this project.', {
          target,
          agent_choices: choices,
        }),
      )
    const models = modelsForAgent(agent).map((m) => m.id)
    if (input.model !== undefined && !models.includes(input.model))
      return fail(
        bridgeError('agent_unavailable', `That model is not one ${agent} offers.`, { target, model_choices: models }),
      )
    // A policy default made for another agent is not used; the agent's own saved default applies.
    const fallback = policy.default_model
    const model = input.model ?? (fallback && (models.length === 0 || models.includes(fallback)) ? fallback : null)
    if (!insideRoot(project.sidebarPath, policy.canonical_local_root))
      return fail(bridgeError('project_not_allowed', 'The project folder moved or no longer resolves.', { target }))

    // Checked and claimed with no await between, so two starts cannot both pass.
    const running = this.activeBridgeChat(machineId)
    if (running)
      return fail(
        bridgeError(
          'policy_denied',
          'Bridge work is already running on this machine. Send to that chat, or stop it first.',
          { target: { machine_id: machineId, chat_id: running } },
        ),
      )

    const callId = `bcall_${randomUUID()}`
    const chatId = `agent_${this.now()}_${randomBytes(4).toString('hex')}`
    const origin = ORIGIN_PREFIX + callId
    const reservation = reserveBridgeCall({
      callId,
      operation: 'start_chat',
      idempotencyKey: opened.key,
      inputHash: opened.hash,
      machineId,
      policyRevision: policy.revision,
      target: {
        op: 'start_chat',
        chat_id: chatId,
        project_id: policy.project_id,
        label: policy.label,
        origin,
        agent,
        model,
        mode: mode.mode,
      } satisfies CallTarget,
    })
    if (reservation.kind !== 'reserved') return this.answerRace(reservation) as BridgeResult<BridgeStartReceipt>

    this.active.add(callId)
    this.startsInFlight.set(callId, chatId)
    try {
      // The chat, its configuration and its origin exist before the provider starts.
      getDb().transaction(() => {
        createConversation(chatId, project.sidebarPath, agent)
        setConversationRuntimeMode(chatId, mode.mode)
        if (model) setConversationModel(chatId, model)
        recordBridgeOrigin({
          conversationId: chatId,
          callId,
          projectId: policy.project_id,
          machineId,
          policyRevision: policy.revision,
        })
      })()
      const fence = this.fence(chatId)
      const ref = { machine_id: machineId, chat_id: chatId }
      try {
        const session = await this.host.startSession({
          threadId: chatId,
          provider: providerKindFor(agent),
          cwd: project.sidebarPath,
          runtimeMode: mode.mode,
          ...(model ? { model } : {}),
        })
        // As a client does for a new chat: a resume after a restart keeps the account it started on.
        if (session.instanceId) setConversationProviderInstanceId(chatId, session.instanceId)
      } catch (err) {
        log.warn('bridge start: the session did not start', { callId, chatId, err: String(err) })
        if (this.fenced(chatId, fence)) return this.reject(callId, stoppedBeforeSend(ref))
        return this.reject(
          callId,
          bridgeError('agent_unavailable', 'The agent did not start. Nothing was sent.', {
            target: ref,
            agent_choices: choices,
          }),
        )
      }
      const refused = this.beforeSubmit(chatId, fence, project, caller, ref)
      if (refused) return this.reject(callId, refused)
      const delivered = await this.deliver(callId, {
        version: 1,
        threadId: this.host.liveThread(chatId) ?? chatId,
        origin,
        providerText: input.message,
        runtimeMode: mode.mode,
        autoTitleText: input.message,
      })
      if (!delivered.ok) {
        // The provider may have the message: a stop that came meanwhile covers it too.
        if (delivered.error.code === 'delivery_unknown') await this.haltIfStopped(chatId, fence)
        return delivered
      }
      await this.haltIfStopped(chatId, fence)
      log.info('bridge chat started', { callId, chatId, projectId: policy.project_id, agent, mode: mode.mode })
      return this.answer(getBridgeCall(callId)!, false) as BridgeResult<BridgeStartReceipt>
    } finally {
      this.active.delete(callId)
      this.startsInFlight.delete(callId)
    }
  }

  // ─── send_to_chat ─────────────────────────────────────────────

  async sendToChat(caller: BridgeCaller, input: SendToChatInput): Promise<BridgeResult<BridgeSendReceipt>> {
    const opened = this.open('send_to_chat', caller, input)
    if (opened.kind === 'answer') return opened.answer as BridgeResult<BridgeSendReceipt>
    if (caller.mode === 'plan') return fail(planDenied())
    const machineId = this.host.machineId()
    const resolved = this.reads.resolveChat(this.reads.allowed(machineId), machineId, input.chat)
    if (!resolved.ok) return resolved
    const { row, project } = resolved.value
    const chatId = row.id
    const ref = { machine_id: machineId, chat_id: chatId }
    if (chatId === resolveRootThreadId(caller.chatId))
      return fail(bridgeError('policy_denied', 'That is the calling chat. Pick another chat.', { target: ref }))
    const refused = this.chatRefusal(chatId, caller, project, ref)
    if (refused) return fail(refused)

    const requested = input.delivery ?? 'queue'
    const callId = `bcall_${randomUUID()}`
    const origin = ORIGIN_PREFIX + callId
    const reservation = reserveBridgeCall({
      callId,
      operation: 'send_to_chat',
      idempotencyKey: opened.key,
      inputHash: opened.hash,
      machineId,
      policyRevision: project.policy.revision,
      target: {
        op: 'send_to_chat',
        chat_id: chatId,
        project_id: project.policy.project_id,
        origin,
        requested,
      } satisfies CallTarget,
    })
    if (reservation.kind !== 'reserved') return this.answerRace(reservation) as BridgeResult<BridgeSendReceipt>

    this.active.add(callId)
    try {
      const fence = this.fence(chatId)
      if (!this.host.liveThread(chatId)) {
        const resumed = await this.resume(chatId, row.agent_type, project, ref)
        if (resumed) return this.reject(callId, this.fenced(chatId, fence) ? stoppedBeforeSend(ref) : resumed)
      }
      // The resume awaited: the chat may have changed meanwhile.
      const changed =
        this.beforeSubmit(chatId, fence, project, caller, ref) ?? this.chatRefusal(chatId, caller, project, ref)
      if (changed) return this.reject(callId, changed)
      recordBridgeOrigin({
        conversationId: chatId,
        callId,
        projectId: project.policy.project_id,
        machineId,
        policyRevision: project.policy.revision,
      })
      const live = this.host.liveThread(chatId) ?? chatId
      const actual: BridgeActualDelivery =
        peerDelivery(this.host.provider(live), this.host.midTurn(live), requested, this.host.steerBlocked(live)) ??
        'turn'
      // `queue` on an idle chat starts a turn at once, and never turns into a steer if a turn began meanwhile.
      const delivered = await this.deliver(
        callId,
        {
          version: 1,
          threadId: live,
          origin,
          providerText: input.message,
          delivery: actual === 'steer' ? 'steer' : 'queue',
        },
        { actual },
      )
      if (!delivered.ok) {
        // The provider may have the message: a stop that came meanwhile covers it too.
        if (delivered.error.code === 'delivery_unknown') await this.haltIfStopped(chatId, fence)
        return delivered
      }
      await this.haltIfStopped(chatId, fence)
      log.info('bridge message sent', { callId, chatId, requested, result: getBridgeCall(callId)?.result })
      return this.answer(getBridgeCall(callId)!, false) as BridgeResult<BridgeSendReceipt>
    } finally {
      this.active.delete(callId)
    }
  }

  // ─── stop_chat ────────────────────────────────────────────────

  /** Allowed from any mode, plan included: a stop only takes work away. */
  async stopChat(caller: BridgeCaller, input: StopChatInput): Promise<BridgeResult<BridgeStopReceipt>> {
    const opened = this.open('stop_chat', caller, input)
    if (opened.kind === 'answer') return opened.answer as BridgeResult<BridgeStopReceipt>
    const machineId = this.host.machineId()
    const resolved = this.reads.resolveChat(this.reads.allowed(machineId), machineId, input.chat)
    if (!resolved.ok) return resolved
    const { row, project } = resolved.value
    const chatId = row.id
    const callId = `bcall_${randomUUID()}`
    const reservation = reserveBridgeCall({
      callId,
      operation: 'stop_chat',
      idempotencyKey: opened.key,
      inputHash: opened.hash,
      machineId,
      policyRevision: project.policy.revision,
      target: { op: 'stop_chat', chat_id: chatId, project_id: project.policy.project_id } satisfies CallTarget,
    })
    if (reservation.kind !== 'reserved') return this.answerRace(reservation) as BridgeResult<BridgeStopReceipt>

    // Before any await: a start or send of this chat that is still in flight sends nothing after this.
    this.stops.set(chatId, (this.stops.get(chatId) ?? 0) + 1)
    this.active.add(callId)
    try {
      updateBridgeCallState(callId, 'dispatching')
      let status: 'stopped'
      try {
        status = await this.halt(chatId)
      } catch (err) {
        log.warn('bridge stop failed', { callId, chatId, err: String(err) })
        updateBridgeCallState(callId, 'delivery_unknown', { errorCode: 'stop_unconfirmed' })
        return fail(
          bridgeError('stop_unconfirmed', 'The stop could not be confirmed. Read the chat for its status.', {
            call_id: callId,
            target: { machine_id: machineId, chat_id: chatId },
          }),
        )
      }
      updateBridgeCallState(callId, 'accepted', { result: { status } satisfies CallResult })
      log.info('bridge chat stopped', { callId, chatId, status })
      return this.answer(getBridgeCall(callId)!, false) as BridgeResult<BridgeStopReceipt>
    } finally {
      this.active.delete(callId)
    }
  }

  // ─── shared steps ─────────────────────────────────────────────

  /**
   * The flag, then the key: an earlier call under the same key answers from
   * its record (after checking the project is still allowed), a changed body
   * is a conflict, and an expired key is retired.
   */
  private open(operation: BridgeOperation, caller: BridgeCaller, input: { idempotency_key: string } & object): Opened {
    if (!this.host.enabled())
      return {
        kind: 'answer',
        answer: fail(bridgeError('bridge_disabled', 'The Instinct bridge is off in Settings > Labs.')),
      }
    // A child chat answers only to its parent: the bridge is no way around that.
    if (this.host.isOpenChild(caller.chatId))
      return {
        kind: 'answer',
        answer: fail(bridgeError('child_read_only', 'A hub child chat cannot start, message or stop other chats.')),
      }
    const raw = input.idempotency_key
    if (raw.length === 0 || raw.length > IDEMPOTENCY_KEY_MAX_CHARS)
      return {
        kind: 'answer',
        answer: fail(
          bridgeError('policy_denied', `idempotency_key must be 1 to ${IDEMPOTENCY_KEY_MAX_CHARS} characters.`),
        ),
      }
    // Keys are per caller: another chat's key never replays this one's receipt.
    const key = `local:${resolveRootThreadId(caller.chatId)}:${raw}`
    const hash = bridgeInputHash(operation, input as Record<string, unknown>, sha256)
    const prior = findBridgeCall(operation, key)
    if (!prior) return { kind: 'new', key, hash }
    if (bridgeCallRetired(prior, this.now()))
      return {
        kind: 'answer',
        answer: fail(
          bridgeError('request_retired', 'That idempotency key is too old to use. Use a new one.', {
            call_id: prior.callId,
          }),
        ),
      }
    if (prior.inputHash !== hash)
      return {
        kind: 'answer',
        answer: fail(
          bridgeError('idempotency_conflict', 'That idempotency key was used with other arguments.', {
            call_id: prior.callId,
          }),
        ),
      }
    return { kind: 'answer', answer: this.replay(prior) }
  }

  /** A concurrent call reserved the key first. */
  private answerRace(reservation: Exclude<ReturnType<typeof reserveBridgeCall>, { kind: 'reserved' }>) {
    if (reservation.kind === 'existing') return this.replay(reservation.call)
    return fail(
      bridgeError(
        reservation.code,
        reservation.code === 'request_retired'
          ? 'That idempotency key is too old to use. Use a new one.'
          : 'That idempotency key was used with other arguments.',
        { call_id: reservation.callId },
      ),
    )
  }

  private replay(call: BridgeCallRecord): BridgeResult<ReceiptOf> {
    const target = JSON.parse(call.target!) as CallTarget
    // The project must still be allowed before an old receipt is shown.
    if (!this.reads.allowed(this.host.machineId()).some((a) => a.policy.project_id === target.project_id))
      return fail(bridgeError('project_not_allowed', 'That project is no longer allowed.', { call_id: call.callId }))
    return this.answer(this.reconcile(call, target), true)
  }

  /**
   * A call left mid-way by a crash, settled from the durable turn acceptance:
   * a turn the provider took is accepted under its first message id, one that
   * never reached it is rejected, and one in flight when the crash came stays
   * `delivery_unknown`. Never sent again.
   */
  private reconcile(call: BridgeCallRecord, target: CallTarget): BridgeCallRecord {
    if (this.active.has(call.callId)) return call
    if (call.state === 'recorded') {
      updateBridgeCallState(call.callId, 'rejected', { errorCode: 'internal_error', nonDeliveryConfirmed: true })
    } else if ((call.state === 'dispatching' || call.state === 'delivery_unknown') && target.op !== 'stop_chat') {
      const turn = turnAcceptanceStateByOrigin(getDb(), target.chat_id, target.origin)
      if (turn === 'completed') updateBridgeCallState(call.callId, 'accepted')
      else if (turn === 'dispatching')
        updateBridgeCallState(call.callId, 'delivery_unknown', { errorCode: 'delivery_unknown' })
      else updateBridgeCallState(call.callId, 'rejected', { errorCode: 'internal_error', nonDeliveryConfirmed: true })
    } else if (call.state === 'dispatching') {
      updateBridgeCallState(call.callId, 'delivery_unknown', { errorCode: 'stop_unconfirmed' })
    }
    return getBridgeCall(call.callId) ?? call
  }

  /** A receipt from the stored call, or the stored refusal. */
  private answer(call: BridgeCallRecord, replayed: boolean): BridgeResult<ReceiptOf> {
    const target = JSON.parse(call.target!) as CallTarget
    const chat = { machine_id: call.machineId ?? this.host.machineId(), chat_id: target.chat_id }
    if (call.state === 'rejected' || call.state === 'delivery_unknown') {
      const code: BridgeErrorCode =
        call.errorCode ?? (call.state === 'rejected' ? 'internal_error' : 'delivery_unknown')
      return fail(
        bridgeError(
          code,
          call.state === 'rejected'
            ? 'This call was refused or interrupted earlier. Nothing was sent; use a new key to try again.'
            : 'Delivery is unconfirmed. Read the chat before sending again.',
          {
            call_id: call.callId,
            target: chat,
            ...(call.nonDeliveryConfirmed === null ? {} : { non_delivery_confirmed: call.nonDeliveryConfirmed }),
          },
        ),
      )
    }
    const result = (call.result ? JSON.parse(call.result) : {}) as CallResult
    const base = {
      call_id: call.callId,
      observed_at: new Date(this.now()).toISOString(),
      machine_ids: [chat.machine_id],
      state: call.state,
      replayed,
      chat,
    }
    if (target.op === 'start_chat') {
      const label = this.reads.allowed(chat.machine_id).find((a) => a.policy.project_id === target.project_id)
      return {
        ok: true,
        value: {
          ...base,
          project: { project_id: target.project_id, label: label?.policy.label ?? target.label },
          message_id: echoMessageId(target.origin),
          agent: target.agent,
          model: target.model,
          mode: target.mode,
        },
      }
    }
    if (target.op === 'send_to_chat')
      return {
        ok: true,
        value: {
          ...base,
          message_id: echoMessageId(target.origin),
          delivery: { requested: target.requested, actual: result.actual ?? null },
        },
      }
    const status = result.status === 'stopping' && !this.host.busy(target.chat_id) ? 'stopped' : (result.status ?? null)
    return { ok: true, value: { ...base, status } }
  }

  /** Records the refusal on the call: nothing reached the provider. */
  private reject(callId: string, error: BridgeError): { ok: false; error: BridgeError } {
    updateBridgeCallState(callId, 'rejected', { errorCode: error.code, nonDeliveryConfirmed: true })
    return fail({ ...error, call_id: callId, non_delivery_confirmed: true })
  }

  /** Why a send must not go into this chat now, or null. */
  private chatRefusal(
    chatId: string,
    caller: BridgeCaller,
    project: AllowedProject,
    ref: BridgeChatRef,
  ): BridgeError | null {
    if (getConversationById(chatId)?.archived === 1)
      return bridgeError('chat_archived', 'That chat is archived. The owner must unarchive it.', { target: ref })
    if (this.host.isOpenChild(chatId))
      return bridgeError('child_read_only', 'That chat belongs to a hub. Message its hub chat.', { target: ref })
    const cap = narrower(project.policy.maximum_mode, caller.mode)
    if (wider(this.host.chatMode(chatId), cap))
      return bridgeError(
        'mode_not_allowed',
        `That chat runs in a wider mode than this project allows (${cap}). The owner can lower it.`,
        { target: ref },
      )
    return null
  }

  /**
   * Right before a turn goes in, after the start or resume awaited: no stop
   * came meanwhile, the bridge is still on, the project is still allowed
   * under the same root and cap, and the chat still runs inside that root.
   */
  private beforeSubmit(
    chatId: string,
    fence: number,
    project: AllowedProject,
    caller: BridgeCaller,
    ref: BridgeChatRef,
  ): BridgeError | null {
    if (this.fenced(chatId, fence)) return stoppedBeforeSend(ref)
    if (!this.host.enabled())
      return bridgeError('bridge_disabled', 'The Instinct bridge was turned off. Nothing was sent.', { target: ref })
    const current = this.reads
      .allowed(this.host.machineId())
      .find((a) => a.policy.project_id === project.policy.project_id)
    if (!current || current.policy.canonical_local_root !== project.policy.canonical_local_root)
      return bridgeError('project_not_allowed', 'That project is no longer allowed. Nothing was sent.', { target: ref })
    const cap = narrower(current.policy.maximum_mode, caller.mode)
    if (wider(this.host.chatMode(chatId), cap))
      return bridgeError('mode_not_allowed', `This project now allows modes up to ${cap}. Nothing was sent.`, {
        target: ref,
      })
    const root = getConversationExecutionRoot(chatId)
    if (!insideRoot(root?.worktreePath ?? root?.projectPath, current.policy.canonical_local_root))
      return bridgeError('project_not_allowed', 'The chat no longer runs inside the allowed project folder.', {
        target: ref,
      })
    return null
  }

  /** The normal resume path for a chat with no live session; an error when it cannot resume. */
  private async resume(
    chatId: string,
    agentType: string,
    project: AllowedProject,
    ref: BridgeChatRef,
  ): Promise<BridgeError | null> {
    const notResumable = bridgeError('chat_not_resumable', 'That chat cannot be resumed on this machine.', {
      target: ref,
    })
    if (!isAgentType(agentType)) return notResumable
    const root = getConversationExecutionRoot(chatId)
    const cwd = root?.worktreePath ?? root?.projectPath
    if (!cwd) return notResumable
    // Before the provider starts there, not only before the turn.
    if (!insideRoot(cwd, project.policy.canonical_local_root))
      return bridgeError('project_not_allowed', 'The chat no longer runs inside the allowed project folder.', {
        target: ref,
      })
    const handoff = getConversationForkMetadata(chatId)?.resumeMode === 'transcript-handoff'
    try {
      await this.host.startSession({
        threadId: chatId,
        provider: providerKindFor(agentType),
        cwd,
        ...(handoff ? {} : { resumeSessionId: chatId }),
      })
      return null
    } catch (err) {
      log.warn('bridge send: the chat did not resume', { chatId, err: String(err) })
      return notResumable
    }
  }

  private async deliver(
    callId: string,
    turn: UserTurnSubmissionV1,
    result: CallResult = {},
  ): Promise<{ ok: true } | { ok: false; error: BridgeError }> {
    const ref = { machine_id: this.host.machineId(), chat_id: resolveRootThreadId(turn.threadId) }
    // The planned delivery is stored first, so a replay after a crash still reports it.
    updateBridgeCallState(callId, 'dispatching', { result })
    let outcome: UserTurnSubmissionResult
    try {
      outcome = await this.host.submitTurn(turn)
    } catch (err) {
      log.warn('bridge turn submission threw', { callId, err: String(err) })
      outcome = { status: 'ambiguous', accepted: false, duplicate: false, state: 'ambiguous', reason: String(err) }
    }
    if (outcome.status === 'accepted') {
      // The registry can still queue it (a turn began meanwhile, or a steer could not land): report that.
      const queued =
        result.actual !== undefined &&
        this.host.queuedTurns(turn.threadId).some((q) => q.messageId === echoMessageId(turn.origin))
      updateBridgeCallState(callId, 'accepted', { result: queued ? { ...result, actual: 'queue' } : result })
      return { ok: true }
    }
    if (outcome.status === 'pending' || outcome.status === 'ambiguous') {
      updateBridgeCallState(callId, 'delivery_unknown', { errorCode: 'delivery_unknown' })
      return fail(
        bridgeError('delivery_unknown', 'The agent may have the message. Read the chat before sending again.', {
          call_id: callId,
          target: ref,
        }),
      )
    }
    // The reason stays in the log: an adapter error can name a local path.
    log.warn('bridge turn not accepted', { callId, reason: outcome.reason })
    const code: BridgeErrorCode =
      outcome.status === 'rejected' && outcome.code === 'child_read_only' ? 'child_read_only' : 'policy_denied'
    return this.reject(
      callId,
      bridgeError(code, 'The chat did not take the message. Nothing was sent; try again with a new key.', {
        target: ref,
      }),
    )
  }

  /**
   * The chat's own stop: its queued bridge messages are taken back (the
   * owner's own queued messages stay, held as after any Stop), then the
   * user's Stop runs until the chat has no turn left. An adapter ignores a
   * Stop that comes before its provider took the turn, so the Stop is sent
   * again until the turn ends; a turn still running at the deadline throws,
   * and the caller answers `stop_unconfirmed`.
   */
  private async halt(chatId: string): Promise<'stopped'> {
    const deadline = this.now() + this.timing.stopConfirmMs
    for (;;) {
      // Every round: a bridge message can be queued while the stop runs.
      await this.cancelBridgeQueued(chatId)
      const thread = this.host.liveThread(chatId)
      if (thread || this.host.starting(chatId)) await this.host.interrupt(thread ?? chatId)
      if (!this.host.running(chatId) && !this.host.starting(chatId)) {
        await this.cancelBridgeQueued(chatId)
        if (this.bridgeQueued(chatId).length > 0) throw new Error('a queued bridge message could not be taken back')
        return 'stopped'
      }
      if (this.now() >= deadline) throw new Error('the turn was still running at the stop deadline')
      await new Promise((resolve) => setTimeout(resolve, this.timing.stopPollMs))
    }
  }

  private bridgeQueued(chatId: string): QueuedTurnSummary[] {
    const live = this.host.liveThread(chatId)
    return live ? this.host.queuedTurns(live).filter((q) => q.messageId.startsWith(QUEUED_BRIDGE_PREFIX)) : []
  }

  private async cancelBridgeQueued(chatId: string): Promise<void> {
    const live = this.host.liveThread(chatId)
    for (const queued of this.bridgeQueued(chatId)) {
      const cancelled = await this.host.cancelQueuedTurn(live!, queued.messageId)
      if (!cancelled.ok) log.warn('queued bridge message not cancelled', { chatId, reason: cancelled.reason })
    }
  }

  /** A stop came while the turn was being accepted: the turn went in, so stop it again. */
  private async haltIfStopped(chatId: string, fence: number): Promise<void> {
    if (!this.fenced(chatId, fence)) return
    try {
      await this.halt(chatId)
    } catch (err) {
      log.warn('bridge stop after a late acceptance failed', { chatId, err: String(err) })
    }
  }

  private fence(chatId: string): number {
    return this.stops.get(chatId) ?? 0
  }

  private fenced(chatId: string, fence: number): boolean {
    return this.fence(chatId) !== fence
  }

  /** The first trial runs one bridge origin group per machine: a start in flight or a busy bridge chat. */
  private activeBridgeChat(machineId: string): string | null {
    const starting = this.startsInFlight.values().next()
    if (!starting.done) return starting.value
    const busy = listBridgeOrigins(machineId).find(
      (o) => this.host.busy(o.conversationId) || this.host.starting(o.conversationId),
    )
    return busy?.conversationId ?? null
  }
}

function planDenied(): BridgeError {
  return bridgeError('policy_denied', 'This chat is in plan mode, so it cannot start or message chats.')
}

function stoppedBeforeSend(ref: BridgeChatRef): BridgeError {
  return bridgeError('policy_denied', 'stop_chat stopped this chat before the message went out. Nothing was sent.', {
    target: ref,
  })
}
