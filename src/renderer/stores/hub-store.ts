import { useEffect } from 'react'
import { create } from 'zustand'
import { EMPTY_HUB_VIEW, type HubChatView } from '@shared/hub'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('store:hub')

/**
 * Child chats per shown chat: its parent while it is an open child, its
 * children while it has any. Read from `provider:hub-list-children` when a
 * chat panel or an unfolded sidebar parent mounts and again on
 * `hub.children-changed`, so it holds only the chats on screen.
 */
interface HubStore {
  views: Record<string, HubChatView>
  load: (threadId: string) => Promise<void>
}

export const useHubStore = create<HubStore>((set) => ({
  views: {},
  load: async (threadId) => {
    try {
      const view = await window.api.provider.hubListChildren(threadId)
      if (mounted.has(threadId)) set((s) => ({ views: { ...s.views, [threadId]: view } }))
    } catch (err) {
      // An older backend has no such channel: the chat shows no hub UI.
      log.warn('reading the hub view failed', err)
    }
  },
}))

const mounted = new Map<string, number>()
let offEvents: (() => void) | null = null

let reloadTimer: ReturnType<typeof setTimeout> | null = null

/** One re-read per burst: a batch start or a busy child sends several changes at once. */
function reloadAll(): void {
  reloadTimer ??= setTimeout(() => {
    reloadTimer = null
    for (const id of mounted.keys()) void useHubStore.getState().load(id)
  }, RELOAD_DEBOUNCE_MS)
}

const RELOAD_DEBOUNCE_MS = 250

/** A chat's own turn moves only the parent state, so only a chat with children re-reads on it. */
const hasChildren = (threadId: string) => (useHubStore.getState().views[threadId]?.children.length ?? 0) > 0

function mount(threadId: string): () => void {
  mounted.set(threadId, (mounted.get(threadId) ?? 0) + 1)
  // ponytail: any child change re-reads every shown chat (the chat panels and unfolded sidebar parents); the event names the parent's root id, which a shown chat may know under a rotated id.
  offEvents ??= window.api.provider.onEvent((event) => {
    if (event.type === 'hub.children-changed') reloadAll()
    else if ((event.type === 'status' || event.type === 'turn.completed') && hasChildren(event.threadId))
      void useHubStore.getState().load(event.threadId)
  })
  void useHubStore.getState().load(threadId)
  return () => {
    const n = (mounted.get(threadId) ?? 1) - 1
    if (n > 0) {
      mounted.set(threadId, n)
      return
    }
    mounted.delete(threadId)
    useHubStore.setState((s) => {
      const { [threadId]: _gone, ...views } = s.views
      return { views }
    })
    if (mounted.size === 0) {
      offEvents?.()
      offEvents = null
    }
  }
}

/** The hub view of a shown chat; empty until read, with the flag off, or with no chat. */
export function useHubView(threadId: string | null | undefined): HubChatView {
  useEffect(() => (threadId ? mount(threadId) : undefined), [threadId])
  return useHubStore((s) => (threadId ? s.views[threadId] : undefined)) ?? EMPTY_HUB_VIEW
}
