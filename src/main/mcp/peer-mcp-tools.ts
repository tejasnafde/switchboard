/**
 * The cross-session tools (`list_agent_sessions`, `send_agent_message`) on the
 * Switchboard MCP server, for all three agents.
 *
 * Behaviour lives in `provider/peer-tools.ts`, and delivery (with the hop
 * depth and per-sender budget) in `ProviderRegistry.deliverPeerMessage`. What
 * this adds is the gate Claude's `canUseTool` used to apply, because the
 * adapters no longer prompt for our tools: plan mode denies, full access
 * sends, everything else shows the ordinary approval card first.
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
import type { AgentApprovalBroker, AgentApprovalDenyReason } from './agent-approvals'
import { toolText, type McpTool } from './mcp-session'

const PEER_DENIED: Record<AgentApprovalDenyReason, string> = {
  user: 'User denied permission',
  expired: 'The approval expired without an answer. Nothing was sent.',
  cancelled: 'The call was cancelled before the user answered. Nothing was sent.',
  stopped: 'The session stopped before the user answered. Nothing was sent.',
}

export interface PeerMcpToolContext {
  threadId: string
  runtimeMode(): RuntimeMode
  publish(event: RuntimeEvent): void
  approvals: Pick<AgentApprovalBroker, 'ask'>
  peers: PeerToolHost
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
          sessionId: { type: 'string', description: `Opaque id of the receiving session, exactly as ${PEER_LIST_TOOL_NAME} reported it.` },
          message: {
            type: 'string',
            description: 'The whole message. It has to stand on its own: the peer cannot see your transcript, '
              + 'so name the files, commands and findings it needs.',
          },
        },
        required: ['sessionId', 'message'],
        additionalProperties: false,
      },
      annotations: { title: 'Message another agent session', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      async call(args, { signal }) {
        const input = {
          sessionId: typeof args.sessionId === 'string' ? args.sessionId : '',
          message: typeof args.message === 'string' ? args.message : '',
        }
        const mode = ctx.runtimeMode()
        const policy = decidePermission(mode, PEER_SEND_TOOL)
        if (policy === 'deny') {
          const reason = denialMessage(mode, PEER_SEND_TOOL)
          ctx.publish({ type: 'tool.denied', threadId: ctx.threadId, toolName: PEER_SEND_TOOL, reason, mode })
          return toolText(reason, true)
        }
        if (policy === 'prompt') {
          const outcome = await ctx.approvals.ask({
            threadId: ctx.threadId,
            toolName: PEER_SEND_TOOL,
            detail: JSON.stringify(input, null, 2).slice(0, 500),
            signal,
          })
          if (outcome.decision === 'deny') return toolText(PEER_DENIED[outcome.reason], true)
          if (signal.aborted) return toolText(PEER_DENIED.cancelled, true)
        }
        return handlers.sendMessage(input)
      },
    },
  ]
}
