/**
 * Native modules the app touches at import time, stubbed.
 *
 * Each of these reaches a native binary that does not exist in a node test.
 * Stubbing them here rather than per-file keeps the tests about the UI.
 */
// The native animation driver does not exist in a node test, and any
// `useNativeDriver: true` animation throws on start. Path moved in RN 0.86.
jest.mock('react-native/src/private/animated/NativeAnimatedHelper')

// Icons reach expo-font -> expo-asset, which is native and not installed here.
// They carry no behaviour, so a stub keeps the render surface small. The name is
// exposed so a test can assert WHICH icon was chosen.
jest.mock('@expo/vector-icons', () => {
  const { Text } = require('react-native')
  const React = require('react')
  return {
    Ionicons: ({ name }) => React.createElement(Text, { testID: `icon-${name}` }, name),
  }
})

// Persisted stores: zustand's persist middleware writes on every set().
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map()
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k) => store.get(k) ?? null),
      setItem: jest.fn(async (k, v) => void store.set(k, v)),
      removeItem: jest.fn(async (k) => void store.delete(k)),
    },
  }
})

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[test]' })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  AndroidImportance: { HIGH: 4, MAX: 5 },
}))

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(async () => ({ canceled: true, assets: [] })),
}))

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'test-project' } } } },
}))

jest.mock('expo-application', () => ({ nativeApplicationVersion: '0.2.0' }))

// Voice: isVoiceAvailable() gates the mic, so it must answer deterministically.
//
// A PARTIAL mock. Only the three functions that reach expo-speech-recognition
// are replaced; joinDraft is pure and keeps its real implementation. A
// hand-written stand-in here diverged from it in two cases (empty transcript,
// and a base already ending in whitespace), which is the shape of stub that
// makes a future test pass while production is wrong.
jest.mock('./src/lib/voice', () => ({
  ...jest.requireActual('./src/lib/voice'),
  isVoiceAvailable: jest.fn(() => true),
  ensureVoicePermission: jest.fn(async () => true),
  startListening: jest.fn(() => ({ stop: jest.fn() })),
}))
