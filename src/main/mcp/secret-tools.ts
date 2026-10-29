/**
 * `request_secret` on the Switchboard MCP server, only while the
 * `agent_secret_request` flag is on. The agent asks, the chat shows a card,
 * and the tool returns at once: the answer comes later as a result turn
 * (`ProviderRegistry.reportAgentCard`), with the file path and never the value.
 * Rules and texts in `shared/agent-secret-request.ts`.
 */
import type { RuntimeMode } from '@shared/provider-events'
import {
  REQUEST_SECRET_TOOL,
  SECRET_OPEN_CARD_CAP,
  SECRET_PLAN_MODE_REFUSAL,
  SECRET_RATE_LIMIT,
  SECRET_RATE_WINDOW_MS,
  SECRET_TTLS,
  checkSecretRequestArgs,
  secretQueuedText,
} from '@shared/agent-secret-request'
import type { AgentApprovalBroker } from './agent-approvals'
import { toolText, type McpTool } from './mcp-session'

export const SECRET_INSTRUCTIONS = [
  `When a command needs a secret (an API key, an auth key, a token), call ${REQUEST_SECRET_TOOL}.`,
  'Never ask the user to paste a secret in chat.',
].join(' ')

/** Requests per chat in the last 10 minutes. Counted when a card opens. */
export class SecretRequestLimiter {
  private readonly times = new Map<string, number[]>()

  constructor(private readonly now: () => number = Date.now) {}

  allow(chatId: string): boolean {
    const since = this.now() - SECRET_RATE_WINDOW_MS
    const recent = (this.times.get(chatId) ?? []).filter((t) => t > since)
    this.times.set(chatId, recent)
    return recent.length < SECRET_RATE_LIMIT
  }

  record(chatId: string): void {
    this.times.set(chatId, [...(this.times.get(chatId) ?? []), this.now()])
  }
}

export interface SecretToolContext {
  threadId: string
  /** The root conversation id. */
  chatId: string
  runtimeMode(): RuntimeMode
  /** An open child chat (`hub_children`) is not where the user is looking. */
  isOpenChild(): boolean
  /** The root chat is archived. An archived chat cannot take a secret. */
  archived(): boolean
  approvals: Pick<AgentApprovalBroker, 'open' | 'openSecretCards'>
  limiter: SecretRequestLimiter
}

export function buildSecretMcpTools(ctx: SecretToolContext): McpTool[] {
  return [
    {
      name: REQUEST_SECRET_TOOL,
      description: [
        'Ask the user for a secret (an API key, an auth key, a token) that a command needs.',
        'The user types it in a card in this chat. Switchboard writes it to a private file for this chat only;',
        'you get the file path and the env var SWITCHBOARD_SECRETS_DIR, never the value.',
        'Returns at once. The answer comes later as a message from Switchboard. Not available in plan mode.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The file name, ^[A-Z][A-Z0-9_]{1,63}$, for example "TAILSCALE_AUTHKEY".',
          },
          title: { type: 'string', description: 'One line, at most 80 characters, for example "Tailscale auth key".' },
          instructions: {
            type: 'string',
            description: 'Plain text, at most 1500 characters: where the user gets the value.',
          },
          ttl: {
            type: 'string',
            enum: [...SECRET_TTLS],
            description: 'How long the file stays. Default "24h", the most you can ask for.',
          },
        },
        required: ['name', 'title', 'instructions'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Ask the user for a secret',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      async call(args) {
        if (ctx.runtimeMode() === 'plan') return toolText(SECRET_PLAN_MODE_REFUSAL, true)
        if (ctx.archived()) return toolText('This chat is archived. It cannot ask for a secret.', true)
        if (ctx.isOpenChild())
          return toolText('A child chat cannot ask for a secret. Report to the parent chat that you need one.', true)
        const checked = checkSecretRequestArgs(args)
        if (!checked.ok) return toolText(checked.message, true)
        if (ctx.approvals.openSecretCards(ctx.chatId) >= SECRET_OPEN_CARD_CAP)
          return toolText(
            `This chat already has ${SECRET_OPEN_CARD_CAP} open secret requests. Wait for the user to answer one.`,
            true,
          )
        if (!ctx.limiter.allow(ctx.chatId))
          return toolText(
            `This chat asked for ${SECRET_RATE_LIMIT} secrets in the last 10 minutes. Wait before you ask again.`,
            true,
          )
        const opened = ctx.approvals.open({
          threadId: ctx.threadId,
          chatId: ctx.chatId,
          toolName: REQUEST_SECRET_TOOL,
          detail: '',
          plan: { kind: 'secret-request', card: checked.card },
        })
        if (!opened.ok) return toolText(opened.message, true)
        ctx.limiter.record(ctx.chatId)
        return toolText(secretQueuedText(checked.card.name, opened.requestId))
      },
    },
  ]
}
