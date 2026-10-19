import * as SecureStore from 'expo-secure-store'

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => '0b6f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b') }))
jest.mock('expo-application', () => ({ nativeApplicationVersion: '0.4.1' }))
jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>()
  return {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'this-device-only',
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => {
      store.set(key, value)
    }),
  }
})

const INSTALL_ID = '0b6f3a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'

describe('device identity payload', () => {
  it('names an iPhone by its device class, with the OS and app versions', () => {
    const { deviceIdentityFrom } = require('../device-identity') as typeof import('../device-identity')
    expect(
      deviceIdentityFrom(INSTALL_ID, { os: 'ios', osVersion: '26.1', interfaceIdiom: 'phone', appVersion: '0.4.1' }),
    ).toEqual({
      installId: INSTALL_ID,
      name: 'iPhone',
      manufacturer: 'Apple',
      model: 'iPhone',
      platform: 'ios',
      osVersion: '26.1',
      appVersion: '0.4.1',
    })
    expect(deviceIdentityFrom(INSTALL_ID, { os: 'ios', interfaceIdiom: 'pad' })?.model).toBe('iPad')
  })

  it('uses the Android model as the name', () => {
    const { deviceIdentityFrom } = require('../device-identity') as typeof import('../device-identity')
    expect(
      deviceIdentityFrom(INSTALL_ID, { os: 'android', osVersion: 16, manufacturer: 'Google', model: 'Pixel 9' }),
    ).toMatchObject({ name: 'Pixel 9', manufacturer: 'Google', model: 'Pixel 9', platform: 'android', osVersion: '16' })
  })

  it('sends nothing for an unknown platform or an unusable install id', () => {
    const { deviceIdentityFrom } = require('../device-identity') as typeof import('../device-identity')
    expect(deviceIdentityFrom(INSTALL_ID, { os: 'web' })).toBeNull()
    expect(deviceIdentityFrom('', { os: 'ios' })).toBeNull()
  })
})

describe('loadDeviceIdentity', () => {
  beforeEach(() => {
    jest.resetModules()
  })

  it('mints the install id and keeps it on this device only', async () => {
    const { loadDeviceIdentity, loadedDeviceIdentity } =
      require('../device-identity') as typeof import('../device-identity')
    expect(loadedDeviceIdentity()).toBeUndefined()
    const identity = await loadDeviceIdentity()
    expect(identity?.installId).toBe(INSTALL_ID)
    expect(identity?.appVersion).toBe('0.4.1')
    expect(loadedDeviceIdentity()).toEqual({ identity })
    const SecureStoreMock = require('expo-secure-store') as typeof SecureStore
    expect(SecureStoreMock.setItemAsync).toHaveBeenCalledWith('sb-install-id', INSTALL_ID, {
      keychainAccessible: 'this-device-only',
    })
  })

  it('resolves null rather than rejecting when the keystore fails', async () => {
    const SecureStoreMock = require('expo-secure-store') as typeof SecureStore
    ;(SecureStoreMock.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('locked'))
    const { loadDeviceIdentity, loadedDeviceIdentity } =
      require('../device-identity') as typeof import('../device-identity')
    await expect(loadDeviceIdentity()).resolves.toBeNull()
    expect(loadedDeviceIdentity()).toEqual({ identity: null })
  })
})
