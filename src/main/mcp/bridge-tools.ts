/**
 * The Instinct bridge tools on the Switchboard MCP server (flag
 * `instinct_bridge`), for local agents: the reads list_projects,
 * list_recent_chats, search_chats and read_chat, and the mutations
 * start_chat, send_to_chat and stop_chat. The registry lists them only while
 * the flag is on, and each call checks it again, so turning it off refuses at
 * once.
 *
 * The calling chat and its mode come from the MCP token, never from an
 * argument. No tool shows a card; the services limit everything to the
 * projects the owner allowed in Settings > Labs. A mutation needs a caller
 * outside plan mode and starts or drives no chat in a mode wider than the
 * caller's own; the chat it reaches keeps its own approvals.
 */
import { bridgeError, type BridgeError } from '@shared/bridge'
import type { RuntimeMode } from '@shared/provider-events'
import { BRIDGE_MESSAGE_MAX_CHARS, type BridgeCaller, type BridgeDeliveryService } from '../bridge/delivery-service'
import { createMainLogger } from '../logger'
import {
  BRIDGE_LIST_MAX_LIMIT,
  parseBridgeLimit,
  type BridgeReadService,
  type BridgeResult,
} from '../bridge/read-service'
import { toolText, type McpTool, type McpToolResult } from './mcp-session'

const log = createMainLogger('mcp:bridge')

export interface BridgeToolDeps {
  /** The calling chat's root id. */
  chatId: () => string
  /** The calling chat's current mode, read on every call. */
  runtimeMode: () => RuntimeMode
  service: BridgeReadService
  delivery: BridgeDeliveryService
  /** Read on every call. */
  enabled: () => boolean
}

function errorResult(error: BridgeError): McpToolResult {
  return toolText(JSON.stringify(error), true)
}

function answer<T>(result: BridgeResult<T>): McpToolResult {
  return result.ok ? toolText(JSON.stringify(result.value)) : errorResult(result.error)
}

const limitSchema = {
  type: 'number',
  description: `How many rows, 1 to ${BRIDGE_LIST_MAX_LIMIT}. Default 20.`,
}

const chatSchema = {
  description: 'A {machine_id, chat_id} reference, a chat id or a title.',
  anyOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: { machine_id: { type: 'string' }, chat_id: { type: 'string' } },
      required: ['chat_id'],
    },
  ],
}

const keySchema = {
  type: 'string',
  description:
    'A new unique key per request, kept for its retries. A retry with the same key and arguments returns the first ' +
    'answer and never sends twice.',
}

function optionalString(args: Record<string, unknown>, name: string): string | null {
  return args[name] === undefined || typeof args[name] === 'string' ? null : `${name} must be a string.`
}

/** The shape checks every mutation shares: an idempotency key and, where it takes one, a message. */
function mutationShapeError(args: Record<string, unknown>, withMessage: boolean): string | null {
  if (typeof args.idempotency_key !== 'string' || !args.idempotency_key.trim()) return 'idempotency_key is required.'
  if (!withMessage) return null
  if (typeof args.message !== 'string' || !args.message.trim()) return 'message is required.'
  if (args.message.length > BRIDGE_MESSAGE_MAX_CHARS)
    return `message is longer than ${BRIDGE_MESSAGE_MAX_CHARS} characters.`
  return null
}

