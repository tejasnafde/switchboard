import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const settleConversation = vi.fn(async () => ({ ok: true, settledAt: 1 }))
const unsettleConversation = vi.fn(async (_id: string) => ({ ok: true }))
const snoozeConversation = vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }))
vi.stubGlobal('window', {
  api: { app: { settleConversation, unsettleConversation, snoozeConversation }, routing: { bind: vi.fn() } },
})

const { INBOX_UNDO_MS, applySettledEvent, onSettledChange, settleChat, undoLastInbox } =
  await import('../../src/renderer/services/chat-inbox')
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
    vi.advanceTimersByTime(INBOX_UNDO_MS - 1)
    expect(useAgentStore.getState().lastUndo?.id).toBe('c1')
    vi.advanceTimersByTime(1)
    expect(useAgentStore.getState().lastUndo).toBeNull()
    expect(undoLastInbox()).toBeNull()
    expect(unsettleConversation).not.toHaveBeenCalled()
  })

  it('gives a second settle its own full time', async () => {
    await settleChat({ id: 'c1', title: 'One', machineId: 'local' })
    vi.advanceTimersByTime(INBOX_UNDO_MS - 1000)
    await settleChat({ id: 'c2', title: 'Two', machineId: 'local' })
    vi.advanceTimersByTime(INBOX_UNDO_MS - 1)
    expect(useAgentStore.getState().lastUndo?.id).toBe('c2')
    expect(undoLastInbox()).toBe('c2')
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
    undoLastInbox()
    await vi.waitFor(() => expect(changes).toHaveLength(2))
    off()
    expect(changes).toEqual([
      ['c3', null],
      ['c3', settledAt],
    ])
  })
})

describe('a settle the backend refuses', () => {
  beforeEach(() => useAgentStore.getState().setLastUndo(null))

  it('withdraws its own Undo but keeps a newer one for the same chat', async () => {
    let refuse: (value: { ok: boolean; settledAt: number }) => void = () => {}
    settleConversation.mockImplementationOnce(() => new Promise((resolve) => (refuse = resolve)))
    const settling = settleChat({ id: 'c4', title: 'Chat', machineId: 'local' })
    const newer = { kind: 'snooze' as const, id: 'c4', title: 'Chat', machineId: 'local', until: 1, pr: null }
    useAgentStore.getState().setLastUndo(newer)
    refuse({ ok: false, settledAt: 1 })
    await settling
    expect(useAgentStore.getState().lastUndo).toBe(newer)
  })
})

describe('a merged PR settle from another machine', () => {
  it('routes Undo to the machine that sent the event', () => {
    applySettledEvent({ conversationId: 'r1', settledAt: 9, title: 'Remote', prNumber: 4, machineId: 'vm-1' })
    expect(useAgentStore.getState().lastUndo).toMatchObject({ id: 'r1', machineId: 'vm-1', prNumber: 4, settledAt: 9 })
  })
})

describe('Undo of a settle that ended a snooze', () => {
  const endedSnooze = { until: 5000, pr: 'github:acme/app#4', rev: 3 }
  beforeEach(() => {
    unsettleConversation.mockClear()
    snoozeConversation.mockClear()
  })

  it('snoozes again with the ended values, which also unsettles', async () => {
    applySettledEvent({ conversationId: 's1', settledAt: 9, prNumber: 4, endedSnooze, machineId: 'local' })
    expect(undoLastInbox()).toBe('s1')
    await vi.waitFor(() =>
      expect(snoozeConversation).toHaveBeenCalledWith('s1', { until: 5000, pr: 'github:acme/app#4', expectRev: 3 }),
    )
    expect(unsettleConversation).not.toHaveBeenCalled()
  })

  it('still unsettles when the backend refuses the snooze', async () => {
    snoozeConversation.mockImplementationOnce(async () => ({ ok: false, reason: 'pr_closed' }))
    applySettledEvent({ conversationId: 's2', settledAt: 9, prNumber: 4, endedSnooze, machineId: 'local' })
    undoLastInbox()
    await vi.waitFor(() => expect(unsettleConversation).toHaveBeenCalledWith('s2'))
  })
})
