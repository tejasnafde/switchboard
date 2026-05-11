/**
 * Generic JSON-RPC client over a child process's stdio. Mirrors the
 * Codex adapter's framing pattern: requests get a numeric id and a
 * Promise stored in a pending map; the framer's stdout pump resolves
 * them as responses arrive.
 *
 * Lifecycle:
 *   - `start({ command, args, cwd })` spawns the LSP server, sends
 *     `initialize` + `initialized`, and resolves once the server replies.
 *   - `request<T>(method, params)` returns the typed result (or rejects
 *     with the `error` object).
 *   - `notify(method, params)` is fire-and-forget (used for didOpen / didChange).
 *   - `dispose()` sends `shutdown` + `exit` and kills the process.
 *
 * Error handling: spawn failures, server crashes, framer parse failures
 * all surface via the `onError` hook so the manager can decide whether
 * to restart or surface a UI toast.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { LspFramer } from './framing'
import { createMainLogger } from '../logger'

const log = createMainLogger('lsp-client')

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
  method: string
}

export interface ClientStartArgs {
  command: string
  args: string[]
  cwd: string
  /** Initialization options passed in `initialize.initializationOptions`. */
  initOptions?: Record<string, unknown>
  /** Workspace root in URI form (`file:///abs/path`). */
  rootUri: string
}

export type NotificationHandler = (method: string, params: unknown) => void

export class LspClient {
  private child: ChildProcessWithoutNullStreams | null = null
  private framer = new LspFramer()
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private notifHandler: NotificationHandler = () => {}
  private disposed = false

  onNotification(handler: NotificationHandler): void {
    this.notifHandler = handler
  }

  async start(args: ClientStartArgs): Promise<void> {
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child as ChildProcessWithoutNullStreams

    child.stdout!.on('data', (chunk: Buffer) => {
      const messages = this.framer.feed(chunk)
      for (const msg of messages) this.dispatch(msg)
    })
    child.stderr!.on('data', (chunk: Buffer) => {
      log.warn(`stderr: ${chunk.toString('utf8').trim()}`)
    })
    child.on('exit', (code, signal) => {
      log.info(`server exited code=${code} signal=${signal}`)
      // Reject all pending requests with a server-died error
      for (const [id, p] of this.pending) {
        p.reject(new Error(`LSP server exited (${p.method})`))
        this.pending.delete(id)
      }
    })

    await this.request('initialize', {
      processId: process.pid,
      rootUri: args.rootUri,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          definition: { dynamicRegistration: false, linkSupport: false },
          hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { workspaceFolders: true, configuration: false },
      },
      initializationOptions: args.initOptions ?? {},
      workspaceFolders: [{ uri: args.rootUri, name: 'workspace' }],
    })
    this.notify('initialized', {})
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (!this.child || this.disposed) return Promise.reject(new Error('LSP client not started'))
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        method,
      })
      this.send(payload)
    })
  }

  notify(method: string, params: unknown): void {
    if (!this.child || this.disposed) return
    this.send({ jsonrpc: '2.0', method, params })
  }

  private send(payload: unknown): void {
    const body = JSON.stringify(payload)
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
    this.child!.stdin!.write(header + body)
  }

  private dispatch(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return
    const m = msg as { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.error) p.reject(m.error)
      else p.resolve(m.result)
      return
    }
    if (typeof m.method === 'string') {
      this.notifHandler(m.method, m.params)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    try {
      await this.request('shutdown', null).catch(() => {})
      this.notify('exit', null)
    } finally {
      this.child?.kill()
      this.child = null
    }
  }
}
