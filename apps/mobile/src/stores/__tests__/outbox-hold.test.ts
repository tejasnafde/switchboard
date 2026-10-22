import { drain, enqueue, holdThread, releaseThread, useOutboxStore, withdrawQueued } from '../outbox'
import type { QueuedMessage } from '../../lib/outbox-model'

jest.mock('expo-network', () => ({}))
jest.mock('../../lib/push', () => ({ obtainPushToken: jest.fn() }))
jest.mock('../../lib/outbox-storage', () => ({
  loadQueued: jest.fn(async () => []),
  saveQueued: jest.fn(async () => undefined),
  removeQueued: jest.fn(async () => undefined),
  deleteQueued: jest.fn(async () => undefined),
}))

const mockSubmitTurn = jest.fn(async () => ({ accepted: true, duplicate: false, state: 'completed' }))
jest.mock('../connections', () => ({
  getClient: () => ({
    transport: { isConnected: () => true },
    supportsCapability: () => true,
    getPendingHandoff: async () => ({ from: null }),
    submitTurn: mockSubmitTurn,
  }),
}))

function message(id: string): QueuedMessage {
  return { connectionId: 'mac', threadId: 't1', messageId: id, text: id, createdAt: 1, attempts: 0 }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  mockSubmitTurn.mockClear()
  useOutboxStore.setState({ messages: [], editingId: null })
})

test('a held chat sends nothing until it is released, then each message once and in order', async () => {
  holdThread('mac', 't1')
  await enqueue(message('a'))
  await enqueue(message('b'))
  await settle()
  expect(mockSubmitTurn).not.toHaveBeenCalled()

  releaseThread('mac', 't1')
  await settle()
  await drain()
  expect(mockSubmitTurn.mock.calls.map((call) => (call as unknown[])[0])).toMatchObject([
    { origin: 'a' },
    { origin: 'b' },
  ])
  expect(useOutboxStore.getState().messages).toEqual([])
})

test('withdrawn messages leave the queue and are never sent', async () => {
  holdThread('mac', 't1')
  await enqueue(message('a'))
  const back = await withdrawQueued(['a'])
  expect(back.map((m) => m.messageId)).toEqual(['a'])
  releaseThread('mac', 't1')
  await settle()
  expect(mockSubmitTurn).not.toHaveBeenCalled()
  expect(useOutboxStore.getState().messages).toEqual([])
})

test('a release during another chat delivery still sends the held message', async () => {
  let finish: () => void = () => {}
  mockSubmitTurn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve({ accepted: true, duplicate: false, state: 'completed' })
      }),
  )
  holdThread('mac', 't1')
  await enqueue(message('a'))
  // This pass skips the held message, then waits on the other chat's send.
  await enqueue({ ...message('other'), threadId: 't2' })
  await settle()
  releaseThread('mac', 't1')
  finish()
  await settle()
  expect(mockSubmitTurn.mock.calls.map((call) => (call as unknown[])[0])).toMatchObject([
    { origin: 'other' },
    { origin: 'a' },
  ])
})