export function buildBridgeTools(deps: BridgeToolDeps): McpTool[] {
  const run = async (
    name: string,
    args: Record<string, unknown>,
    body: () => Promise<McpToolResult> | McpToolResult,
  ): Promise<McpToolResult> => {
    if (!deps.enabled())
      return errorResult(bridgeError('bridge_disabled', 'The Instinct bridge is off in Settings > Labs.'))
    if ('limit' in args && parseBridgeLimit(args.limit) === null)
      return toolText(`limit must be a number from 1 to ${BRIDGE_LIST_MAX_LIMIT}.`, true)
    try {
      return await body()
    } catch (err) {
      // The detail stays in the log: an error message can name a local path.
      log.warn('bridge tool failed', { tool: name, chat: deps.chatId(), err: String(err) })
      return errorResult(
        bridgeError('internal_error', `${name} failed on this desktop. The cause is in its Switchboard log.`),
      )
    }
  }
  const limitOf = (args: Record<string, unknown>): number => parseBridgeLimit(args.limit)!
  const annotations = (title: string) => ({ title, readOnlyHint: true, openWorldHint: false })
  const writeAnnotations = (title: string, destructiveHint: boolean) => ({
    title,
    readOnlyHint: false,
    destructiveHint,
    idempotentHint: true,
    openWorldHint: false,
  })
  // Every caller here is an agent on this Mac. The relay's dispatcher builds the owner's caller.
  const caller = (): BridgeCaller => ({ kind: 'local-agent', chatId: deps.chatId(), mode: deps.runtimeMode() })

  return [
    {
      name: 'list_projects',
      description:
        'The projects the owner allowed for the Instinct bridge on this desktop: id, label, machine, mode cap and agents.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: annotations('List bridge projects'),
      call: (args) => run('list_projects', args, () => answer(deps.service.listProjects())),
    },
    {
      name: 'list_recent_chats',
      description:
        'Chats in the allowed projects, newest activity first. Archived chats are left out. project is a project id ' +
        'or label from list_projects.',
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' }, limit: limitSchema },
        additionalProperties: false,
      },
      annotations: annotations('List recent bridge chats'),
      call: (args) =>
        run('list_recent_chats', args, () => {
          if (args.project !== undefined && typeof args.project !== 'string')
            return toolText('project must be a string.', true)
          return answer(deps.service.listRecentChats({ project: args.project, limit: limitOf(args) }))
        }),
    },
    {
      name: 'search_chats',
      description:
        'Word search over chat titles and stored message text in the allowed projects, one row per chat with ' +
        'matched_on title, message or both. Every word must match as a word prefix. It is not semantic: search a ' +
        'few distinctive words. Add the word archived to include archived chats.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: limitSchema },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: annotations('Search bridge chats'),
      call: (args) =>
        run('search_chats', args, () => {
          if (typeof args.query !== 'string' || !args.query.trim()) return toolText('query is required.', true)
          return answer(deps.service.searchChats({ query: args.query, limit: limitOf(args) }))
        }),
    },
    {
      name: 'read_chat',
      description:
        "A chat's status, latest agent reply, pending questions and approvals, and recent messages. chat is a chat " +
        'reference {machine_id, chat_id}, a chat id or a title. Pass the cursor from the last read as since to get ' +
        'only changes, or unchanged: true. An answer always fits one message, so a long reply and long lists are ' +
        'cut: truncated says something was cut, omitted counts what each list left out, and agent_reply carries ' +
        'length (the whole reply in characters), offset, truncated and next_offset. A cut reply shows its head and ' +
        'its tail with a "[... N characters cut ...]" marker between them; read the rest in order by calling ' +
        'read_chat again with reply_offset set to next_offset, until next_offset is null. A reply_offset read ' +
        'returns that part of the reply and no history.',
      inputSchema: {
        type: 'object',
        properties: {
          chat: chatSchema,
          since: { type: 'string', description: 'The cursor from an earlier read_chat.' },
          reply_offset: {
            type: 'number',
            description: 'Read the latest reply from this character offset on. Use next_offset from the last read.',
          },
        },
        required: ['chat'],
        additionalProperties: false,
      },
      annotations: annotations('Read a bridge chat'),
      call: (args) =>
        run('read_chat', args, async () =>
          answer(await deps.service.readChat({ chat: args.chat, since: args.since, reply_offset: args.reply_offset })),
        ),
    },
    {
      name: 'start_chat',
      description:
        'Start a new chat in an allowed project and send it the first message as the owner. project is a project id ' +
        'or label from list_projects. agent, model and mode are optional: the project defaults apply, and a mode ' +
        'wider than the project allows is refused. Accepted means the message went in, not that the work is done; ' +
        'follow it with read_chat.',
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          message: { type: 'string' },
          agent: { type: 'string' },
          model: { type: 'string' },
          mode: { type: 'string' },
          idempotency_key: keySchema,
        },
        required: ['project', 'message', 'idempotency_key'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('Start a bridge chat', false),
      call: (args) =>
        run('start_chat', args, async () => {
          const shape =
            mutationShapeError(args, true) ??
            (typeof args.project !== 'string' || !args.project.trim() ? 'project is required.' : null) ??
            optionalString(args, 'agent') ??
            optionalString(args, 'model') ??
            optionalString(args, 'mode')
          if (shape) return toolText(shape, true)
          return answer(
            await deps.delivery.startChat(caller(), {
              project: args.project as string,
              message: args.message as string,
              agent: args.agent as string | undefined,
              model: args.model as string | undefined,
              mode: args.mode as string | undefined,
              idempotency_key: args.idempotency_key as string,
            }),
          )
        }),
    },
    {
      name: 'send_to_chat',
      description:
        'Send a message to a chat in an allowed project as the owner. A dormant chat is resumed first. delivery ' +
        'queue (the default) waits for a running turn to end; steer joins the running turn where the agent can, ' +
        'else it queues. The answer names the requested and the actual delivery. It cannot answer an approval or ' +
        'a question.',
      inputSchema: {
        type: 'object',
        properties: {
          chat: chatSchema,
          message: { type: 'string' },
          delivery: { type: 'string', enum: ['queue', 'steer'] },
          idempotency_key: keySchema,
        },
        required: ['chat', 'message', 'idempotency_key'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('Send to a bridge chat', false),
      call: (args) =>
        run('send_to_chat', args, async () => {
          const shape =
            mutationShapeError(args, true) ??
            (args.delivery === undefined || args.delivery === 'queue' || args.delivery === 'steer'
              ? null
              : 'delivery must be queue or steer.')
          if (shape) return toolText(shape, true)
          return answer(
            await deps.delivery.sendToChat(caller(), {
              chat: args.chat,
              message: args.message as string,
              delivery: args.delivery as 'queue' | 'steer' | undefined,
              idempotency_key: args.idempotency_key as string,
            }),
          )
        }),
    },
    {
      name: 'stop_chat',
      description:
        "Stop a chat's running turn, as the Stop button does, and take back the messages the bridge queued there. " +
        'It does not archive, reset or undo anything.',
      inputSchema: {
        type: 'object',
        properties: { chat: chatSchema, idempotency_key: keySchema },
        required: ['chat', 'idempotency_key'],
        additionalProperties: false,
      },
      annotations: writeAnnotations('Stop a bridge chat', true),
      call: (args) =>
        run('stop_chat', args, async () => {
          const shape = mutationShapeError(args, false)
          if (shape) return toolText(shape, true)
          return answer(
            await deps.delivery.stopChat(caller(), {
              chat: args.chat,
              idempotency_key: args.idempotency_key as string,
            }),
          )
        }),
    },
  ]
}
