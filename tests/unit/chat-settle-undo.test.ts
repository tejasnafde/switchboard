import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settleConversation = vi.fn(async () => ({ ok: true, settledAt: 1 }))
const unsettleConversation = vi.fn(async (_id: string) => ({ ok: true }))
vi.stubGlobal('window', { api: { app: { settleConversation, unsettleConversation }, routing: { bind: vi.fn() } } })

const { SETTLE_UNDO_MS, applySettledEvent, onSettledChange, settleChat, undoLastSettle } =
  await import('../../src/renderer/services/chat-settle')
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

describe('undo that fails', () => {
  beforeEach(() => useAgentStore.getState().setLastUndo(null))

  it.each([
    ['refuses', async () => ({ ok: false })],
    [
      'throws',
      async () => {
        throw new Error('offline')
      },
    ],
  ])('puts the chat back to settled when the backend %s', async (_name, answer) => {
    unsettleConversation.mockImplementationOnce(answer)
    await settleChat({ id: 'c3', title: 'Chat', machineId: 'local' })
    const settledAt = useAgentStore.getState().lastUndo?.settledAt
    const changes: Array<[string, number | null]> = []
    const off = onSettledChange((id, at) => changes.push([id, at]))
    undoLastSettle()
    await vi.waitFor(() => expect(changes).toHaveLength(2))
    off()
    expect(changes).toEqual([
      ['c3', null],
      ['c3', settledAt],
    ])
  })
})

describe('a merged PR settle from another machine', () => {
  it('routes Undo to the machine that sent the event', () => {
    applySettledEvent({ conversationId: 'r1', settledAt: 9, title: 'Remote', prNumber: 4, machineId: 'vm-1' })
    expect(useAgentStore.getState().lastUndo).toMatchObject({ id: 'r1', machineId: 'vm-1', prNumber: 4, settledAt: 9 })
  })
})
