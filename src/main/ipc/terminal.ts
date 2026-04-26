import { ipcMain, type BrowserWindow } from 'electron'
import { TerminalChannels } from '@shared/ipc-channels'
import { createMainLogger as createLogger } from '../logger'
import type { TerminalCreateOptions, TerminalResizePayload, TerminalDataPayload } from '@shared/types'
import { PtyManager } from '../terminal/pty-manager'

const log = createLogger('ipc:terminal')

let ptyManager: PtyManager | null = null

export function registerTerminalHandlers(window: BrowserWindow): void {
  // Clean up previous handlers + instance (e.g. on macOS activate)
  ptyManager?.killAll()
  ipcMain.removeHandler(TerminalChannels.CREATE)
  ipcMain.removeAllListeners(TerminalChannels.DATA)
  ipcMain.removeAllListeners(TerminalChannels.RESIZE)
  ipcMain.removeAllListeners(TerminalChannels.KILL)

  ptyManager = new PtyManager(
    // onData → forward PTY output to renderer
    (id, data) => {
      if (!window.isDestroyed()) {
        window.webContents.send(TerminalChannels.OUTPUT, id, data)
      }
    },
    // onExit → notify renderer
    (id, exitCode) => {
      if (!window.isDestroyed()) {
        window.webContents.send(TerminalChannels.EXIT, id, exitCode)
      }
    }
  )

  ipcMain.handle(TerminalChannels.CREATE, async (_event, opts: TerminalCreateOptions) => {
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

  ipcMain.on(TerminalChannels.DATA, (_event, payload: TerminalDataPayload) => {
    ptyManager!.write(payload.id, payload.data)
  })

  ipcMain.on(TerminalChannels.RESIZE, (_event, payload: TerminalResizePayload) => {
    ptyManager!.resize(payload.id, payload.cols, payload.rows)
  })

  ipcMain.on(TerminalChannels.KILL, (_event, id: string) => {
    ptyManager!.kill(id)
  })
}
