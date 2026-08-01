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

  // Liveness, implemented by the networked transports only. IpcTransport has no
  // connection to lose, so these stay optional rather than forcing a no-op stub
  // that would read as if it did something.

  /** False once the transport has given up for good (deliberate close, or a
   *  server verdict such as a rejected token). */
  isAlive?(): boolean
  /** Round-trip a keepalive and reconnect if it goes unanswered. Cheap enough
   *  to run whenever a client returns to the foreground. */
  probe?(timeoutMs?: number): void
  /** Drop the current socket and re-dial immediately, skipping backoff. For
   *  when the socket is known-stale rather than suspected-stale. */
  forceReconnect?(): void
  /** Report whether the device has a network. Retries pause while it does not,
   *  and resume the moment it returns rather than waiting out a backoff. */
  setOnline?(online: boolean): void
}
