/**
 * Opening a chat shows the profile and mode the desktop stored for it, not the
 * first profile and the default mode, and a mode picked here goes to the
 * backend, which stores it for the desktop.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { AppChannels, ProviderChannels, ProviderInstanceChannels } from '@shared/ipc-channels'
import { DemoTransport } from '@shared/phone-demo/phone-demo'
import { ModePicker } from '../../components/ModePicker'
import { renderComponent } from '../../test/render'
import { useConnectionsStore } from '../../stores/connections'

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }))
jest.mock('expo-network', () => ({}))

const profile = (id: string, displayName: string) => ({
  id,
  agentType: 'claude-code',
  displayName,
  accentColor: null,
  authMode: 'oauth_dir',
  envKeys: [],
  oauthDir: null,
  effectiveOauthDir: null,
  effectiveOauthDirSource: null,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
})

const calls: Array<{ channel: string; args: unknown[] }> = []

beforeEach(() => {
  calls.length = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = DemoTransport.prototype as any
  const answer = proto.answer
  jest.spyOn(proto, 'answer').mockImplementation(function (this: unknown, channel: unknown, args: unknown) {
    calls.push({ channel: channel as string, args: args as unknown[] })
    if (channel === ProviderInstanceChannels.LIST) {
      return [profile('claude-code-default', 'Default'), profile('claude-work', 'Work')]
    }
    const result = answer.call(this, channel, args)
    if (channel !== AppChannels.LOAD_SESSION_BY_ID) return result
    return { ...result, meta: { ...result.meta, runtimeMode: 'plan', providerInstanceId: 'claude-work' } }
  })
  useConnectionsStore.getState().startDemo()
})
afterEach(() => {
  useConnectionsStore.getState().stopDemo()
  jest.restoreAllMocks()
})

async function openChat() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ThreadScreen = require('../ThreadScreen').default
  const route = {
    params: { connectionId: 'demo', threadId: 'demo-done', title: 'Retry uploads', projectPath: '/demo/acme-console' },
  }
  const navigation = { navigate: jest.fn(), replace: jest.fn(), setOptions: jest.fn(), addListener: () => () => {} }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = renderComponent(<ThreadScreen navigation={navigation as any} route={route as any} />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return view
}

describe('opening a chat with stored settings', () => {
  it('shows the stored profile and mode', async () => {
    const view = await openChat()
    expect(view.texts()).toContain('Work')
    expect(view.texts()).not.toContain('Default')
    expect(view.root.findByType(ModePicker).props.value).toBe('plan')
  })

  it('sends a mode picked on the phone to the backend', async () => {
    const view = await openChat()
    await act(async () => {
      view.root.findByType(ModePicker).props.onChange('auto')
    })
    expect(calls).toContainEqual({ channel: ProviderChannels.SET_RUNTIME_MODE, args: ['demo-done', 'auto'] })
  })
})
