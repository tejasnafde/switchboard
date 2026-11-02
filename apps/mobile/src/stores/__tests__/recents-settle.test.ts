/**
 * The phone's own Settle and its Undo: the row leaves Recents before the
 * answer, comes back when the backend refuses, and Undo puts back the snooze a
 * merged PR's settle ended, as the desktop's Undo does.
 */
import { getClient, useConnectionsStore } from '../connections'
import { onMergeSettled, settleChat, undoSettle, useRecentsStore, type SettleUndo } from '../recents'
import { SwitchboardClient } from '../../lib/api'
import type { RecentSession } from '../../lib/home-recents'

jest.mock('expo-network', () => ({}))
jest.mock('../../lib/push', () => ({ obtainPushToken: jest.fn() }))

const row = (id: string, patch: Partial<RecentSession> = {}): RecentSession => ({
  id,
  title: id,
  startedAt: 100,
  projectPath: '/p',
  projectName: 'p',
  settledAt: null,
  ...patch,
})

type Answer = (channel: string, args: unknown[]) => unknown

function fakeTransport(answer: Answer, capabilities: string[]) {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    handlers,
    supportsCapability: (capability: string) => capabilities.includes(capability),
    invoke: jest.fn(async (channel: string, ...args: unknown[]) =>
      channel === 'app:get-projects' || channel === 'provider:list-sessions' ? [] : answer(channel, args),
    ),
    on: jest.fn((channel: string, handler: (...args: unknown[]) => void) => {
      handlers.set(channel, handler)
      return () => handlers.delete(channel)
    }),
    close: jest.fn(),
  }
}

async function connect(answer: Answer, capabilities = ['chat_settle_v1']): Promise<ReturnType<typeof fakeTransport>> {
  const transport = fakeTransport(answer, capabilities)
  jest.spyOn(SwitchboardClient, 'overWs').mockReturnValue(new SwitchboardClient(transport as never))
  useConnectionsStore.getState().connect('mac')
  for (let i = 0; i < 50 && !getClient('mac'); i++) await new Promise((r) => setTimeout(r, 0))
  expect(getClient('mac')).toBeDefined()
  // Let the connect's own reads land, so they do not put the list back mid-test.
  await new Promise((r) => setTimeout(r, 0))
  useRecentsStore.setState({ sessions: { mac: [row('a'), row('b')] }, live: {} })
  transport.invoke.mockClear()
  return transport
}

const settledAt = (id: string) => useRecentsStore.getState().sessions.mac?.find((s) => s.id === id)?.settledAt
const calls = (transport: ReturnType<typeof fakeTransport>) =>
  transport.invoke.mock.calls.filter(
    ([channel]) => channel !== 'app:get-projects' && channel !== 'provider:list-sessions',
  )

beforeEach(() => {
  useConnectionsStore.setState({
    configs: [{ id: 'mac', label: 'Mac', kind: 'ws', url: 'ws://localhost' }],
    status: {},
  })
})
afterEach(() => {
  useConnectionsStore.getState().disconnect('mac')
  jest.restoreAllMocks()
})

test('a settle takes the row out before the answer and calls the desktop channel', async () => {
  let release: (value: unknown) => void = () => {}
  const transport = await connect(() => new Promise((resolve) => (release = resolve)))
  const done = settleChat('mac', 'a', 500)
  expect(settledAt('a')).toBe(500)
  expect(calls(transport)).toEqual([['app:settle-conversation', 'a']])
  release({ ok: true, settledAt: 501 })
  await expect(done).resolves.toBeNull()
  expect(settledAt('a')).toBe(500)
})

test('a refused settle brings the row back and says so', async () => {
  await connect(() => ({ ok: false }))
  await expect(settleChat('mac', 'a', 500)).resolves.toBe('Could not settle. Try again')
  expect(settledAt('a')).toBeNull()
})

