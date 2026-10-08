/**
 * The Switchboard MCP server: one per backend process, serving the same tools
 * to Claude, Codex and OpenCode.
 *
 * Each agent spawns the stdio bridge (`stdio-bridge.ts`) as an MCP server
 * named `switchboard`. The bridge dials this loopback listener and sends the
 * chat's token first; the token decides which chat every later call belongs
 * to, and it is revoked (live connections dropped) when the session stops.
 * The protocol itself is `McpSession`; the tools are built by whoever opened
 * the chat (the provider registry), because the chat's mode, events and
 * approval cards live there.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { createMainLogger } from '../logger'
import { appVersion, userDataDir } from '../runtime'
import { McpSession, type McpTool } from './mcp-session'
import { McpTokens } from './mcp-tokens'
import { ensureStdioBridge, MCP_AUTH_KEY, MCP_PORT_ENV, MCP_TOKEN_FILE_ENV } from './stdio-bridge'

const log = createMainLogger('mcp:server')

/** The MCP server name every agent registers, so Claude sees `mcp__switchboard__*`, OpenCode `switchboard_*`. */
export const SWITCHBOARD_MCP_SERVER_NAME = 'switchboard'

/** A bridge that has not authenticated by then is dropped. */
const AUTH_TIMEOUT_MS = 5_000
/** No MCP message we accept comes near this; a longer line is abuse or a bug. */
const MAX_LINE_CHARS = 4 * 1024 * 1024

const INSTRUCTIONS = [
  'Switchboard tools for this chat. When the user asks you to raise, open or create a pull request, push the branch',
  'and call create_pull_request: do not use gh pr create, bbpr or a host API for it. It opens the pull request on the',
  'repository of this chat\'s project with the account the user set up in Switchboard, links it to this chat and',
  'shows it in Reviews. When the project folder holds several repositories, pass repoPath, the one the change is in.',
  'The other pull request tools act only on pull requests linked to this chat. When you open one another way, or the',
  'user asks you to work on one, call link_pull_request; unlink_pull_request removes one linked by mistake, and',
  'list_thread_pull_requests shows the links and the last automatic linking problem.',
  'Every write shows the user an approval card first and is posted as the user. The tool does not wait for the',
  'answer: it says the write is queued, and the result arrives later as a Switchboard message in this chat. Do not',
  'ask for the same write again while it is queued; withdraw_approval takes a card back. Approving, requesting',
  'changes and merging are left to the user. The session tools message the user\'s other open agent sessions.',
  'Switchboard draws a ```mermaid block as a diagram, and a ```chart block holding JSON as a chart:',
  '{"type":"bar"|"line"|"table","labels":["a","b"],"series":[{"name":"s","values":[1,2]}]}, with optional',
  '"title", "xTitle" and "yTitle"; at most 50 labels and 8 series.',
].join(' ')

/** What an adapter hands its agent to spawn the bridge. */
export interface SwitchboardMcpLaunch {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface SwitchboardMcpServerOptions {
  /** Where the bridge script is written. */
  bridgeDir?: () => string
}

interface ChatEntry {
  tools: () => McpTool[]
  sockets: Set<Socket>
  tokenFile: string
}

export class SwitchboardMcpServer {
  private readonly tokens = new McpTokens()
  private readonly chats = new Map<string, ChatEntry>()
  private server: Server | null = null
  private listening: Promise<number> | null = null
  /** Written once per process: the script is a constant. */
  private bridge: { script: string; tokenDir: string } | null = null

  constructor(private readonly opts: SwitchboardMcpServerOptions = {}) {}

  private bridgeFiles(): { script: string; tokenDir: string } {
    if (this.bridge) return this.bridge
    const dir = (this.opts.bridgeDir ?? (() => join(userDataDir(), 'mcp')))()
    const tokenDir = join(dir, 'tokens')
    // Tokens live in memory; a file left by an earlier process names nothing.
    rmSync(tokenDir, { recursive: true, force: true })
    mkdirSync(tokenDir, { recursive: true, mode: 0o700 })
    this.bridge = { script: ensureStdioBridge(dir), tokenDir }
    return this.bridge
  }

