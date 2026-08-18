import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'

export interface BackendRequestContext {
  /** Opaque, credential-derived identity. Raw credentials must never be stored. */
  clientScope: string
}

const requestContext = new AsyncLocalStorage<BackendRequestContext>()

export function currentBackendRequestContext(): BackendRequestContext | undefined {
  return requestContext.getStore()
}

export function withBackendRequestContext<T>(
  context: BackendRequestContext,
  fn: () => T,
): T {
  return requestContext.run(context, fn)
}

export function hashClientScope(kind: string, rawIdentity: string): string {
  return `${kind}:${createHash('sha256').update(rawIdentity).digest('hex')}`
}
