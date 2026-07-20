import type { BackendHost } from '../backend/host'
import { TerminalChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import type { TerminalCreateOptions, TerminalResizePayload, TerminalDataPayload } from '@shared/types'
import { PtyManager } from '../terminal/pty-manager'
import { OutputCoalescer } from '../terminal/output-coalescer'

const log = createLogger('ipc:terminal')

let ptyManager: PtyManager | null = null
let outputCoalescer: OutputCoalescer | null = null

export function registerTerminalHandlers(host: BackendHost): void {
  // Clean up the previous instance (e.g. on macOS activate); the host
  // re-registers handlers idempotently. Flush the outgoing coalescer first
  // so buffered tail output isn't stranded on a timer aimed at the old host.
  outputCoalescer?.flushAll()
  ptyManager?.killAll()

  // Batch pty chunks (~8ms) so high-throughput output doesn't emit one
  // IPC/WS frame per chunk. EXIT flushes first so tail output isn't lost.
  const coalescer = new OutputCoalescer((id, data) => host.emit(TerminalChannels.OUTPUT, id, data))
  outputCoalescer = coalescer

  ptyManager = new PtyManager(
    (id, data) => coalescer.push(id, data),
    (id, exitCode) => {
      coalescer.flush(id)
      host.emit(TerminalChannels.EXIT, id, exitCode)
    },
  )

  host.handle(TerminalChannels.CREATE, async (opts: TerminalCreateOptions) => {
    log.info('create', opts.id, { cwd: opts.cwd, cols: opts.cols, rows: opts.rows })
    try {
      await ptyManager!.create(opts)
      log.info('created', opts.id)
      return { id: opts.id }
    } catch (err) {
      log.error('create failed', opts.id, err)
      throw err
    }
  })

  host.on(TerminalChannels.DATA, (payload: TerminalDataPayload) => {
    ptyManager!.write(payload.id, payload.data)
  })

  host.on(TerminalChannels.RESIZE, (payload: TerminalResizePayload) => {
    ptyManager!.resize(payload.id, payload.cols, payload.rows)
  })

  host.on(TerminalChannels.KILL, (id: string) => {
    ptyManager!.kill(id)
  })
}
