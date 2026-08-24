import { describe, expect, it, vi } from 'vitest'
import { createSingleOwnerEventReducer } from '../../src/renderer/services/providerEventReducerRegistry'

describe('provider event reducer registry', () => {
  it('subscribes once and delivers each event to exactly one mounted reducer', () => {
    let emit: ((event: { id: number }) => void) | null = null
    const unsubscribeTransport = vi.fn()
    const subscribe = vi.fn((callback: (event: { id: number }) => void) => {
      emit = callback
      return unsubscribeTransport
    })
    const registry = createSingleOwnerEventReducer(subscribe)
    const primary = vi.fn()
    const secondary = vi.fn()
    const removePrimary = registry.register(primary)
    const removeSecondary = registry.register(secondary)

    emit?.({ id: 1 })

    expect(subscribe).toHaveBeenCalledOnce()
    expect(primary).toHaveBeenCalledOnce()
    expect(secondary).not.toHaveBeenCalled()

    removePrimary()
    emit?.({ id: 2 })
    expect(secondary).toHaveBeenCalledOnce()

    removeSecondary()
    expect(unsubscribeTransport).toHaveBeenCalledOnce()
  })
})
