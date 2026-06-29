/**
 * The renderer↔backend seam contract. window.api.* goes through a Transport so
 * the backend can be local (IpcTransport, Electron IPC) or remote (WsTransport,
 * WebSocket) without the renderer changing. invoke = req/resp, send =
 * fire-and-forget, on = push subscription (returns an unsubscribe fn).
 */
export interface Transport {
  // any default mirrors Electron's Promise<any> wire; callers annotate to infer T.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke<T = any>(channel: string, ...args: unknown[]): Promise<T>
  send(channel: string, ...args: unknown[]): void
  on<A extends unknown[] = unknown[]>(channel: string, handler: (...args: A) => void): () => void
}
