import { beforeEach, expect, it } from 'vitest'
import { useChatStore, threadKey } from '../../apps/mobile/src/stores/chat'
import { mergeHistoryItems } from '../../apps/mobile/src/lib/thread-history'

const key = threadKey('phone', 'chat')
beforeEach(() => useChatStore.setState({ threads: {}, activeKey: key }))

it('keeps the displayed feed during a gap and renders live events immediately', () => {
  const store = useChatStore.getState()
  store.seedItems(key, [{ kind: 'user', id: 'h-old', text: 'saved', at: 1 }])
  store.invalidateConnection('phone')
  expect(useChatStore.getState().threads[key].items).toHaveLength(1)
  store.ingestNow('phone', { type: 'content', threadId: 'chat', messageId: 'live', text: 'now', streamKind: 'assistant' })
  expect(useChatStore.getState().threads[key].items).toHaveLength(2)
  expect(useChatStore.getState().threads[key].historyLoaded).toBe(false)
})

it('does not invalidate another backend or discard its paging cursor', () => {
  const other = threadKey('other', 'chat')
  useChatStore.getState().seedItems(other, [])
  useChatStore.getState().invalidateConnection('phone')
  expect(useChatStore.getState().threads[other].historyLoaded).toBe(true)
  expect(useChatStore.getState().threads[other].reseedRevision).toBeUndefined()
})

it('deduplicates older pages against live users and tools', () => {
  expect(mergeHistoryItems([
    { kind: 'user', id: 'h-remote_q', text: 'new', at: 1 },
    { kind: 'tool', id: 'h-message-t-tool', toolName: 'Read', input: {}, state: 'done' },
  ], [
    { kind: 'user', id: 'remote_q', text: 'new', at: 1 },
    { kind: 'tool', id: 't-tool', toolName: 'Read', input: {}, state: 'done' },
  ])).toHaveLength(2)
})
