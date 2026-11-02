/**
 * The chat Details sheet: its header button shows only when the backend
 * advertises `details_sheet_v1`, and the sheet shows the reads it makes.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { DETAILS_SHEET_CAPABILITY } from '@shared/chat-details'
import { GitChannels, ProviderInstanceChannels } from '@shared/ipc-channels'
import { DemoTransport } from '@shared/phone-demo/phone-demo'
import { ChatDetailsSheet } from '../../components/ChatDetailsSheet'
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

let advertised = true

beforeEach(() => {
  advertised = true
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proto = DemoTransport.prototype as any
  const supports = proto.supportsCapability
  jest.spyOn(proto, 'supportsCapability').mockImplementation(function (this: unknown, capability: unknown) {
    return capability === DETAILS_SHEET_CAPABILITY ? advertised : supports.call(this, capability)
  })
  const answer = proto.answer
  jest.spyOn(proto, 'answer').mockImplementation(function (this: unknown, channel: unknown, args: unknown) {
    if (channel === GitChannels.CURRENT_BRANCH) return { ok: true, branch: 'feat/details' }
    if (channel === GitChannels.DIFF_STAT) return { ok: true, added: 14, removed: 3 }
    if (channel === ProviderInstanceChannels.USAGE) {
      return {
        status: 'ok',
        windows: [
          { kind: 'weekly', usedPercent: 85 },
          { kind: 'session', usedPercent: 95 },
        ],
      }
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
  const navigation = { navigate: jest.fn(), replace: jest.fn(), setOptions: jest.fn(), addListener: () => () => {} }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = renderComponent(<ThreadScreen navigation={navigation as any} route={route as any} />)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const { headerRight } = navigation.setOptions.mock.calls.at(-1)[0]
  return { view, header: renderComponent(headerRight()) }
}

describe('chat Details sheet', () => {
  it('shows no Details button on a backend without details_sheet_v1', async () => {
    advertised = false
    const { header } = await openChat()
    expect(() => header.byLabel('Chat details')).toThrow()
  })

  it('opens from the header and shows the branch, changes and usage left', async () => {
    const { view, header } = await openChat()
    await act(async () => {
      header.byLabel('Chat details').props.onPress()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(view.root.findByType(ChatDetailsSheet).props.visible).toBe(true)
    const text = view.texts().join('|')
    expect(text).toContain('feat/details')
    expect(text).toContain('Changes|+14|-3')
    expect(text).toContain('Weekly|15% left')
    expect(text).toContain('5-hour session|5% left')
    expect(view.byLabel('Context, unavailable')).toBeTruthy()
  })
})
