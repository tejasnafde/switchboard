import { afterEach, describe, expect, it, vi } from 'vitest'
const { end } = vi.hoisted(() => ({ end: vi.fn() }))
vi.mock('../../src/renderer/perf', () => ({ perfSpan: () => ({ end }) }))
import { beginChatOpen, chatMessagesCommitted, chatMessagesUnmounted } from '../../src/renderer/services/perf-chat-open'

afterEach(() => {
  chatMessagesUnmounted('t')
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('chat open through first committed message list', () => {
  it('waits for the loaded array to commit and then a frame', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const open = beginChatOpen('t')
    const messages = [{ id: 'a', role: 'assistant' as const, content: 'one', timestamp: 1 }]
    open.ready('t', messages, { readMs: 44 })
    chatMessagesCommitted('t', [])
    expect(frames).toHaveLength(0)
    chatMessagesCommitted('t', messages)
    expect(end).not.toHaveBeenCalled()
    frames[0](0)
    expect(end).toHaveBeenCalledWith({ readMs: 44, messages: 1, outcome: 'rendered' })
  })
  it('handles cached lists that already committed before load finishes', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const open = beginChatOpen('t')
    const messages = []
    chatMessagesCommitted('t', messages)
    open.ready('t', messages)
    frames[0](0)
    expect(end).toHaveBeenCalledOnce()
  })
  it('does not count an array replaced before paint and finishes on the replacement', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const open = beginChatOpen('t')
    const messages = []
    const replacement = [{ id: 'a', role: 'assistant' as const, content: 'reply', timestamp: 1 }]
    open.ready('t', messages)
    chatMessagesCommitted('t', messages)
    chatMessagesCommitted('t', replacement)
    frames[0](0)
    expect(end).not.toHaveBeenCalled()
    frames[1](0)
    expect(end).toHaveBeenCalledExactlyOnceWith({ messages: 1, outcome: 'rendered' })
  })
  it('finishes on a replacement that commits before the loaded array did', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const open = beginChatOpen('t')
    const first = { id: 'a', role: 'assistant' as const, content: 'one', timestamp: 1 }
    const loaded = [first]
    open.ready('t', loaded)
    chatMessagesCommitted('t', [])
    expect(frames).toHaveLength(0)
    chatMessagesCommitted('t', [first, { id: 'b', role: 'assistant' as const, content: 'two', timestamp: 2 }])
    frames[0](0)
    expect(end).toHaveBeenCalledExactlyOnceWith({ messages: 2, outcome: 'rendered' })
  })
  it('finishes an empty load on the first list that commits', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    beginChatOpen('t').ready('t', [])
    chatMessagesCommitted('t', [{ id: 'x', role: 'assistant' as const, content: 'new', timestamp: 1 }])
    frames[0](0)
    expect(end).toHaveBeenCalledExactlyOnceWith({ messages: 1, outcome: 'rendered' })
  })
  it('does not report a list cleared before paint as rendered', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const loaded = [{ id: 'a', role: 'assistant' as const, content: 'one', timestamp: 1 }]
    beginChatOpen('t').ready('t', loaded)
    chatMessagesCommitted('t', loaded)
    chatMessagesCommitted('t', [])
    for (const frame of frames) frame(0)
    expect(end).not.toHaveBeenCalled()
  })
  it.each([null, { messages: [], loadStatus: 'error' as const }])(
    'ends a failed load without awaiting an empty-list paint (%j)',
    (response) => {
      const open = beginChatOpen('t')
      open.ready('t', [], {}, response)
      expect(end).toHaveBeenCalledExactlyOnceWith({ outcome: 'load-error' })
    },
  )
  it('does not count an abandoned frame as a rendered chat', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const open = beginChatOpen('t')
    const messages = []
    open.ready('t', messages)
    chatMessagesCommitted('t', messages)
    open.cancel('superseded')
    frames[0](0)
    expect(end).toHaveBeenCalledExactlyOnceWith({ outcome: 'superseded' })
  })
})
