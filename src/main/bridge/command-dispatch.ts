/**
 * Runs a `command` frame the relay sent this desktop and answers it.
 *
 * The relay resolved the machine, the project and the chat, reserved the call
 * and sent one frame; this module checks the frame's shape, runs the named
 * tool through the same typed services the local MCP tools use
 * (`read-service.ts` for the four reads, `delivery-service.ts` for the three
 * mutations) and returns the body of the `result` frame. It starts no chat of
 * its own and holds no provider state.
 *
 * The caller is the OWNER, not an agent on this Mac: it has no calling chat,
 * so it never passes through the agent peer gate and takes none of a local
 * agent's chat-scoped privileges. What it may do is the project policy alone.
 * Its idempotency key is the relay's call id, so a frame that arrives twice,
 * before or after a restart of this desktop, answers from the stored record
 * and sends nothing again.
 *
 * Everything is behind `instinct_bridge`: with the flag off a command is
 * refused with `bridge_disabled`. The flag, the policy, the execution root
 * and the kill are read again inside the service right before each mutation,
 * not once here.
 */
import {
  BRIDGE_OPERATIONS,
  BRIDGE_TOOL_NAMES,
  BRIDGE_WIRE_VERSION,
  bridgeError,
  type BridgeError,
  type BridgeErrorCode,
  type BridgeOperation,
  type BridgeToolName,
} from '@shared/bridge'
import { createMainLogger } from '../logger'
import { BRIDGE_MESSAGE_MAX_CHARS, type BridgeCaller, type BridgeDeliveryService } from './delivery-service'
import { parseBridgeLimit, type BridgeReadService, type BridgeResult } from './read-service'

const log = createMainLogger('bridge:command')

/** A call id longer than this is not one the relay made. */
const CALL_ID_MAX_CHARS = 200

const TOOL_NAMES: ReadonlySet<string> = new Set(BRIDGE_TOOL_NAMES)
const MUTATIONS: ReadonlySet<string> = new Set(BRIDGE_OPERATIONS)

/**
 * Codes whose non-delivery this desktop cannot prove: the provider may hold
 * the turn, or the step threw where it could have been taken. Every other
 * structured refusal happens before or instead of a submit, so its
 * non-delivery is confirmed unless the error itself says otherwise.
 */
const UNPROVEN: ReadonlySet<BridgeErrorCode> = new Set(['delivery_unknown', 'stop_unconfirmed', 'internal_error'])

/** The `error` of a result frame: the structured error plus the two booleans the relay passes through. */
export interface BridgeWireError extends BridgeError {
  delivered: boolean
  non_delivery_confirmed: boolean
}

/** What the relay client puts in the `result` frame it sends back. */
export interface BridgeCommandAnswer {
  callId: string
  ok: boolean
  result?: unknown
  error?: BridgeWireError
}

export interface BridgeCommand {
  call_id: string
  tool: BridgeToolName
  arguments: Record<string, unknown>
  /** The relay's stop generation when it resolved the call. */
  stop_generation: number
}

export type BridgeCommandParse =
  | { ok: true; command: BridgeCommand }
  /** `callId` null: there is nothing to answer, so the frame is dropped. */
  | { ok: false; callId: string | null; code: BridgeErrorCode; message: string }

export interface BridgeCommandDeps {
  /** The `instinct_bridge` flag, read on every frame. */
  enabled(): boolean
  reads: BridgeReadService
  delivery: BridgeDeliveryService
  /** This desktop's durable stop generation (PR 6). */
  stopGeneration(): number
  /** PR 6's control path for a generation this desktop has not seen; the kill is left as it stands. */
  applyStopGeneration(generation: number): Promise<void>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wireError(error: BridgeError, delivered: boolean): BridgeWireError {
  return {
    ...error,
    delivered,
    non_delivery_confirmed: error.non_delivery_confirmed ?? (delivered ? false : !UNPROVEN.has(error.code)),
  }
}

/** The frame's own shape. The relay already resolved the target and clamped the limit. */
export function parseBridgeCommand(frame: Record<string, unknown>): BridgeCommandParse {
  const callId = typeof frame.call_id === 'string' && frame.call_id.length > 0 ? frame.call_id : null
  if (callId === null || callId.length > CALL_ID_MAX_CHARS)
    return { ok: false, callId: null, code: 'invalid_request', message: 'A command needs a call id.' }
  if (frame.wire_version !== BRIDGE_WIRE_VERSION)
    return {
      ok: false,
      callId,
      code: 'unsupported_version',
      message: `This desktop speaks bridge wire version ${BRIDGE_WIRE_VERSION}.`,
    }
  if (typeof frame.tool !== 'string' || !TOOL_NAMES.has(frame.tool))
    return { ok: false, callId, code: 'invalid_request', message: 'That is not a bridge tool.' }
  const args = frame.arguments === undefined || frame.arguments === null ? {} : frame.arguments
  if (!isPlainObject(args))
    return { ok: false, callId, code: 'invalid_request', message: 'arguments must be an object.' }
  const generation = frame.stop_generation
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0)
    return { ok: false, callId, code: 'invalid_request', message: 'stop_generation must be a whole number.' }
  return {
    ok: true,
    command: { call_id: callId, tool: frame.tool as BridgeToolName, arguments: args, stop_generation: generation },
  }
}

export class BridgeCommandDispatcher {
  constructor(private readonly deps: BridgeCommandDeps) {}

