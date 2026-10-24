/**
 * Archive from the agent settings sheet goes back to the chat list once the
 * backend confirms it, and not when the user already left the chat.
 */
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { AppChannels } from '@shared/ipc-channels'
import { DemoTransport } from '@shared/phone-demo/phone-demo'
import { AgentSettingsSheet } from '../../components/AgentSettingsSheet'
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

let confirmArchive: (answer: { ok: boolean; archived: boolean }) => void = () => {}

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = DemoTransport.prototype as any
  const answer = proto.answer
  jest.spyOn(proto, 'answer').mockImplementation(function (this: unknown, channel: unknown, args: unknown) {
    if (channel === AppChannels.ARCHIVE_CONVERSATION) {
      return new Promise((resolve) => {
        confirmArchive = resolve
      })
    }
    return answer.call(this, channel, args)
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
  const navigation = {
    navigate: jest.fn(),
    replace: jest.fn(),
    goBack: jest.fn(),
    setOptions: jest.fn(),
    addListener: () => () => {},
  }
  let tree: TestRenderer.ReactTestRenderer | undefined
  act(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tree = TestRenderer.create(<ThreadScreen navigation={navigation as any} route={route as any} />)
  })
  await settle()
  const renderer = tree as TestRenderer.ReactTestRenderer
  const archive = () => act(() => renderer.root.findByType(AgentSettingsSheet).props.onArchive())
  return { renderer, navigation, archive }
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('archiving a chat', () => {
  it('goes back once the backend confirms the archive', async () => {
    const { renderer, navigation, archive } = await openChat()
    archive()
    confirmArchive({ ok: true, archived: true })
    await settle()
    expect(navigation.goBack).toHaveBeenCalledTimes(1)
    act(() => renderer.unmount())
  })

  it('does not go back when the user left the chat before the answer', async () => {
    const { renderer, navigation, archive } = await openChat()
    archive()
    act(() => renderer.unmount())
    confirmArchive({ ok: true, archived: true })
    await settle()
    expect(navigation.goBack).not.toHaveBeenCalled()
  })
})
