/**
 * Demo mode on the Expo app: "Try the demo" on the empty Connections screen
 * opens the demo project, every demo screen carries the strip, Leave demo
 * drops the demo's state, and nothing from the demo reaches storage.
 */
import React from 'react'
import { Alert, Text } from 'react-native'
import { act } from 'react-test-renderer'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEMO_CONNECTION_ID, NOT_IN_DEMO } from '@shared/phone-demo/phone-demo'
import ConnectionsScreen from '../ConnectionsScreen'
import { withDemoStrip } from '../../components/DemoStrip'
import { renderComponent } from '../../test/render'
import { getClient, useConnectionsStore } from '../../stores/connections'
import { useChatStore } from '../../stores/chat'
import { usePrefsStore } from '../../stores/prefs'
import { saveQueued } from '../../lib/outbox-storage'
import type { QueuedMessage } from '../../lib/outbox-model'
import { useDictation, type Dictation } from '../../hooks/useDictation'
import { ensureVoicePermission } from '../../lib/voice'

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNavigation,
  useFocusEffect: () => undefined,
}))
jest.mock('../../lib/google-auth', () => ({
  warmUpGoogleAuth: async () => undefined,
  getSignedInEmail: async () => null,
}))
jest.mock('expo-network', () => ({}))

const mockNavigation = { navigate: jest.fn(), setOptions: jest.fn(), reset: jest.fn() }

/** Render, then let the screen's start-up reads settle inside act. */
async function renderConnections() {
  const view = renderComponent(<ConnectionsScreen />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return view
}

function pressAlertButton(text: string): void {
  const buttons = jest.mocked(Alert.alert).mock.calls.at(-1)?.[2] ?? []
  act(() => buttons.find((b) => b.text === text)?.onPress?.())
}

beforeEach(() => {
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined)
  useConnectionsStore.setState({ configs: [] })
})

afterEach(() => {
  if (useConnectionsStore.getState().demoActive) useConnectionsStore.getState().stopDemo()
  jest.restoreAllMocks()
})

describe('Try the demo', () => {
  it('sits under Scan a pairing QR and opens the demo project', async () => {
    const view = await renderConnections()
    const texts = view.texts()
    expect(texts.indexOf('Try the demo')).toBeGreaterThan(texts.indexOf('Scan a pairing QR'))
    expect(texts).toContain(
      'Sample chats and pull requests on this phone. No machine needed, nothing is sent anywhere.',
    )

    act(() => view.root.findByProps({ testID: 'try-demo' }).props.onPress())
    expect(useConnectionsStore.getState().demoActive).toBe(true)
    expect(useConnectionsStore.getState().status[DEMO_CONNECTION_ID]).toBe('connected')
    expect(getClient(DEMO_CONNECTION_ID)).toBeDefined()
    // Never a saved machine.
    expect(useConnectionsStore.getState().configs).toEqual([])
    expect(mockNavigation.navigate.mock.calls).toEqual([
      ['Projects', { connectionId: 'demo', label: 'Demo machine' }],
      ['Conversations', { connectionId: 'demo', projectPath: '/demo/acme-console', projectName: 'acme-console' }],
    ])
  })

  it('offers Leave demo on the Connections screen while the demo is open', async () => {
    useConnectionsStore.getState().startDemo()
    const view = await renderConnections()
    expect(view.texts()).toContain('Back to the demo')
    act(() => view.root.findByProps({ testID: 'settings-leave-demo' }).props.onPress())
    pressAlertButton('Leave demo')
    expect(useConnectionsStore.getState().demoActive).toBe(false)
    expect(getClient(DEMO_CONNECTION_ID)).toBeUndefined()
  })
})

