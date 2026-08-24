/**
 * Backend-side mirror of the renderer Transport: handlers register handle/on/
 * emit against a host, not ipcMain directly, so the same code can run in this
 * Electron process (ElectronIpcHost) or a future remote server. Handlers get
 * only the channel args - never the Electron event - to stay transport-agnostic.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { hashClientScope, withBackendRequestContext } from './request-context'
import { prepareIpcEmit } from './ipc-wire'
import { createMainLogger as createLogger, writeCrashBreadcrumb } from '../logger'

const ELECTRON_CLIENT_SCOPE = hashClientScope('electron', 'local-renderer')
const log = createLogger('backend:electron-ipc')
const BREADCRUMB_TYPES = new Set(['tool.completed', 'user.message', 'turn.completed', 'error'])
const LARGE_EMIT_BYTES = 64 * 1024

export interface BackendHost {
  handle<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => unknown): void
  on<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => void): void
  emit(channel: string, ...args: unknown[]): void
}

/** In-process host: serves handlers over Electron IPC, pushes to a window. */
export class ElectronIpcHost implements BackendHost {
  constructor(private readonly window: BrowserWindow | null) {}

  handle<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => unknown): void {
    ipcMain.removeHandler(channel) // idempotent re-registration (StrictMode / reloads)
    ipcMain.handle(channel, (_event, ...args) =>
      withBackendRequestContext({ clientScope: ELECTRON_CLIENT_SCOPE, transport: 'electron' }, () => fn(...(args as A))))
  }

  on<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => void): void {
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, (_event, ...args) =>
      withBackendRequestContext({ clientScope: ELECTRON_CLIENT_SCOPE, transport: 'electron' }, () => fn(...(args as A))))
  }

  emit(channel: string, ...args: unknown[]): void {
    if (this.window && !this.window.isDestroyed()) {
      const prepared = prepareIpcEmit(channel, args)
      if (!prepared.ok) {
        writeCrashBreadcrumb('backend:electron-ipc', {
          action: 'dropped',
          channel: prepared.channel,
          eventType: prepared.eventType,
          threadId: prepared.threadId,
          eventId: prepared.eventId,
          bytes: prepared.bytes,
          reason: prepared.reason,
        })
        log.error('dropped unsafe IPC emit', prepared)
        return
      }
      if (
        prepared.bytes >= LARGE_EMIT_BYTES ||
        (prepared.eventType !== undefined && BREADCRUMB_TYPES.has(prepared.eventType))
      ) {
        writeCrashBreadcrumb('backend:electron-ipc', {
          action: 'send',
          channel: prepared.channel,
          eventType: prepared.eventType,
          threadId: prepared.threadId,
          eventId: prepared.eventId,
          bytes: prepared.bytes,
        })
      }
      this.window.webContents.send(channel, ...prepared.args)
    }
  }
}