  /** Null when the frame cannot be answered at all; the relay drops an unknown call anyway. */
  async run(frame: Record<string, unknown>): Promise<BridgeCommandAnswer | null> {
    const parsed = parseBridgeCommand(frame)
    if (!parsed.ok) {
      if (parsed.callId === null) {
        log.warn('relay command dropped', { code: parsed.code })
        return null
      }
      return this.refuse(parsed.callId, bridgeError(parsed.code, parsed.message))
    }
    const { command } = parsed
    try {
      return { callId: command.call_id, ...(await this.execute(command)) }
    } catch (err) {
      // The detail stays in the log: an error message can name a local path.
      log.warn('relay command failed', { tool: command.tool, callId: command.call_id, err: String(err) })
      return {
        callId: command.call_id,
        ok: false,
        // Nothing proves what the provider took, so the non-delivery is not confirmed.
        error: wireError(
          bridgeError('internal_error', `${command.tool} failed on this desktop. The cause is in its Switchboard log.`),
          false,
        ),
      }
    }
  }

  private async execute(command: BridgeCommand): Promise<Omit<BridgeCommandAnswer, 'callId'>> {
    if (!this.deps.enabled())
      return this.deny(bridgeError('bridge_disabled', 'The Instinct bridge is off in Settings > Labs.'))
    const args = command.arguments
    if (MUTATIONS.has(command.tool)) {
      const fenced = await this.syncStopGeneration(command.stop_generation)
      if (fenced) return this.deny(fenced)
    }
    const caller: BridgeCaller = { kind: 'owner', callId: command.call_id }
    switch (command.tool) {
      case 'list_projects':
        return this.answer(this.deps.reads.listProjects())
      case 'list_recent_chats': {
        const limit = parseBridgeLimit(args.limit)
        if (limit === null) return this.deny(badLimit())
        if (args.project !== undefined && typeof args.project !== 'string')
          return this.deny(bridgeError('invalid_request', 'project must be a string.'))
        return this.answer(this.deps.reads.listRecentChats({ project: args.project, limit }))
      }
      case 'search_chats': {
        const limit = parseBridgeLimit(args.limit)
        if (limit === null) return this.deny(badLimit())
        if (typeof args.query !== 'string' || !args.query.trim())
          return this.deny(bridgeError('invalid_request', 'query is required.'))
        return this.answer(this.deps.reads.searchChats({ query: args.query, limit }))
      }
      case 'read_chat': {
        if (args.chat === undefined) return this.deny(bridgeError('invalid_request', 'chat is required.'))
        return this.answer(await this.deps.reads.readChat({ chat: args.chat, since: args.since }))
      }
      case 'start_chat': {
        const shape =
          messageError(args) ??
          (typeof args.project === 'string' && args.project.trim() ? null : 'project is required.') ??
          optionalString(args, 'agent') ??
          optionalString(args, 'model') ??
          optionalString(args, 'mode')
        if (shape) return this.deny(bridgeError('invalid_request', shape))
        return this.answer(
          await this.deps.delivery.startChat(caller, {
            project: args.project as string,
            message: args.message as string,
            agent: args.agent as string | undefined,
            model: args.model as string | undefined,
            mode: args.mode as string | undefined,
            idempotency_key: command.call_id,
          }),
        )
      }
      case 'send_to_chat': {
        const shape =
          messageError(args) ??
          (args.chat === undefined ? 'chat is required.' : null) ??
          (args.delivery === undefined || args.delivery === 'queue' || args.delivery === 'steer'
            ? null
            : 'delivery must be queue or steer.')
        if (shape) return this.deny(bridgeError('invalid_request', shape))
        return this.answer(
          await this.deps.delivery.sendToChat(caller, {
            chat: args.chat,
            message: args.message as string,
            delivery: args.delivery as 'queue' | 'steer' | undefined,
            idempotency_key: command.call_id,
          }),
        )
      }
      case 'stop_chat': {
        if (args.chat === undefined) return this.deny(bridgeError('invalid_request', 'chat is required.'))
        return this.answer(
          await this.deps.delivery.stopChat(caller, { chat: args.chat, idempotency_key: command.call_id }),
        )
      }
    }
  }

  /**
   * The relay's stop generation on a mutation. Below ours, the relay resolved
   * the call before a stop this desktop has already applied, so the call is
   * fenced and nothing is sent. Above ours, a `control` frame was missed: PR
   * 6's control path records the generation and runs that stop before any new
   * work. A command frame carries no kill, so none is set or cleared here.
   */
  private async syncStopGeneration(generation: number): Promise<BridgeError | null> {
    const known = this.deps.stopGeneration()
    if (generation < known)
      return bridgeError(
        'policy_denied',
        'A stop of bridge work came after this call was resolved. Nothing was sent.',
        {
          non_delivery_confirmed: true,
        },
      )
    if (generation > known) {
      log.info('a relay command named a newer stop generation', { generation, known })
      await this.deps.applyStopGeneration(generation)
    }
    return null
  }

  private answer<T>(result: BridgeResult<T>): Omit<BridgeCommandAnswer, 'callId'> {
    return result.ok ? { ok: true, result: result.value } : this.deny(result.error)
  }

  private deny(error: BridgeError): Omit<BridgeCommandAnswer, 'callId'> {
    return { ok: false, error: wireError(error, error.code === 'delivery_unknown') }
  }

  private refuse(callId: string, error: BridgeError): BridgeCommandAnswer {
    return { callId, ...this.deny(error) }
  }
}

function badLimit(): BridgeError {
  return bridgeError('invalid_request', 'limit must be a number the relay clamped to its range.')
}

function optionalString(args: Record<string, unknown>, name: string): string | null {
  return args[name] === undefined || typeof args[name] === 'string' ? null : `${name} must be a string.`
}

function messageError(args: Record<string, unknown>): string | null {
  if (typeof args.message !== 'string' || !args.message.trim()) return 'message is required.'
  return args.message.length > BRIDGE_MESSAGE_MAX_CHARS
    ? `message is longer than ${BRIDGE_MESSAGE_MAX_CHARS} characters.`
    : null
}
