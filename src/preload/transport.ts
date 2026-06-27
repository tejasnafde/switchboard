/**
 * Transport seam for the renderer↔backend boundary. Every `window.api.*`
 * method goes through a Transport instead of touching `ipcRenderer` directly,
 * so the backend can later live either in this Electron process (IpcTransport,
 * the only implementation today) or on a remote host reached over a WebSocket
 * (a future WsTransport) — without the renderer changing.
 *
 * Three shapes, matching the existing IPC usage:
 *   - invoke: request/response  (ipcRenderer.invoke → ipcMain.handle)
 *   - send:   fire-and-forget   (ipcRenderer.send   → ipcMain.on)
 *   - on:     push subscription (ipcRenderer.on), returns an unsubscribe fn
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

export interface Transport {
  // The IPC wire is untyped — Electron types `ipcRenderer.invoke` as
  // Promise<any>, and call sites add their own `: Promise<X>` annotation (which
  // infers T). Defaulting to `any` preserves that exact contract; this single
  // boundary exception is far cleaner than mistyping ~10 polymorphic channels.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T>
  send(channel: string, ...args: unknown[]): void
  on<A extends unknown[] = unknown[]>(channel: string, handler: (...args: A) => void): () => void
}

/** In-process transport: the backend runs in this Electron main process. */
export class IpcTransport implements Transport {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T> {
    return ipcRenderer.invoke(channel, ...args)
  }

  send(channel: string, ...args: unknown[]): void {
    ipcRenderer.send(channel, ...args)
  }

  on<A extends unknown[] = unknown[]>(channel: string, handler: (...args: A) => void): () => void {
    const wrapped = (_e: IpcRendererEvent, ...args: unknown[]) => handler(...(args as A))
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}
