import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { DeviceScope } from '../../shared/device-auth'

export interface BackendRequestContext {
  /** Opaque, credential-derived identity. Raw credentials must never be stored. */
  clientScope: string
  /** Identifies the trusted in-process renderer without exposing transport details to handlers. */
  transport?: 'electron' | 'remote'
  /** Authenticated transport scopes. Request payloads cannot supply or widen these. */
  deviceScopes?: readonly DeviceScope[]
  /** The paired device session (not its token), when the client redeemed one. */
  deviceSessionId?: string
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

export function remoteDeviceHasScope(scope: DeviceScope): boolean {
  const context = currentBackendRequestContext()
  return context?.transport !== 'remote' || context.deviceScopes?.includes(scope) === true
}

/** Who sent the current request, for a log line: never a credential. */
export function describeRequestClient(): string {
  const context = currentBackendRequestContext()
  if (context?.transport !== 'remote') return 'the desktop'
  if (context.deviceSessionId) return `device session ${context.deviceSessionId}`
  return `remote client ${context.clientScope.slice(-12)}`
}