test('Undo unsettles at once through the same channel pair', async () => {
  const transport = await connect(() => ({ ok: true }))
  useRecentsStore.getState().applySettled('mac', { conversationId: 'a', settledAt: 500 })
  await expect(undoSettle({ connectionId: 'mac', id: 'a', settledAt: 500, text: 'Settled a' })).resolves.toBeNull()
  expect(settledAt('a')).toBeNull()
  expect(calls(transport)).toEqual([['app:unsettle-conversation', 'a']])
})

test('a failed Undo leaves the chat settled', async () => {
  await connect(() => Promise.reject(new Error('socket closed')))
  useRecentsStore.getState().applySettled('mac', { conversationId: 'a', settledAt: 500 })
  await expect(undoSettle({ connectionId: 'mac', id: 'a', settledAt: 500, text: 'Settled a' })).resolves.toBe(
    'Could not undo the settle. Try again',
  )
  expect(settledAt('a')).toBe(500)
})

const merged: SettleUndo = {
  connectionId: 'mac',
  id: 'a',
  settledAt: 500,
  text: 'Settled a: PR #7 merged',
  endedSnooze: { until: 9_000, pr: 'github:acme/app#7', rev: 4 },
}

test('Undo of a settle that ended a snooze snoozes again with its revision, which also unsettles', async () => {
  const transport = await connect((channel) =>
    channel === 'app:snooze-conversation' ? { ok: true, until: 9_000, pr: null, rev: 5 } : { ok: true },
  )
  useRecentsStore.getState().applySettled('mac', { conversationId: 'a', settledAt: 500 })
  await expect(undoSettle(merged)).resolves.toBeNull()
  expect(calls(transport)).toEqual([
    ['app:snooze-conversation', 'a', { until: 9_000, pr: 'github:acme/app#7', expectRev: 4 }],
  ])
  expect(useRecentsStore.getState().sessions.mac?.[0]).toEqual(
    expect.objectContaining({ settledAt: null, snoozedUntil: 9_000, snoozeRev: 5 }),
  )
})

test('a refused snooze restore still unsettles', async () => {
  const transport = await connect((channel) =>
    channel === 'app:snooze-conversation' ? { ok: false, reason: 'pr_closed' } : { ok: true },
  )
  useRecentsStore.getState().applySettled('mac', { conversationId: 'a', settledAt: 500 })
  await expect(undoSettle(merged)).resolves.toBeNull()
  expect(calls(transport).map(([channel]) => channel)).toEqual(['app:snooze-conversation', 'app:unsettle-conversation'])
  expect(settledAt('a')).toBeNull()
})

test('a merged PR settle broadcast offers Undo to Home; a settle by hand elsewhere does not', async () => {
  const transport = await connect(() => ({ ok: true }))
  const offered: SettleUndo[] = []
  const stop = onMergeSettled((undo) => offered.push(undo))
  const broadcast = transport.handlers.get('app:conversation-settled')!
  broadcast({ conversationId: 'b', settledAt: 600, title: 'Deploy' })
  broadcast({ conversationId: 'a', settledAt: 700, title: 'Fix', prNumber: 7, endedSnooze: merged.endedSnooze })
  stop()
  broadcast({ conversationId: 'b', settledAt: 800, title: 'Deploy', prNumber: 8 })
  expect(offered).toEqual([
    {
      connectionId: 'mac',
      id: 'a',
      settledAt: 700,
      text: 'Settled Fix: PR #7 merged',
      endedSnooze: merged.endedSnooze,
    },
  ])
  expect(settledAt('a')).toBe(700)
})

test('a backend without chat_settle_v1 offers no Undo, but the row still leaves', async () => {
  const transport = await connect(() => ({ ok: true }), [])
  const offered: SettleUndo[] = []
  const stop = onMergeSettled((undo) => offered.push(undo))
  transport.handlers.get('app:conversation-settled')!({
    conversationId: 'a',
    settledAt: 700,
    title: 'Fix',
    prNumber: 7,
  })
  stop()
  expect(offered).toEqual([])
  expect(settledAt('a')).toBe(700)
})
