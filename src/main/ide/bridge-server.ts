/**
 * Main-process side of the sb-bridge WebSocket: the bundled extension in each
 * code-server extension host connects out with SB_BRIDGE_TOKEN, announces its
 * workspace folder via hello, and the server routes open/selection messages
 * by folder. Wire format documented in resources/sb-bridge/protocol.js.
 *
 * The wss is injected (same pattern as backend/ws-host.ts) so tests drive it
 * with fake sockets.
 */
import { createMainLogger } from '../logger'

const log = createMainLogger('ide:bridge')

export interface HelloMessage {
  type: 'hello'
  folder: string
}

export interface SelectionMessage {
  type: 'selection'
  path: string
  startLine: number
  endLine: number
  text: string
  /** 'edit' opens the quick-edit prompt in the renderer instead of a draft pill. */
  intent?: 'edit'
}

interface TerminalRequestMessage {
  type: 'terminal'
}

interface DsModeRequestMessage {
  type: 'dsmode'
}

type InboundMessage = HelloMessage | SelectionMessage | TerminalRequestMessage | DsModeRequestMessage

/** Minimal socket surface: real ws.WebSocket satisfies it, tests fake it. */
export interface BridgeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', cb: (data: { toString(): string }) => void): void
  on(event: 'close', cb: () => void): void
}

export interface BridgeWssLike {
  on(event: 'connection', cb: (socket: BridgeSocket, request: { url?: string }) => void): void
}

export interface BridgeCallbacks {
  onSelection(msg: SelectionMessage): void
  /** The user asked for a terminal inside the workbench - open Switchboard's. */
  onTerminalRequest(): void
  /** cmd+shift+J inside the workbench - toggle data scientist mode. */
  onDsModeRequest?(): void
  /** A workbench ext host registered for `folder` (used to flush queued opens). */
  onHello?(folder: string): void
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Validate an ext->main frame. Returns null on anything malformed. */
function parseInbound(raw: string): InboundMessage | null {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return null
  if (msg.type === 'hello' && isStr(msg.folder)) {
    return { type: 'hello', folder: msg.folder }
  }
  if (msg.type === 'terminal') return { type: 'terminal' }
  if (msg.type === 'dsmode') return { type: 'dsmode' }
  if (
    msg.type === 'selection' &&
    isStr(msg.path) &&
    isNum(msg.startLine) &&
    isNum(msg.endLine) &&
    typeof msg.text === 'string'
  ) {
    return {
      type: 'selection',
      path: msg.path,
      startLine: msg.startLine,
      endLine: msg.endLine,
      text: msg.text,
      ...(msg.intent === 'edit' && { intent: 'edit' as const }),
    }
  }
  return null
}

export class BridgeServer {
  /** folder -> the most recently hello'd socket for that workspace */
  private readonly byFolder = new Map<string, BridgeSocket>()

  constructor(
    wss: BridgeWssLike,
    private readonly token: string,
    private readonly callbacks: BridgeCallbacks
  ) {
    wss.on('connection', (socket, request) => this.onConnection(socket, request))
  }

  /** Push live vscode settings to every connected workbench. Returns the send count. */
  broadcastConfig(settings: Record<string, unknown>): number {
    const frame = JSON.stringify({ type: 'config', settings })
    let sent = 0
    for (const socket of new Set(this.byFolder.values())) {
      socket.send(frame)
      sent++
    }
    return sent
  }

  /** Reveal the file explorer in the workbench serving `folder`. False if none is connected. */
  focusExplorer(folder: string): boolean {
    const socket = this.byFolder.get(folder)
    if (!socket) return false
    socket.send(JSON.stringify({ type: 'focusExplorer' }))
    return true
  }

  /** Route an open request to the extension host serving `folder`. False if none is connected. */
  openFile(folder: string, path: string, line?: number, endLine?: number): boolean {
    const socket = this.byFolder.get(folder)
    if (!socket) return false
    socket.send(JSON.stringify({ type: 'open', path, ...(line !== undefined && { line }), ...(endLine !== undefined && { endLine }) }))
    return true
  }

  private onConnection(socket: BridgeSocket, request: { url?: string }): void {
    const presented = new URLSearchParams((request.url ?? '').split('?')[1] ?? '').get('token')
    if (presented !== this.token) {
      log.warn('rejected bridge connection with bad token')
      socket.close(4001, 'unauthorized')
      return
    }
    let folder: string | null = null
    socket.on('message', (data) => {
      const msg = parseInbound(data.toString())
      if (!msg) {
        log.warn('dropped malformed bridge frame')
        return
      }
      if (msg.type === 'hello') {
        folder = msg.folder
        this.byFolder.set(msg.folder, socket)
        log.info('bridge hello', { folder: msg.folder })
        this.callbacks.onHello?.(msg.folder)
      } else if (msg.type === 'terminal') {
        this.callbacks.onTerminalRequest()
      } else if (msg.type === 'dsmode') {
        this.callbacks.onDsModeRequest?.()
      } else {
        this.callbacks.onSelection(msg)
      }
    })
    socket.on('close', () => {
      // Only unregister if this socket is still the registered one - a webview
      // reload reconnects before the stale socket's close fires.
      if (folder && this.byFolder.get(folder) === socket) this.byFolder.delete(folder)
    })
  }
}
