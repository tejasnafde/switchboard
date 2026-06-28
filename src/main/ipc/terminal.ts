import type { BackendHost } from '../backend/host'
import { TerminalChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import type { TerminalCreateOptions, TerminalResizePayload, TerminalDataPayload } from '@shared/types'
import { PtyManager } from '../terminal/pty-manager'

const log = createLogger('ipc:terminal')

let ptyManager: PtyManager | null = null

export function registerTerminalHandlers(host: BackendHost): void {
  // Clean up the previous instance (e.g. on macOS activate); the host
  // re-registers handlers idempotently.
  ptyManager?.killAll()

  ptyManager = new PtyManager(
    (id, data) => host.emit(TerminalChannels.OUTPUT, id, data),
    (id, exitCode) => host.emit(TerminalChannels.EXIT, id, exitCode),
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
