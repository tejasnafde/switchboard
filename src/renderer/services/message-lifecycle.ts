import { useCallback, useSyncExternalStore } from 'react'
import type { RuntimeEvent } from '@shared/provider-events'

export interface MessageLifecycleTracker {
  markMutable: (threadId: string, messageId: string) => void
  settleThread: (threadId: string) => void
  isMutable: (threadId: string, messageId: string) => boolean
  subscribe: (listener: () => void) => () => void
}

export function createMessageLifecycleTracker(): MessageLifecycleTracker {
  const mutableByThread = new Map<string, Set<string>>()
  const listeners = new Set<() => void>()

  function notify(): void {
    for (const listener of listeners) listener()
  }

  return {
    markMutable(threadId, messageId) {
      let messages = mutableByThread.get(threadId)
      if (!messages) {
        messages = new Set()
        mutableByThread.set(threadId, messages)
      }
      if (messages.has(messageId)) return
      messages.add(messageId)
      notify()
    },
    settleThread(threadId) {
      if (!mutableByThread.delete(threadId)) return
      notify()
    },
    isMutable(threadId, messageId) {
      return mutableByThread.get(threadId)?.has(messageId) ?? false
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function prepareRuntimeEventLifecycle(
  event: RuntimeEvent,
  tracker: MessageLifecycleTracker,
  flushThread: (threadId: string) => void,
): void {
  if (event.type === 'content') {
    tracker.markMutable(event.threadId, event.messageId)
    return
  }
  flushThread(event.threadId)
}

export function finishRuntimeEventLifecycle(
  event: RuntimeEvent,
  tracker: MessageLifecycleTracker,
): void {
  if (
    event.type === 'turn.completed' ||
    event.type === 'error' ||
    (event.type === 'status' && ['idle', 'error', 'stopped'].includes(event.status))
  ) {
    tracker.settleThread(event.threadId)
  }
}

export const messageLifecycle = createMessageLifecycleTracker()

export function useMessageMutable(threadId: string | undefined, messageId: string): boolean {
  const getSnapshot = useCallback(
    () => threadId ? messageLifecycle.isMutable(threadId, messageId) : false,
    [messageId, threadId],
  )
  return useSyncExternalStore(messageLifecycle.subscribe, getSnapshot, () => false)
}
