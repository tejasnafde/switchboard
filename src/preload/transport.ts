/**
 * Renderer↔backend seam: window.api.* goes through a Transport, not
 * ipcRenderer directly, so the backend can later be local (IpcTransport) or
 * remote-over-WebSocket without the renderer changing. invoke = req/resp,
 * send = fire-and-forget, on = push subscription (returns an unsubscribe fn).
 */
import { ipcRenderer, type IpcRendererEvent } from 'electron'

export interface Transport {
  // any default mirrors Electron's Promise<any> wire; callers annotate to infer T.
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
