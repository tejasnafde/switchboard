import { getClient } from '../connections'
import { markWokeSeen, useRecentsStore } from '../recents'
import type { RecentSession } from '../../lib/home-recents'

jest.mock('expo-network', () => ({}))
jest.mock('../connections', () => ({ getClient: jest.fn() }))

const woke = { id: 'a', snoozedAt: null, wokeAt: 900, wokeReason: 'time', snoozeRev: 3 } as unknown as RecentSession

function client(markWokeSeen: jest.Mock, snooze = true) {
  return { supportsCapability: () => snooze, markWokeSeen }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const held = () => useRecentsStore.getState().sessions.mac?.[0]

beforeEach(() => useRecentsStore.setState({ sessions: { mac: [woke] }, live: {} }))

test('the Woke mark stays until the backend clears it, and a failed clear can run again', async () => {
  const mark = jest.fn().mockRejectedValueOnce(new Error('dropped')).mockResolvedValue({ ok: true })
  jest.mocked(getClient).mockReturnValue(client(mark) as never)
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})

  markWokeSeen('mac', 'a')
  markWokeSeen('mac', 'a')
  expect(mark).toHaveBeenCalledTimes(1)
  await flush()
  expect(held()?.wokeAt).toBe(900)
  expect(warn).toHaveBeenCalled()

  markWokeSeen('mac', 'a')
  await flush()
  expect(mark).toHaveBeenCalledTimes(2)
  expect(held()?.wokeAt).toBeNull()
  warn.mockRestore()
})

test('a backend without Snooze is not asked', () => {
  const mark = jest.fn()
  jest.mocked(getClient).mockReturnValue(client(mark, false) as never)
  markWokeSeen('mac', 'a')
  expect(mark).not.toHaveBeenCalled()
  expect(held()?.wokeAt).toBe(900)
})
