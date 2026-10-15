/**
 * This device's push token and its registration with each paired backend.
 *
 * One token, many backends: the Mac and every VM each need to know it, because
 * each sends its own notifications.
 */
import { create } from 'zustand'
import { createLogger } from '@shared/logger'
import { isDemoConnection } from '@shared/phone-demo/phone-demo'
import { obtainPushToken, type PushSetup } from '../lib/push'
import { getClient, useConnectionsStore } from './connections'

const log = createLogger('store:push')

/** Copy without one id, so a failed registration can be retried. */
function withoutId(ids: Set<string>, id: string): Set<string> {
  const next = new Set(ids)
  next.delete(id)
  return next
}

interface PushState {
  token: string | null
  /** Why registration is unavailable, for the Settings screen to explain. */
  problem: Exclude<PushSetup, { ok: true }> | null
  registered: Set<string>
  init: () => Promise<void>
  unregisterWith: (connectionId: string) => Promise<void>
  registerWith: (connectionId: string) => Promise<void>
  reportViewing: (connectionId: string, threadId: string | null) => void
}

export const usePushStore = create<PushState>((set, get) => ({
  token: null,
  problem: null,
  registered: new Set<string>(),

  init: async () => {
    if (get().token) return
    const result = await obtainPushToken()
    if (!result.ok) {
      set({ problem: result })
      return
    }
    set({ token: result.token, problem: null })

    // Register with whatever is connected now, then keep watching. A client
    // that is still dialling at startup, or a backend paired later, would
    // otherwise never register and its notifications would silently not work.
    const registerConnected = (): void => {
      const { status } = useConnectionsStore.getState()
      for (const [id, s] of Object.entries(status)) {
        if (s === 'connected' && !isDemoConnection(id)) void get().registerWith(id)
      }
    }
    registerConnected()
    useConnectionsStore.subscribe(registerConnected)
  },

  registerWith: async (connectionId) => {
    const { token, registered } = get()
    if (
      !token ||
      registered.has(connectionId) ||
      isDemoConnection(connectionId) ||
      !useConnectionsStore.getState().configs.some((c) => c.id === connectionId)
    )
      return
    // Claim the slot before awaiting: the subscription can fire again while
    // this request is in flight, which would double-register.
    set({ registered: new Set(registered).add(connectionId) })
    const client = getClient(connectionId)
    if (!client) {
      set({ registered: withoutId(get().registered, connectionId) })
      return
    }
    try {
      // Pass our own connection id so every payload comes back tagged with the
      // backend that sent it - a tap can then open the right thread.
      const res = await client.registerPush(token, 'phone', connectionId)
      if (
        getClient(connectionId) !== client ||
        !useConnectionsStore.getState().configs.some((c) => c.id === connectionId)
      )
        return
      if (res?.ok === false) {
        log.warn(`backend rejected push token: ${res.error}`)
        set({ registered: withoutId(get().registered, connectionId) })
      }
    } catch (err) {
      // An older backend has no push handler. Not worth surfacing, but let a
      // later attempt retry.
      log.warn('push registration failed', err)
      if (
        getClient(connectionId) === client &&
        useConnectionsStore.getState().configs.some((c) => c.id === connectionId)
      ) {
        set({ registered: withoutId(get().registered, connectionId) })
      }
    }
  },

  unregisterWith: async (connectionId) => {
    const { token } = get()
    set({ registered: withoutId(get().registered, connectionId) })
    const client = getClient(connectionId)
    if (!token || !client || isDemoConnection(connectionId)) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        client.unregisterPush(token),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('push unregister timed out')), 2000)
        }),
      ])
    } catch (err) {
      log.warn('push unregister failed; forgetting removed machine', err)
    } finally {
      clearTimeout(timeout)
    }
  },

  reportViewing: (connectionId, threadId) => {
    const { token } = get()
    if (!token) return
    getClient(connectionId)
      ?.reportViewing(token, threadId)
      .catch((err) => log.warn('reportViewing failed', err))
  },
}))

/**
 * Ask for push only once a machine is paired, so a fresh install and the demo
 * never see the permission prompt. Returns a teardown.
 */
export function initPushWhenPaired(): () => void {
  let unsubscribe = (): void => undefined
  const check = (): void => {
    if (useConnectionsStore.getState().configs.length === 0) return
    unsubscribe()
    void usePushStore.getState().init()
  }
  unsubscribe = useConnectionsStore.subscribe(check)
  check()
  return () => unsubscribe()
}
