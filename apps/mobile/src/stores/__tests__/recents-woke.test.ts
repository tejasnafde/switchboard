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

const snoozedA = {
  conversationId: 'a',
  snoozedUntil: 5_000,
  snoozedAt: 1_000,
  snoozePr: null,
  snoozeRev: 4,
  wokeAt: null,
  wokeReason: null,
} as never

function listingClient(getProjects: jest.Mock) {
  return { getProjects, listLiveSessions: jest.fn().mockResolvedValue([]), supportsCapability: () => false }
}

test('a snooze broadcast while a list read is out reads the list again', async () => {
  let answer: (value: unknown) => void = () => {}
  const getProjects = jest
    .fn()
    .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    .mockResolvedValue([])
  jest.mocked(getClient).mockReturnValue(listingClient(getProjects) as never)
  const reading = useRecentsStore.getState().refresh('mac')
  useRecentsStore.getState().applySnooze('mac', snoozedA)
  expect(held()?.snoozedAt).toBe(1_000)
  expect(getProjects).toHaveBeenCalledTimes(2)
  answer([])
  await reading
})

test('a snooze broadcast for a chat the list does not hold reads the list again', () => {
  const getProjects = jest.fn().mockResolvedValue([])
  jest.mocked(getClient).mockReturnValue(listingClient(getProjects) as never)
  useRecentsStore.getState().applySnooze('mac', { ...(snoozedA as object), conversationId: 'rotated' } as never)
  expect(held()?.snoozedAt).toBeNull()
  expect(getProjects).toHaveBeenCalledTimes(1)
})
