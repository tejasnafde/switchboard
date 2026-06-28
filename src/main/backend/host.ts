/**
 * BackendHost decouples the backend (IPC handlers, PTYs, providers, DB) from
 * *where* it runs. Handlers register against a host instead of `ipcMain`
 * directly, so the same handler code can be served either in this Electron
 * process (ElectronIpcHost) or, later, by a standalone server over a
 * WebSocket (a future WsHost) — local or remote, same handlers.
 *
 * Mirrors the renderer's Transport on the other side of the boundary:
 *   - handle: request/response   (was ipcMain.handle)
 *   - on:     fire-and-forget in (was ipcMain.on)
 *   - emit:   push out to client (was window.webContents.send)
 *
 * Handlers receive only the channel args — never the Electron event — so they
 * stay transport-agnostic.
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
