/**
 * Home > Recents follows a chat settled or unsettled on a desktop while the
 * phone is connected, without waiting for the next focus or reconnect.
 */
import { getClient, useConnectionsStore } from '../connections'
import { useRecentsStore } from '../recents'
import { SwitchboardClient } from '../../lib/api'
import type { RecentSession } from '../../lib/home-recents'

jest.mock('expo-network', () => ({}))
jest.mock('../../lib/push', () => ({ obtainPushToken: jest.fn() }))

const row = (id: string, settledAt: number | null = null): RecentSession => ({
  id,
  title: id,
  startedAt: 100,
  projectPath: '/p',
  projectName: 'p',
  settledAt,
})

function fakeTransport() {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  return {
    handlers,
    invoke: jest.fn(async (channel: string) => (channel === 'app:get-projects' ? [] : [])),
    on: jest.fn((channel: string, handler: (...args: unknown[]) => void) => {
      handlers.set(channel, handler)
      return () => handlers.delete(channel)
    }),
    close: jest.fn(),
  }
}

async function connect(transport: ReturnType<typeof fakeTransport>): Promise<void> {
  jest.spyOn(SwitchboardClient, 'overWs').mockReturnValue(new SwitchboardClient(transport as never))
  useConnectionsStore.getState().connect('mac')
  for (let i = 0; i < 50 && !getClient('mac'); i++) await new Promise((r) => setTimeout(r, 0))
  expect(getClient('mac')).toBeDefined()
}

beforeEach(() => {
  useConnectionsStore.setState({
    configs: [{ id: 'mac', label: 'Mac', kind: 'ws', url: 'ws://localhost' }],
    status: {},
  })
  useRecentsStore.setState({ sessions: { mac: [row('a'), row('b')] }, live: {} })
})
afterEach(() => {
  useConnectionsStore.getState().disconnect('mac')
  jest.restoreAllMocks()
})

test('a settle broadcast patches the row, and an unsettle restores it', async () => {
  const transport = fakeTransport()
  await connect(transport)
  const settled = transport.handlers.get('app:conversation-settled')!
  settled({ conversationId: 'a', settledAt: 500, title: 'a', prNumber: 3 })
  expect(useRecentsStore.getState().sessions.mac).toEqual([row('a', 500), row('b')])
  settled({ conversationId: 'a', settledAt: null })
  expect(useRecentsStore.getState().sessions.mac).toEqual([row('a', null), row('b')])
})

test('a broadcast for an id no row has reads the list again', async () => {
  const transport = fakeTransport()
  await connect(transport)
  transport.invoke.mockClear()
  transport.handlers.get('app:conversation-settled')!({ conversationId: 'agent_1', settledAt: 500 })
  expect(transport.invoke).toHaveBeenCalledWith('app:get-projects')
})

test('a project read that was out before a settle does not undo the patch', async () => {
  const transport = fakeTransport()
  await connect(transport)
  const replies: ((projects: unknown) => void)[] = []
  transport.invoke.mockImplementation((channel: string) =>
    channel === 'app:get-projects' ? new Promise((resolve) => replies.push(resolve as never)) : Promise.resolve([]),
  )
  const project = (settledAt: number | null) => [
    { path: '/p', name: 'p', sessions: [{ id: 'a', title: 'a', startedAt: 100, settledAt }] },
  ]
  const refreshed = useRecentsStore.getState().refresh('mac')
  transport.handlers.get('app:conversation-settled')!({ conversationId: 'a', settledAt: 500 })
  replies[0](project(null))
  replies[1]?.(project(500))
  await refreshed
  await new Promise((r) => setTimeout(r, 0))
  expect(useRecentsStore.getState().sessions.mac).toEqual([expect.objectContaining({ id: 'a', settledAt: 500 })])
})

test('disconnect stops listening', async () => {
  const transport = fakeTransport()
  await connect(transport)
  useConnectionsStore.getState().disconnect('mac')
  expect(transport.handlers.has('app:conversation-settled')).toBe(false)
})
