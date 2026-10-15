/**
 * A store build (App Store or TestFlight) never dials plain ws:// to a remote
 * host; internal builds keep today's behaviour. The build type comes from the
 * installed binary, so it is mocked here per test.
 */
import { Platform } from 'react-native'

let mockPinningAvailable = false
jest.mock('expo-modules-core', () => ({
  ...jest.requireActual('expo-modules-core'),
  requireOptionalNativeModule: () => (mockPinningAvailable ? {} : null),
}))

const mockReleaseType = jest.fn<Promise<number>, []>()
jest.mock('expo-application', () => ({
  nativeApplicationVersion: '0.4.1',
  ApplicationReleaseType: { UNKNOWN: 0, SIMULATOR: 1, ENTERPRISE: 2, DEVELOPMENT: 3, AD_HOC: 4, APP_STORE: 5 },
  getIosApplicationReleaseTypeAsync: () => mockReleaseType(),
}))
jest.mock('expo-network', () => ({}))
jest.mock('../../lib/google-auth', () => ({}))

const mockDialed: string[] = []
jest.mock('../../lib/api', () => ({
  SwitchboardClient: {
    overWs: (url: string) => {
      mockDialed.push(url)
      throw new Error('dial reached')
    },
  },
}))

type Gate = typeof import('../../lib/transport-gate')
type Store = typeof import('../connections')

function load(): { gate: Gate; store: Store } {
  let gate!: Gate
  let store!: Store
  jest.isolateModules(() => {
    gate = require('../../lib/transport-gate')
    store = require('../connections')
  })
  return { gate, store }
}

const APP_STORE = 5
const DEVELOPMENT = 3

beforeEach(() => {
  mockPinningAvailable = false
  mockDialed.length = 0
  mockReleaseType.mockReset()
  Platform.OS = 'ios'
})

describe('transportRefusal', () => {
  it('is unknown until the build type is read, then refuses only remote ws:// in a store build', async () => {
    mockReleaseType.mockResolvedValue(APP_STORE)
    const { gate } = load()
    expect(gate.transportRefusal('ws://192.168.1.8:8765')).toBeUndefined()
    await gate.storeBuildKnown()
    expect(gate.transportRefusal('ws://192.168.1.8:8765')).toMatch(/encrypted connection/)
    expect(gate.transportRefusal('ws://192.168.1.8:8765?fp=' + 'a'.repeat(64))).toMatch(/encrypted/)
    expect(gate.transportRefusal('ws://127.0.0.1:8765')).toBeNull()
    expect(gate.transportRefusal('ws://localhost:8765')).toBeNull()
    expect(gate.transportRefusal('wss://mac.tailnet.ts.net')).toBeNull()
  })

  it('lets an internal build keep plain ws://', async () => {
    mockReleaseType.mockResolvedValue(DEVELOPMENT)
    const { gate } = load()
    await gate.storeBuildKnown()
    expect(gate.transportRefusal('ws://192.168.1.8:8765')).toBeNull()
  })

  it('fails closed when the build type cannot be read', async () => {
    mockReleaseType.mockRejectedValue(new Error('no provisioning profile'))
    const { gate } = load()
    await gate.storeBuildKnown()
    expect(gate.transportRefusal('ws://192.168.1.8:8765')).toMatch(/encrypted/)
  })
})

describe('connect', () => {
  it('shows the refusal and never dials a remote ws:// machine in a store build', async () => {
    mockReleaseType.mockResolvedValue(APP_STORE)
    const { gate, store } = load()
    const s = store.useConnectionsStore
    s.getState().addConnection({ id: 'mac', kind: 'ws', label: 'Mac', url: 'ws://192.168.1.8:8765', session: 's' })
    s.getState().connect('mac')
    await gate.storeBuildKnown()
    await Promise.resolve()
    expect(mockDialed).toEqual([])
    expect(s.getState().status.mac).toBe('error')
    expect(s.getState().detail.mac).toMatch(/encrypted connection/)
  })

  it('dials as before in an internal build', async () => {
    mockReleaseType.mockResolvedValue(DEVELOPMENT)
    const { gate, store } = load()
    await gate.storeBuildKnown()
    const s = store.useConnectionsStore
    s.getState().addConnection({ id: 'mac', kind: 'ws', label: 'Mac', url: 'ws://192.168.1.8:8765', session: 's' })
    expect(() => s.getState().connect('mac')).toThrow('dial reached')
    expect(mockDialed).toEqual(['ws://192.168.1.8:8765'])
  })
})

it('allows a pinned remote connection in a store binary with the native module', async () => {
  mockPinningAvailable = true
  mockReleaseType.mockResolvedValue(APP_STORE)
  const { gate } = load()
  await gate.storeBuildKnown()
  expect(gate.transportRefusal('ws://192.168.1.8:8765?fp=' + 'a'.repeat(64))).toBeNull()
  expect(gate.transportRefusal('ws://192.168.1.8:8765')).toMatch(/encrypted/)
})

it('dials pinned wss from the store without changing the saved pairing URL', async () => {
  mockPinningAvailable = true
  mockReleaseType.mockResolvedValue(APP_STORE)
  const { gate, store } = load()
  await gate.storeBuildKnown()
  const s = store.useConnectionsStore
  const url = 'ws://192.168.1.8:8765?fp=' + 'a'.repeat(64)
  s.getState().addConnection({ id: 'mac', kind: 'ws', label: 'Mac', url, session: 's' })
  expect(() => s.getState().connect('mac')).toThrow('dial reached')
  expect(mockDialed).toEqual(['wss://192.168.1.8:8765/'])
  expect(s.getState().configs.find((c) => c.id === 'mac')).toMatchObject({ kind: 'ws', url })
})

it('rejects malformed pins before connecting without throwing or dialing', async () => {
  mockPinningAvailable = true
  mockReleaseType.mockResolvedValue(APP_STORE)
  const { gate, store } = load()
  await gate.storeBuildKnown()
  const s = store.useConnectionsStore
  s.getState().addConnection({ id: 'mac', kind: 'ws', label: 'Mac', url: 'ws://mac?fp=invalid', session: 's' })
  expect(() => s.getState().connect('mac')).not.toThrow()
  expect(mockDialed).toEqual([])
  expect(s.getState().status.mac).toBe('error')
  expect(s.getState().detail.mac).toMatch(/fingerprint/)
})
