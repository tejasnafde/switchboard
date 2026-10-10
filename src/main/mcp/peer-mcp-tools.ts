/**
 * The cross-session tools (`list_agent_sessions`, `send_agent_message`) on the
 * Switchboard MCP server, for all three agents.
 *
 * Behaviour lives in `provider/peer-tools.ts`, and delivery (with the hop
 * depth and per-sender budget) in `ProviderRegistry.deliverPeerMessage`. What
 * this adds is the gate Claude's `canUseTool` used to apply, because the
 * adapters no longer prompt for our tools: plan mode denies, full access
 * sends, everything else shows the ordinary approval card first.
 *
 * One exception, for a send along a session link in auto mode: no card. The
 * link is the user's consent to that conversation, and auto is the mode in
 * which they chose to let the agent settle routine calls itself, so a card per
 * message would defeat the link they just made. Sandbox and accept-edits keep
 * the card even when linked: in those modes the user reviews every outward
 * action, and a peer message is one (its text can steer the other agent).
 *
 * The card does not hold the turn: the tool says the message is queued for
 * the user and returns, and the approval sends it later (`runPeerSendPlan`),
 * with plan mode and every delivery guard checked then.
 */
import type { RuntimeEvent, RuntimeMode } from '@shared/provider-events'
import { decidePermission, denialMessage } from '../provider/policy'
import {
  createPeerToolHandlers,
  PEER_LIST_TOOL_DESCRIPTION,
  PEER_LIST_TOOL_NAME,
  PEER_SEND_TOOL,
  PEER_SEND_TOOL_DESCRIPTION,
  PEER_SEND_TOOL_NAME,
  type PeerToolHost,
} from '../provider/peer-tools'
import { queuedToolText } from '@shared/agent-approval-cards'
import type { AgentApprovalBroker } from './agent-approvals'
import { toolText, type McpTool, type McpToolResult } from './mcp-session'

/** A peer send as its approval card stores it. */
export interface PeerSendPlan {
  kind: 'peer-send'
  sessionId: string
  message: string
}

export interface PeerMcpToolContext {
  threadId: string
  /** The root conversation id. */
  chatId: string
  runtimeMode(): RuntimeMode
  publish(event: RuntimeEvent): void
  approvals: Pick<AgentApprovalBroker, 'open'>
  peers: PeerToolHost
}

/** What sending an approved peer message needs. `threadId` is the id the sender runs under now. */
export type PeerSendRunContext = Pick<PeerMcpToolContext, 'threadId' | 'runtimeMode' | 'publish' | 'peers'>

/** Send a message the user approved. Plan mode may have been switched on while the card was open. */
export async function runPeerSendPlan(ctx: PeerSendRunContext, plan: PeerSendPlan): Promise<McpToolResult> {
  const now = ctx.runtimeMode()
  if (decidePermission(now, PEER_SEND_TOOL) === 'deny') {
    const reason = denialMessage(now, PEER_SEND_TOOL)
    ctx.publish({ type: 'tool.denied', threadId: ctx.threadId, toolName: PEER_SEND_TOOL, reason, mode: now })
    return toolText(`${reason} Nothing was sent.`, true)
  }
  return createPeerToolHandlers(ctx.peers, ctx.threadId).sendMessage({
    sessionId: plan.sessionId,
    message: plan.message,
  })
}

export function buildPeerMcpTools(ctx: PeerMcpToolContext): McpTool[] {
  const handlers = createPeerToolHandlers(ctx.peers, ctx.threadId)
  return [
    {
      name: PEER_LIST_TOOL_NAME,
      description: PEER_LIST_TOOL_DESCRIPTION,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      // Reads only the titles the sidebar already shows. Prompting for it
      // trains the user to click through the send that follows.
      annotations: { title: 'List agent sessions', readOnlyHint: true, openWorldHint: false },
      call: () => handlers.listSessions(),
    },
    {
      name: PEER_SEND_TOOL_NAME,
      description: PEER_SEND_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: `Opaque id of the receiving session, exactly as ${PEER_LIST_TOOL_NAME} reported it.`,
          },
          message: {
            type: 'string',
            description:
              'The whole message. It has to stand on its own: the peer cannot see your transcript, ' +
              'so name the files, commands and findings it needs.',
          },
        },
        required: ['sessionId', 'message'],
        additionalProperties: false,
      },
      annotations: {
        title: 'Message another agent session',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
      async call(args) {
        const input = {
          sessionId: typeof args.sessionId === 'string' ? args.sessionId : '',
          message: typeof args.message === 'string' ? args.message : '',
        }
        const mode = ctx.runtimeMode()
        const decided = decidePermission(mode, PEER_SEND_TOOL)
        const linkInsteadOfCard =
          decided === 'prompt' && mode === 'auto' && ctx.peers.isLinkedPeer(ctx.threadId, input.sessionId.trim())
        const policy = linkInsteadOfCard ? 'allow' : decided
        if (policy === 'deny') {
          const reason = denialMessage(mode, PEER_SEND_TOOL)
          ctx.publish({ type: 'tool.denied', threadId: ctx.threadId, toolName: PEER_SEND_TOOL, reason, mode })
          return toolText(reason, true)
        }
        // An empty id or message is refused before it costs the user a card.
        if (policy === 'prompt' && input.sessionId.trim() && input.message.trim()) {
          const opened = ctx.approvals.open({
            threadId: ctx.threadId,
            chatId: ctx.chatId,
            toolName: PEER_SEND_TOOL,
            detail: JSON.stringify(input, null, 2).slice(0, 500),
            plan: { kind: 'peer-send', sessionId: input.sessionId, message: input.message },
          })
          return opened.ok ? toolText(queuedToolText(opened.requestId)) : toolText(opened.message, true)
        }
        return handlers.sendMessage(linkInsteadOfCard ? { ...input, requireLink: true } : input)
      },
    },
  ]
}
