/**
 * `withdraw_approval`: the agent takes back a card it opened. A card no longer
 * holds the tool call, so the agent moves on while it waits; when it changes
 * its mind (it found a better reply, the check passed on its own), this closes
 * the card so the user is not asked about something the agent no longer wants.
 * Only a card of the calling chat, and never one the user already answered.
 */
import type { AgentApprovalBroker } from './agent-approvals'
import { toolText, type McpTool } from './mcp-session'

export const WITHDRAW_APPROVAL_TOOL = 'withdraw_approval'

export interface ApprovalMcpToolContext {
  /** The root conversation id. */
  chatId: string
  approvals: Pick<AgentApprovalBroker, 'withdraw'>
}

export function buildApprovalMcpTools(ctx: ApprovalMcpToolContext): McpTool[] {
  return [
    {
      name: WITHDRAW_APPROVAL_TOOL,
      description: [
        'Withdraw an approval card you opened that the user has not answered yet, so they are not asked about it.',
        'Pass the card id from the "Queued for the user\'s approval (card ...)" answer. Nothing is posted or sent,',
        'and no result message follows. A card the user already answered cannot be withdrawn.',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          card: { type: 'string', description: 'The card id, for example "sbmcp_1727712000000_ab12cd34".' },
        },
        required: ['card'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Withdraw an approval card',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      async call(args) {
        const id = typeof args.card === 'string' ? args.card.trim() : ''
        if (!id) return toolText('No card given. Pass the card id the queued answer named.', true)
        const done = ctx.approvals.withdraw(ctx.chatId, id)
        if (!done.ok)
          return toolText(
            `${done.message} It may already be answered; its result comes as a message in this chat.`,
            true,
          )
        return toolText(`Withdrew card ${id}. Nothing was posted or sent.`)
      },
    },
  ]
}