describe('the demo strip', () => {
  function Screen() {
    return <Text>screen body</Text>
  }
  const Wrapped = withDemoStrip(Screen)
  const Blocked = withDemoStrip(Screen, { notInDemo: true })
  const navigation = { reset: jest.fn() }

  it('marks demo screens only', () => {
    const demo = renderComponent(<Wrapped route={{ params: { connectionId: 'demo' } }} navigation={navigation} />)
    expect(demo.texts()).toEqual(expect.arrayContaining(['Demo', 'Leave demo', 'screen body']))
    const real = renderComponent(<Wrapped route={{ params: { connectionId: 'mac' } }} navigation={navigation} />)
    expect(real.root.findAllByProps({ testID: 'demo-strip' })).toEqual([])
    expect(real.texts()).toEqual(['screen body'])
  })

  it('shows a note instead of a flow the demo cannot run', () => {
    const view = renderComponent(<Blocked route={{ params: { connectionId: 'demo' } }} navigation={navigation} />)
    expect(view.texts()).toContain(NOT_IN_DEMO)
    expect(view.texts()).not.toContain('screen body')
  })

  it('Leave demo asks, then drops the demo and goes back to Connections', () => {
    useConnectionsStore.getState().startDemo()
    useChatStore.getState().addNotice('demo:demo-done', 'sample')
    useChatStore.getState().addNotice('mac:t1', 'real')
    usePrefsStore.getState().rememberDraft('demo:demo-done', 'draft')

    const view = renderComponent(<Wrapped route={{ params: { connectionId: 'demo' } }} navigation={navigation} />)
    act(() => view.root.findByProps({ testID: 'demo-leave' }).props.onPress())
    expect(jest.mocked(Alert.alert).mock.calls[0][0]).toBe('Leave the demo?')
    pressAlertButton('Stay')
    expect(useConnectionsStore.getState().demoActive).toBe(true)

    act(() => view.root.findByProps({ testID: 'demo-leave' }).props.onPress())
    pressAlertButton('Leave demo')
    expect(useConnectionsStore.getState().demoActive).toBe(false)
    expect(Object.keys(useChatStore.getState().threads)).toEqual(['mac:t1'])
    expect(usePrefsStore.getState().threads['demo:demo-done']).toBeUndefined()
    expect(navigation.reset).toHaveBeenCalledWith({ index: 0, routes: [{ name: 'Connections' }] })
  })
})

describe('nothing from the demo is stored', () => {
  it('keeps demo feeds, drafts and queued messages out of storage', async () => {
    const chatState = { ...useChatStore.getState() }
    chatState.threads = {
      'demo:demo-done': { ...useChatStore.getState().threads['mac:t1'] },
      'mac:t1': { ...useChatStore.getState().threads['mac:t1'] },
    }
    const persisted = useChatStore.persist.getOptions().partialize?.(chatState) as { threads: object }
    expect(Object.keys(persisted.threads)).toEqual(['mac:t1'])

    usePrefsStore.getState().rememberDraft('demo:demo-done', 'demo draft')
    usePrefsStore.getState().rememberMode('demo:demo-done', 'full-access')
    const prefsWrites = jest.mocked(AsyncStorage.setItem).mock.calls.filter(([key]) => key === 'switchboard-prefs')
    expect(prefsWrites.length).toBeGreaterThan(0)
    expect(prefsWrites.at(-1)?.[1]).not.toContain('demo')
    expect(usePrefsStore.getState().defaultMode).not.toBe('full-access')

    jest.mocked(AsyncStorage.setItem).mockClear()
    await saveQueued({ messageId: 'q1', connectionId: 'demo', threadId: 'demo-done' } as QueuedMessage)
    expect(AsyncStorage.setItem).not.toHaveBeenCalled()
  })
})

describe('voice in the demo', () => {
  it('says it is not in the demo and never asks for the microphone', async () => {
    const onNote = jest.fn()
    let dictation: Dictation | undefined
    function Probe() {
      dictation = useDictation({ draft: '', onDraft: jest.fn(), onNote, unavailableNote: NOT_IN_DEMO })
      return null
    }
    renderComponent(<Probe />)
    await act(async () => {
      expect(await dictation?.start()).toBe(false)
    })
    expect(onNote).toHaveBeenCalledWith({ message: NOT_IN_DEMO })
    expect(ensureVoicePermission).not.toHaveBeenCalled()
  })
})