  /**
   * Give a chat its token and return how its agent launches the bridge.
   * Opening a chat again (a restart) replaces the old token.
   */
  async open(threadId: string, tools: () => McpTool[]): Promise<SwitchboardMcpLaunch> {
    const port = await this.listen()
    const { script, tokenDir } = this.bridgeFiles()
    this.close(threadId)
    const tokenFile = join(tokenDir, `${randomBytes(8).toString('hex')}.token`)
    writeFileSync(tokenFile, this.tokens.mint(threadId), { mode: 0o600 })
    this.chats.set(threadId, { tools, sockets: new Set(), tokenFile })
    return {
      // Electron's own binary runs as Node with ELECTRON_RUN_AS_NODE; the headless server is Node already.
      command: process.execPath,
      args: [script],
      env: { ELECTRON_RUN_AS_NODE: '1', [MCP_PORT_ENV]: String(port), [MCP_TOKEN_FILE_ENV]: tokenFile },
    }
  }

  /** The session stopped: its token stops working and its connections drop. */
  close(threadId: string): void {
    this.tokens.revoke(threadId)
    const entry = this.chats.get(threadId)
    if (!entry) return
    this.chats.delete(threadId)
    rmSync(entry.tokenFile, { force: true })
    for (const socket of entry.sockets) socket.destroy()
  }

  isOpen(threadId: string): boolean {
    return this.chats.has(threadId)
  }

  /** Stop listening and drop everything. Tests and shutdown. */
  async stop(): Promise<void> {
    for (const threadId of [...this.chats.keys()]) this.close(threadId)
    this.tokens.revokeAll()
    const server = this.server
    this.server = null
    this.listening = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private listen(): Promise<number> {
    this.listening ??= new Promise<number>((resolve, reject) => {
      const server = createServer((socket) => this.accept(socket))
      server.on('error', (err) => {
        log.error('listener failed', err)
        if (this.server === server) {
          this.server = null
          this.listening = null
        }
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Switchboard MCP listener has no port'))
          return
        }
        this.server = server
        log.info(`listening on 127.0.0.1:${address.port}`)
        resolve(address.port)
      })
      server.unref()
    })
    return this.listening
  }

  private accept(socket: Socket): void {
    socket.setNoDelay(true)
    let buffer = ''
    let session: McpSession | null = null
    let threadId: string | null = null
    const authTimer = setTimeout(() => {
      log.warn('bridge did not authenticate in time')
      socket.destroy()
    }, AUTH_TIMEOUT_MS)
    authTimer.unref?.()

    const send = (message: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`)
    }

    const onLine = (line: string): void => {
      if (!line.trim()) return
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch (err) {
        log.warn('dropped a line that is not JSON', { length: line.length, err: String(err) })
        if (session) send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      if (session) {
        session.handle(parsed)
        return
      }
      const token = (parsed as Record<string, unknown> | null)?.[MCP_AUTH_KEY]
      const chat = this.tokens.resolve(token)
      const entry = chat ? this.chats.get(chat) : undefined
      if (!chat || !entry) {
        log.warn('refused a bridge with an unknown or revoked token')
        socket.destroy()
        return
      }
      clearTimeout(authTimer)
      threadId = chat
      entry.sockets.add(socket)
      session = new McpSession({
        serverName: SWITCHBOARD_MCP_SERVER_NAME,
        serverVersion: appVersion(),
        instructions: INSTRUCTIONS,
        tools: entry.tools(),
        send,
      })
      log.info(`bridge connected for ${chat}`)
    }

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        onLine(line)
        if (socket.destroyed) return
        newline = buffer.indexOf('\n')
      }
      if (buffer.length > MAX_LINE_CHARS) {
        log.warn('dropped a bridge that sent an oversized line')
        socket.destroy()
      }
    })
    socket.on('error', (err) => log.warn('bridge socket error', { threadId, err: err.message }))
    socket.on('close', () => {
      clearTimeout(authTimer)
      session?.close()
      if (threadId) this.chats.get(threadId)?.sockets.delete(socket)
    })
  }
}

let shared: SwitchboardMcpServer | null = null

/** The backend's one server. Every registry (a reopened window makes a new one) opens chats on it. */
export function switchboardMcpServer(): SwitchboardMcpServer {
  shared ??= new SwitchboardMcpServer()
  return shared
}

/** Quit: stop the shared listener if one was ever created. */
export async function stopSwitchboardMcpServer(): Promise<void> {
  const server = shared
  shared = null
  await server?.stop()
}
