/**
 * Exposes the cross-session peer tools to a Claude session as an in-process
 * MCP server.
 *
 * Binding only: the names, descriptions and behaviour live in
 * `provider/peer-tools.ts`, which knows nothing about this SDK. `tool` and
 * `createSdkMcpServer` are passed in rather than imported, because the adapter
 * imports the SDK dynamically (it is optional at runtime) and this module must
 * not pull it in at load time.
 */

import { z } from 'zod'
import {
  createPeerToolHandlers,
  PEER_LIST_TOOL_DESCRIPTION,
  PEER_LIST_TOOL_NAME,
  PEER_SEND_TOOL_DESCRIPTION,
  PEER_SEND_TOOL_NAME,
  PEER_TOOL_SERVER_NAME,
  type PeerToolHost,
} from '../peer-tools'

type SdkSurface = Pick<typeof import('@anthropic-ai/claude-agent-sdk'), 'tool' | 'createSdkMcpServer'>

export function buildPeerToolServer(
  sdk: SdkSurface,
  host: PeerToolHost,
  fromThreadId: string,
): ReturnType<SdkSurface['createSdkMcpServer']> {
  const handlers = createPeerToolHandlers(host, fromThreadId)
  return sdk.createSdkMcpServer({
    name: PEER_TOOL_SERVER_NAME,
    tools: [
      sdk.tool(PEER_LIST_TOOL_NAME, PEER_LIST_TOOL_DESCRIPTION, {}, () => handlers.listSessions()),
      sdk.tool(
        PEER_SEND_TOOL_NAME,
        PEER_SEND_TOOL_DESCRIPTION,
        {
          sessionId: z
            .string()
            .describe(`Opaque id of the receiving session, exactly as ${PEER_LIST_TOOL_NAME} reported it.`),
          message: z
            .string()
            .describe(
              'The whole message. It has to stand on its own: the peer cannot see your transcript, '
              + 'so name the files, commands and findings it needs.',
            ),
        },
        (args) => handlers.sendMessage(args),
      ),
    ],
  })
}
