export function createSingleOwnerEventReducer<Event>(
  subscribe: (callback: (event: Event) => void) => () => void,
): { register: (callback: (event: Event) => void) => () => void } {
  const reducers = new Map<symbol, (event: Event) => void>()
  let unsubscribe: (() => void) | null = null

  const ensureSubscribed = (): void => {
    if (unsubscribe) return
    unsubscribe = subscribe((event) => {
      reducers.values().next().value?.(event)
    })
  }

  return {
    register: (callback) => {
      const token = Symbol('provider-event-reducer')
      reducers.set(token, callback)
      ensureSubscribed()
      return () => {
        reducers.delete(token)
        if (reducers.size !== 0 || !unsubscribe) return
        unsubscribe()
        unsubscribe = null
      }
    },
  }
}
