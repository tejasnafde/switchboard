import * as secrets from '../../lib/secrets'
import { getClient, useConnectionsStore } from '../connections'
import { usePushStore } from '../push'
import { SwitchboardClient } from '../../lib/api'

jest.mock('expo-network', () => ({}))
jest.mock('../../lib/push', () => ({ obtainPushToken: jest.fn() }))

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

const token = 'ExpoPushToken[phone]'
beforeEach(() => {
  usePushStore.setState({ token, registered: new Set(['mac']) })
  useConnectionsStore.setState({
    configs: [{ id: 'mac', label: 'Mac', kind: 'ws', url: 'ws://localhost' }],
    status: {},
  })
})

test('unpair waits for unregister before closing the client and forgets registration', async () => {
  let acknowledge!: (value: unknown) => void
  const transport = {
    invoke: jest.fn(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    ),
    on: jest.fn(() => () => {}),
    close: jest.fn(),
  }
  jest.spyOn(SwitchboardClient, 'overWs').mockReturnValue(new SwitchboardClient(transport as never))
  useConnectionsStore.getState().connect('mac')
  useConnectionsStore.getState().setStatus('mac', 'connected')
  const removing = useConnectionsStore.getState().removeConnection('mac')
  expect(transport.invoke).toHaveBeenCalledWith('push:unregister', token)
  expect(transport.close).not.toHaveBeenCalled()
  acknowledge({ ok: true })
  await removing
  expect(transport.close).toHaveBeenCalledTimes(1)
  expect(getClient('mac')).toBeUndefined()
  expect(usePushStore.getState().registered.has('mac')).toBe(false)
  expect(useConnectionsStore.getState().configs).toEqual([])
})

test('offline unpair forgets registration without waiting for a backend', async () => {
  await useConnectionsStore.getState().removeConnection('mac')
  expect(usePushStore.getState().registered.has('mac')).toBe(false)
  expect(useConnectionsStore.getState().configs).toEqual([])
})

test('demo never sends push registration or unregister requests', async () => {
  useConnectionsStore.getState().startDemo()
  const client = getClient('demo')!
  const invoke = jest.spyOn(client.transport, 'invoke')
  await usePushStore.getState().registerWith('demo')
  await usePushStore.getState().unregisterWith('demo')
  expect(invoke).not.toHaveBeenCalled()
  useConnectionsStore.getState().stopDemo()
})

test('unresponsive backend gets one attempt and removal finishes after two seconds', async () => {
  jest.useFakeTimers()
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  const transport = { invoke: jest.fn(() => new Promise(() => {})), on: jest.fn(() => () => {}), close: jest.fn() }
  jest.spyOn(SwitchboardClient, 'overWs').mockReturnValue(new SwitchboardClient(transport as never))
  useConnectionsStore.getState().connect('mac')
  const removing = useConnectionsStore.getState().removeConnection('mac')
  await jest.advanceTimersByTimeAsync(2000)
  await removing
  expect(transport.invoke).toHaveBeenCalledTimes(1)
  expect(transport.close).toHaveBeenCalledTimes(1)
  expect(useConnectionsStore.getState().configs).toEqual([])
  expect(warn).toHaveBeenCalled()
})

test('a late pairing response cannot restore keys for a removed machine', async () => {
  const save = jest.spyOn(secrets, 'saveConnectionSession').mockResolvedValue(true)
  let acknowledge!: (value: unknown) => void
  const transport = {
    invoke: jest.fn(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve
        }),
    ),
    on: jest.fn(() => () => {}),
    close: jest.fn(),
    onSessionIssued: undefined as ((session: string) => void) | undefined,
  }
  jest.spyOn(SwitchboardClient, 'overWs').mockReturnValue(new SwitchboardClient(transport as never))
  useConnectionsStore.getState().connect('mac')
  const removing = useConnectionsStore.getState().removeConnection('mac')
  transport.onSessionIssued?.('late-session')
  acknowledge({ ok: true })
  await removing
  expect(save).not.toHaveBeenCalled()
})
