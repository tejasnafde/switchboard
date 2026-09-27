import { describe, expect, it, vi } from 'vitest'
import { McpSession, toolText, type McpTool } from '../../src/main/mcp/mcp-session'
import { McpTokens } from '../../src/main/mcp/mcp-tokens'

function session(tools: McpTool[]) {
  const sent: Array<Record<string, unknown>> = []
  const s = new McpSession({ serverName: 'switchboard', serverVersion: '1.0.0', tools, send: (m) => sent.push(m as Record<string, unknown>) })
  return { s, sent }
}

const echo: McpTool = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { readOnlyHint: true },
  call: async (args) => toolText(String(args.text)),
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('McpSession', () => {
  it('echoes a protocol version it knows and falls back to its newest otherwise', () => {
    const { s, sent } = session([])
    s.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
    s.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })
    expect((sent[0].result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26')
    expect((sent[1].result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18')
    expect((sent[0].result as { serverInfo: unknown }).serverInfo).toEqual({ name: 'switchboard', version: '1.0.0' })
  })

  it('lists tools with their annotations', () => {
    const { s, sent } = session([echo])
    s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(sent[0].result).toEqual({ tools: [{ name: 'echo', description: 'Echo', inputSchema: echo.inputSchema, annotations: { readOnlyHint: true } }] })
  })

  it('dispatches a call to its tool', async () => {
    const { s, sent } = session([echo])
    s.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: { text: 'hi' } } })
    await tick()
    expect(sent[0]).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'hi' }] } })
  })

  it('answers an unknown tool and an unknown method with JSON-RPC errors', async () => {
    const { s, sent } = session([echo])
    s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'merge' } })
    s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/list' })
    await tick()
    expect(sent.map((m) => (m.error as { code: number }).code)).toEqual([-32602, -32601])
  })

  it('turns a throwing tool into isError output', async () => {
    const { s, sent } = session([{ ...echo, call: async () => { throw new Error('boom') } }])
    s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })
    await tick()
    expect((sent[0].result as { isError: boolean }).isError).toBe(true)
  })

  it('aborts a cancelled call and sends it no response', async () => {
    let signal: AbortSignal | null = null
    let finish: () => void = () => {}
    const slow: McpTool = { ...echo, call: (_args, ctx) => { signal = ctx.signal; return new Promise((resolve) => { finish = () => resolve(toolText('late')) }) } }
    const { s, sent } = session([slow])
    s.handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'echo' } })
    s.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } })
    expect(signal!.aborted).toBe(true)
    finish()
    await tick()
    expect(sent).toEqual([])
  })

  it('aborts every call still running when the connection closes', () => {
    const signals: AbortSignal[] = []
    const { s } = session([{ ...echo, call: (_a, ctx) => { signals.push(ctx.signal); return new Promise(() => {}) } }])
    s.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } })
    s.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo' } })
    s.close()
    expect(signals.every((sig) => sig.aborted)).toBe(true)
  })

  it('ignores notifications and responses it did not ask for', () => {
    const send = vi.fn()
    const s = new McpSession({ serverName: 's', serverVersion: '1', tools: [], send })
    s.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })
    s.handle({ jsonrpc: '2.0', id: 3, result: {} })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('McpTokens', () => {
  it('resolves a minted token to its chat until it is revoked', () => {
    const tokens = new McpTokens()
    const token = tokens.mint('chat-1')
    expect(tokens.resolve(token)).toBe('chat-1')
    expect(tokens.revoke('chat-1')).toBe(true)
    expect(tokens.resolve(token)).toBeNull()
  })

  it('replaces a chat\'s token when it is minted again', () => {
    const tokens = new McpTokens()
    const first = tokens.mint('chat-1')
    const second = tokens.mint('chat-1')
    expect(tokens.resolve(first)).toBeNull()
    expect(tokens.resolve(second)).toBe('chat-1')
  })

  it('refuses anything that is not a known token', () => {
    const tokens = new McpTokens()
    tokens.mint('chat-1')
    for (const bad of [undefined, '', 'guess', 42, 'x'.repeat(300)]) expect(tokens.resolve(bad)).toBeNull()
  })

  it('gives each chat its own token', () => {
    const tokens = new McpTokens()
    const a = tokens.mint('a')
    const b = tokens.mint('b')
    expect(a).not.toBe(b)
    expect(tokens.resolve(a)).toBe('a')
    expect(tokens.resolve(b)).toBe('b')
  })
})
