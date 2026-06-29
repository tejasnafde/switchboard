/** In-process Transport impl: the backend runs in this Electron main process. */
import { ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Transport } from '@shared/transport'

export type { Transport }

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
