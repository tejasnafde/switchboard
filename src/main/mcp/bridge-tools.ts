/**
 * The Instinct bridge read tools on the Switchboard MCP server (flag
 * `instinct_bridge`): list_projects, list_recent_chats, search_chats and
 * read_chat, for local agents. The registry lists them only while the flag is
 * on, and each call checks it again, so turning it off refuses at once.
 *
 * The calling chat comes from the MCP token, never from an argument. These
 * are reads with no card in any mode; the service limits every answer to the
 * projects the owner allowed in Settings > Labs.
 */
import { bridgeError, type BridgeError } from '@shared/bridge'
import { createMainLogger } from '../logger'
import {
  BRIDGE_LIST_MAX_LIMIT,
  parseBridgeLimit,
  type BridgeReadService,
  type BridgeResult,
} from '../bridge/read-service'
import { toolText, type McpTool, type McpToolResult } from './mcp-session'

const log = createMainLogger('mcp:bridge')

export const BRIDGE_READ_TOOL_NAMES = ['list_projects', 'list_recent_chats', 'search_chats', 'read_chat'] as const

export interface BridgeToolDeps {
  /** The calling chat's root id, for the log line. */
  chatId: () => string
  service: BridgeReadService
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

export function buildBridgeReadTools(deps: BridgeToolDeps): McpTool[] {
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
      log.warn('bridge read failed', { tool: name, chat: deps.chatId(), err: String(err) })
      return toolText(`${name} failed: ${err instanceof Error ? err.message : String(err)}`, true)
    }
  }
  const limitOf = (args: Record<string, unknown>): number => parseBridgeLimit(args.limit)!
  const annotations = (title: string) => ({ title, readOnlyHint: true, openWorldHint: false })

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
        'only changes, or unchanged: true.',
      inputSchema: {
        type: 'object',
        properties: {
          chat: {
            description: 'A {machine_id, chat_id} reference, a chat id or a title.',
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: { machine_id: { type: 'string' }, chat_id: { type: 'string' } },
                required: ['chat_id'],
              },
            ],
          },
          since: { type: 'string', description: 'The cursor from an earlier read_chat.' },
        },
        required: ['chat'],
        additionalProperties: false,
      },
      annotations: annotations('Read a bridge chat'),
      call: (args) => run('read_chat', args, async () => answer(await deps.service.readChat(args as never))),
    },
  ]
}
