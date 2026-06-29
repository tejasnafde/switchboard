/**
 * Backend-side mirror of the renderer Transport: handlers register handle/on/
 * emit against a host, not ipcMain directly, so the same code can run in this
 * Electron process (ElectronIpcHost) or a future remote server. Handlers get
 * only the channel args - never the Electron event - to stay transport-agnostic.
 */
import { ipcMain, type BrowserWindow } from 'electron'

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
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as A)))
  }

  on<A extends unknown[] = unknown[]>(channel: string, fn: (...args: A) => void): void {
    ipcMain.removeAllListeners(channel)
    ipcMain.on(channel, (_event, ...args) => fn(...(args as A)))
  }

  emit(channel: string, ...args: unknown[]): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(channel, ...args)
    }
  }
}
