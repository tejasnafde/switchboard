import { AppState, type AppStateStatus } from 'react-native'
import { getClient, installLifecycleReconnect, onAppBackground, useConnectionsStore } from '../connections'
import { SwitchboardClient } from '../../lib/api'

jest.mock('expo-network', () => ({}))
jest.mock('../../lib/push', () => ({ obtainPushToken: jest.fn() }))

let emit: (next: AppStateStatus) => void = () => {}
let uninstall: () => void = () => {}

beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    emit = listener as (next: AppStateStatus) => void
    return { remove: jest.fn() } as never
  })
  useConnectionsStore.setState({
    configs: [{ id: 'mac', label: 'Mac', kind: 'ws', url: 'ws://localhost' }],
    status: {},
  })
})

afterEach(() => {
  uninstall()
  useConnectionsStore.getState().disconnect('mac')
  jest.restoreAllMocks()
})

// connect() checks the transport gate asynchronously before it makes the client.
async function connectWith(transport: Record<string, unknown>): Promise<void> {
  jest.spyOn(SwitchboardClient, 'overWs').mockReturnValue(
    new SwitchboardClient({
      invoke: jest.fn(),
      on: jest.fn(() => () => {}),
      close: jest.fn(),
      ...transport,
    } as never),
  )
  useConnectionsStore.getState().connect('mac')
  for (let i = 0; i < 50 && !getClient('mac'); i++) await new Promise((r) => setTimeout(r, 0))
  expect(getClient('mac')).toBeDefined()
}

function awayFor(ms: number): void {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
  emit('background')
  now.mockReturnValue(1_000 + ms)
  emit('active')
  now.mockRestore()
}

test('a short absence resumes the transport so a socket between attempts dials now', async () => {
  const transport = { resume: jest.fn(), probe: jest.fn(), forceReconnect: jest.fn() }
  await connectWith(transport)
  uninstall = installLifecycleReconnect()

  awayFor(5_000)

  expect(transport.resume).toHaveBeenCalledTimes(1)
  expect(transport.probe).not.toHaveBeenCalled()
  expect(transport.forceReconnect).not.toHaveBeenCalled()
})

test('a long absence redials outright', async () => {
  const transport = { resume: jest.fn(), forceReconnect: jest.fn() }
  await connectWith(transport)
  uninstall = installLifecycleReconnect()

  awayFor(60_000)

  expect(transport.forceReconnect).toHaveBeenCalledTimes(1)
  expect(transport.resume).not.toHaveBeenCalled()
})

test('a transport with only a probe, such as an IAP tunnel, is still probed', async () => {
  const transport = { probe: jest.fn() }
  await connectWith(transport)
  uninstall = installLifecycleReconnect()

  awayFor(5_000)

  expect(transport.probe).toHaveBeenCalledTimes(1)
})

test('going to the background runs the registered callbacks once', () => {
  const release = jest.fn()
  const unsubscribe = onAppBackground(release)
  uninstall = installLifecycleReconnect()

  emit('background')
  unsubscribe()
  emit('active')
  emit('background')

  expect(release).toHaveBeenCalledTimes(1)
})
