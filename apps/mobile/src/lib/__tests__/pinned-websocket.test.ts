import { WsTransport } from '@shared/ws-transport'

let mockPlatform = 'ios'
let mockAvailable = true
let mockNative: Record<'addListener' | 'connect' | 'send' | 'close', jest.Mock>
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: () => (mockAvailable ? mockNative : null),
}))

function load() {
  let result!: typeof import('../pinned-websocket')
  jest.isolateModules(() => {
    require('react-native').Platform.OS = mockPlatform
    result = require('../pinned-websocket')
  })
  return result
}
const fp = 'a'.repeat(64)
type SocketEvent = { id: string; type: string; data?: string; certificateChanged?: boolean }
let events: (event: SocketEvent) => void
let remove: jest.Mock
beforeEach(() => {
  mockAvailable = true
  mockPlatform = 'ios'
  remove = jest.fn()
  mockNative = {
    addListener: jest.fn((_name, listener) => {
      events = listener
      return { remove }
    }),
    connect: jest.fn(),
    send: jest.fn(),
    close: jest.fn(),
  }
})

it('selects pinned wss and removes fp from the dial URL while keeping auth', () => {
  const { pinnedTarget } = load()
  expect(pinnedTarget(`ws://mac:8765?fp=${fp}&auth=frame`)).toEqual({
    url: 'wss://mac:8765/?auth=frame',
    fingerprint: fp,
  })
  expect(pinnedTarget('ws://mac:8765')).toBeNull()
  expect(() => pinnedTarget('ws://mac?fp=invalid')).toThrow(/fingerprint/)
})
it('keeps old binary and Expo Go behaviour when the module is absent', () => {
  mockAvailable = false
  expect(load().pinnedTarget(`ws://mac?fp=${fp}`)).toBeNull()
})
it('does not select the iOS module on Android', () => {
  mockPlatform = 'android'
  expect(load().pinnedTarget(`ws://mac?fp=${fp}`)).toBeNull()
})
it('routes socket events by id, sends text and cleans up after close', () => {
  const { PinnedWebSocket } = load()
  const socket = new PinnedWebSocket('wss://mac', fp)
  const id = mockNative.connect.mock.calls[0][0]
  const opened = jest.fn(),
    message = jest.fn(),
    closed = jest.fn()
  socket.addEventListener('open', opened)
  socket.addEventListener('message', message)
  socket.addEventListener('close', closed)
  events({ id: 'other', type: 'open' })
  expect(opened).not.toHaveBeenCalled()
  events({ id, type: 'open' })
  socket.send('hello')
  expect(mockNative.send).toHaveBeenCalledWith(id, 'hello')
  events({ id, type: 'message', data: 'reply' })
  expect(message).toHaveBeenCalledWith(expect.objectContaining({ data: 'reply' }))
  socket.close()
  expect(mockNative.close).toHaveBeenCalledWith(id)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(closed).toHaveBeenCalledTimes(1)
  events({ id, type: 'open' })
  expect(opened).toHaveBeenCalledTimes(1)
})
it('makes a changed pin terminal in the real transport before error can schedule retries', () => {
  jest.useFakeTimers()
  const { PinnedWebSocket } = load()
  const socket = new PinnedWebSocket('wss://mac', fp)
  const id = mockNative.connect.mock.calls[0][0]
  const transport = new WsTransport('wss://mac', undefined, {}, null, () => socket)
  const error = jest.fn()
  socket.addEventListener('error', error)
  events({ id, type: 'error', certificateChanged: true })
  expect(transport.isAlive()).toBe(false)
  expect(transport.certificateChanged).toBe(true)
  expect(error).toHaveBeenCalled()
  expect(remove).toHaveBeenCalledTimes(1)
  jest.advanceTimersByTime(60_000)
  expect(mockNative.connect).toHaveBeenCalledTimes(1)
  transport.close()
  jest.useRealTimers()
})
it('reports ordinary network errors as retryable closes', () => {
  const { PinnedWebSocket } = load()
  const socket = new PinnedWebSocket('wss://mac', fp)
  const closed = jest.fn()
  socket.addEventListener('close', closed)
  events({ id: mockNative.connect.mock.calls[0][0], type: 'error' })
  expect(closed).toHaveBeenCalledWith(expect.objectContaining({ code: 1006 }))
})
it('the client uses the pinned socket for auth and hello frames', () => {
  let api!: typeof import('../api')
  jest.isolateModules(() => {
    api = require('../api')
  })
  const { pinnedTarget, PinnedWebSocket } = load()
  const target = pinnedTarget(`ws://mac:8765?fp=${fp}`)!
  const client = api.SwitchboardClient.overWs(
    target.url,
    undefined,
    { session: 'session' },
    (url) => new PinnedWebSocket(url, target.fingerprint),
  )
  const [id, url, pin] = mockNative.connect.mock.calls[0]
  expect(url).toBe('wss://mac:8765/?auth=frame')
  expect(pin).toBe(fp)
  events({ id, type: 'open' })
  expect(mockNative.send.mock.calls.map((call: unknown[]) => JSON.parse(call[1] as string).k)).toEqual([
    'auth',
    'hello',
  ])
  client.close()
})
it('rejects sends before open and after close', () => {
  const { PinnedWebSocket } = load()
  const socket = new PinnedWebSocket('wss://mac', fp)
  expect(() => socket.send('early')).toThrow(/not open/)
  socket.close()
  expect(() => socket.send('late')).toThrow(/not open/)
})
