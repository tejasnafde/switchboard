/**
 * The binding between the peer tools and the Claude SDK's in-process MCP server.
 *
 * Two things are worth asserting and neither is visible from the handler tests:
 * the definitions the SDK is handed (names, descriptions, argument schema),
 * and that the REAL `createSdkMcpServer` accepts them. A zod shape the SDK
 * rejects would otherwise only surface as a session that fails to start.
 */
import { describe, it, expect } from 'vitest'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { buildPeerToolServer } from '../../src/main/provider/adapters/claude-peer-tools'
import {
  PEER_LIST_TOOL_DESCRIPTION,
  PEER_LIST_TOOL_NAME,
  PEER_SEND_TOOL_DESCRIPTION,
  PEER_SEND_TOOL_NAME,
  PEER_TOOL_SERVER_NAME,
  type PeerToolHost,
} from '../../src/main/provider/peer-tools'
import type { PeerMessageInput } from '../../src/shared/peer-messaging'

function fakeHost() {
  const delivered: PeerMessageInput[] = []
  const listedFor: string[] = []
  const host: PeerToolHost = {
    listPeerSessions: (fromThreadId) => {
      listedFor.push(fromThreadId)
      return []
    },
    deliverPeerMessage: async (input) => {
      delivered.push(input)
      return { id: 'pm_0123456789abcdef' }
    },
  }
  return { host, delivered, listedFor }
}

interface CapturedTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  handler: (args: Record<string, string>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>
}

/** `sdk.tool` is a passthrough in the real SDK, so a recording stand-in is faithful. */
function capturingSdk() {
  const tools: CapturedTool[] = []
  const servers: Array<{ name: string; version?: string }> = []
  const sdk = {
    tool: (name: string, description: string, inputSchema: unknown, handler: unknown) => {
      const captured = { name, description, inputSchema, handler } as unknown as CapturedTool
      tools.push(captured)
      return captured
    },
    createSdkMcpServer: (options: { name: string; version?: string }) => {
      servers.push(options)
      return options
    },
  } as unknown as Parameters<typeof buildPeerToolServer>[0]
  return { sdk, tools, servers }
}

describe('buildPeerToolServer', () => {
  it('registers both tools under the switchboard server', () => {
    const { sdk, tools, servers } = capturingSdk()
    buildPeerToolServer(sdk, fakeHost().host, 'sender')

    expect(servers).toHaveLength(1)
    expect(servers[0].name).toBe(PEER_TOOL_SERVER_NAME)
    expect(tools.map((t) => t.name)).toEqual([PEER_LIST_TOOL_NAME, PEER_SEND_TOOL_NAME])
    expect(tools[0].description).toBe(PEER_LIST_TOOL_DESCRIPTION)
    expect(tools[1].description).toBe(PEER_SEND_TOOL_DESCRIPTION)
  })

  it('takes no arguments for the list tool and two for the send tool', () => {
    const { sdk, tools } = capturingSdk()
    buildPeerToolServer(sdk, fakeHost().host, 'sender')

    expect(Object.keys(tools[0].inputSchema)).toEqual([])
    expect(Object.keys(tools[1].inputSchema)).toEqual(['sessionId', 'message'])
  })

  it('binds the handlers to the sending thread', async () => {
    const { sdk, tools } = capturingSdk()
    const { host, delivered, listedFor } = fakeHost()
    buildPeerToolServer(sdk, host, 'sender')

    await tools[0].handler({})
    expect(listedFor).toEqual(['sender'])

    await tools[1].handler({ sessionId: 'target', message: 'the migration landed' })
    expect(delivered).toEqual([{
      fromThreadId: 'sender',
      targetThreadId: 'target',
      text: 'the migration landed',
      initiator: 'agent',
    }])
  })

  // Registration is where a bad schema fails, and it fails at session start,
  // which is far from anything that would explain it.
  it('is accepted by the real SDK', () => {
    const server = buildPeerToolServer({ tool, createSdkMcpServer }, fakeHost().host, 'sender')
    expect(server.name).toBe(PEER_TOOL_SERVER_NAME)
    expect(server.instance).toBeDefined()
  })
})
