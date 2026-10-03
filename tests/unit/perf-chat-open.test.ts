import { afterEach, describe, expect, it, vi } from 'vitest'
const { end } = vi.hoisted(() => ({ end: vi.fn() }))
vi.mock('../../src/renderer/perf', () => ({ perfSpan: () => ({ end }) }))
import { beginChatOpen, chatMessagesCommitted, chatMessagesUnmounted } from '../../src/renderer/services/perf-chat-open'

afterEach(() => { chatMessagesUnmounted('t'); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('chat open through first committed message list', () => {
  it('waits for the loaded array to commit and then a frame', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
    const open = beginChatOpen('t')
    const messages = []
    chatMessagesCommitted('t', [])
    open.ready('t', messages, { readMs: 44 })
    expect(frames).toHaveLength(0)
    chatMessagesCommitted('t', messages)
    expect(end).not.toHaveBeenCalled()
    frames[0](0)
    expect(end).toHaveBeenCalledWith({ readMs: 44, messages: 0, outcome: 'rendered' })
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
