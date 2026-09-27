/**
 * One MCP client connection, speaking the protocol's JSON-RPC subset a tool
 * server needs: `initialize`, `ping`, `tools/list`, `tools/call` and
 * `notifications/cancelled`. Transport-free: the socket server feeds it parsed
 * messages and hands it a `send`.
 *
 * Hand-rolled because `@modelcontextprotocol/sdk` is only a transitive
 * dependency here, and five methods do not justify declaring one.
 */
import { createMainLogger } from '../logger'

const log = createMainLogger('mcp:session')

/** Newest first. A client asking for one of these gets it echoed back. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface McpToolAnnotations {
  title?: string
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolCallContext {
  /** Aborted when the client cancels the call or the connection closes. */
  signal: AbortSignal
}

export interface McpTool {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
  annotations: McpToolAnnotations
  call(args: Record<string, unknown>, ctx: McpToolCallContext): Promise<McpToolResult>
}

export function toolText(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

type JsonRpcId = string | number

interface JsonRpcMessage {
  jsonrpc?: string
  id?: JsonRpcId | null
  method?: string
  params?: unknown
}

export interface McpSessionOptions {
  serverName: string
  serverVersion: string
  instructions?: string
  tools: readonly McpTool[]
  send(message: unknown): void
}

export class McpSession {
  private readonly inflight = new Map<JsonRpcId, AbortController>()
  private closed = false

  constructor(private readonly opts: McpSessionOptions) {}

  handle(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      this.error(null, -32600, 'Invalid request')
      return
    }
    const msg = raw as JsonRpcMessage
    // A response to something we never send; nothing to do.
    if (typeof msg.method !== 'string') return
    const isRequest = msg.id !== undefined && msg.id !== null
    if (!isRequest) {
      this.notification(msg.method, msg.params)
      return
    }
    void this.request(msg.id as JsonRpcId, msg.method, msg.params)
  }

  /** The connection went away: abort every call still waiting (an open approval card closes). */
  close(): void {
    this.closed = true
    for (const controller of this.inflight.values()) controller.abort()
    this.inflight.clear()
  }

  private notification(method: string, params: unknown): void {
    if (method === 'notifications/cancelled') {
      const requestId = (params as { requestId?: JsonRpcId } | undefined)?.requestId
      if (requestId === undefined) return
      const controller = this.inflight.get(requestId)
      if (controller) {
        log.info(`client cancelled tool call ${String(requestId)}`)
        controller.abort()
      }
    }
    // notifications/initialized and anything else carry nothing we act on.
  }

  private async request(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    switch (method) {
      case 'initialize': {
        const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion
        const protocolVersion = MCP_PROTOCOL_VERSIONS.find((v) => v === asked) ?? MCP_PROTOCOL_VERSIONS[0]
        this.result(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.opts.serverName, version: this.opts.serverVersion },
          ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
        })
        return
      }
      case 'ping':
        this.result(id, {})
        return
      case 'tools/list':
        this.result(id, {
          tools: this.opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          })),
        })
        return
      case 'tools/call':
        await this.callTool(id, params)
        return
      default:
        this.error(id, -32601, `Method not found: ${method}`)
    }
  }

  private async callTool(id: JsonRpcId, params: unknown): Promise<void> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown }
    const tool = this.opts.tools.find((t) => t.name === p.name)
    if (!tool) {
      this.error(id, -32602, `Unknown tool: ${String(p.name)}`)
      return
    }
    const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments)
      ? p.arguments as Record<string, unknown>
      : {}
    const controller = new AbortController()
    this.inflight.set(id, controller)
    let result: McpToolResult
    try {
      result = await tool.call(args, { signal: controller.signal })
    } catch (err) {
      // Tools report refusals as results. A throw is a bug, and the model
      // still gets words it can act on rather than a transport error.
      log.error(`tool ${tool.name} threw`, err)
      result = toolText(`Switchboard could not run ${tool.name}: ${err instanceof Error ? err.message : String(err)}`, true)
    } finally {
      this.inflight.delete(id)
    }
    // A cancelled request gets no response, per the protocol.
    if (controller.signal.aborted) return
    this.result(id, result)
  }

  private result(id: JsonRpcId, result: unknown): void {
    if (this.closed) return
    this.opts.send({ jsonrpc: '2.0', id, result })
  }

  private error(id: JsonRpcId | null, code: number, message: string): void {
    if (this.closed) return
    this.opts.send({ jsonrpc: '2.0', id, error: { code, message } })
  }
}
