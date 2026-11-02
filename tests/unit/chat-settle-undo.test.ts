import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settleConversation = vi.fn(async () => ({ ok: true, settledAt: 1 }))
const unsettleConversation = vi.fn(async () => ({ ok: true }))
vi.stubGlobal('window', { api: { app: { settleConversation, unsettleConversation }, routing: { bind: vi.fn() } } })

const { SETTLE_UNDO_MS, settleChat, undoLastSettle } = await import('../../src/renderer/services/chat-settle')
const { useAgentStore } = await import('../../src/renderer/stores/agent-store')

describe('settle undo expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useAgentStore.getState().setLastUndo(null)
  })
  afterEach(() => vi.useRealTimers())

  it('withdraws Undo after the notice time with no notice mounted', async () => {
    await settleChat({ id: 'c1', title: 'Chat', machineId: 'local' })
    expect(useAgentStore.getState().lastUndo?.id).toBe('c1')
    vi.advanceTimersByTime(SETTLE_UNDO_MS - 1)
    expect(useAgentStore.getState().lastUndo?.id).toBe('c1')
    vi.advanceTimersByTime(1)
    expect(useAgentStore.getState().lastUndo).toBeNull()
    expect(undoLastSettle()).toBeNull()
    expect(unsettleConversation).not.toHaveBeenCalled()
  })

  it('gives a second settle its own full time', async () => {
    await settleChat({ id: 'c1', title: 'One', machineId: 'local' })
    vi.advanceTimersByTime(SETTLE_UNDO_MS - 1000)
    await settleChat({ id: 'c2', title: 'Two', machineId: 'local' })
    vi.advanceTimersByTime(SETTLE_UNDO_MS - 1)
    expect(useAgentStore.getState().lastUndo?.id).toBe('c2')
    expect(undoLastSettle()).toBe('c2')
    expect(unsettleConversation).toHaveBeenCalledWith('c2')
  })
})
