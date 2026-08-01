/**
 * This device's push token and its registration with each paired backend.
 *
 * One token, many backends: the Mac and every VM each need to know it, because
 * each sends its own notifications.
 */
import { create } from 'zustand'
import { createLogger } from '@shared/logger'
import { obtainPushToken, type PushSetup } from '../lib/push'
import { getClient, useConnectionsStore } from './connections'

const log = createLogger('store:push')

interface PushState {
  token: string | null
  /** Why registration is unavailable, for the Settings screen to explain. */
  problem: Exclude<PushSetup, { ok: true }> | null
  registered: Set<string>
  init: () => Promise<void>
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
    // Register with everything already connected; later connections register
    // themselves through registerWith.
    for (const c of useConnectionsStore.getState().configs) await get().registerWith(c.id)
  },

  registerWith: async (connectionId) => {
    const { token, registered } = get()
    if (!token || registered.has(connectionId)) return
    const client = getClient(connectionId)
    if (!client) return
    try {
      // Pass our own connection id so every payload comes back tagged with the
      // backend that sent it - a tap can then open the right thread.
      const res = await client.registerPush(token, 'phone', connectionId)
      if (res?.ok === false) {
        log.warn(`backend rejected push token: ${res.error}`)
        return
      }
      set({ registered: new Set(registered).add(connectionId) })
    } catch (err) {
      // An older backend has no push handler. Not worth surfacing.
      log.warn('push registration failed', err)
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
