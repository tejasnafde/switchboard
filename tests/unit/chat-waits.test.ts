import { describe, expect, it } from 'vitest'
import { useChatWaitStore } from '../../src/renderer/stores/chat-wait-store'

describe('chat waits', () => {
  it('keeps a later open visible when an earlier load finishes', () => {
    const store = useChatWaitStore.getState()
    const first = store.open('primary', { id: 'one', title: 'First', projectPath: '/one' })
    const second = store.open('primary', { id: 'two', title: 'Second', projectPath: '/two' })
    store.finishOpen('primary', first)
    expect(useChatWaitStore.getState().opening.primary?.id).toBe('two')
    store.finishOpen('primary', second)
    expect(useChatWaitStore.getState().opening.primary).toBeUndefined()
  })
  it('dismisses a previous failure on reopen but keeps an active switch', () => {
    const store = useChatWaitStore.getState()
    store.fail('retry', 'Could not load conversation')
    store.open('primary', { id: 'retry', title: 'Retry', projectPath: '/retry' })
    expect(useChatWaitStore.getState().waits.retry).toBeUndefined()
    store.begin('retry', 'Switching to Work...')
    store.open('primary', { id: 'retry', title: 'Retry', projectPath: '/retry' })
    expect(useChatWaitStore.getState().waits.retry?.pending).toBe(true)
  })
  it('holds sends only while the operation is pending and retains failure in place', () => {
    const store = useChatWaitStore.getState()
    store.begin('one', 'Switching to Work...')
    expect(useChatWaitStore.getState().waits.one).toEqual({ label: 'Switching to Work...', pending: true })
    store.fail('one', 'Profile unavailable')
    store.finish('one')
    expect(useChatWaitStore.getState().waits.one).toEqual({ label: 'Profile unavailable', pending: false, error: true })
    store.begin('one', 'Starting Claude...')
    store.finish('one')
    expect(useChatWaitStore.getState().waits.one).toBeUndefined()
  })
})
