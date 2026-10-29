/**
 * The chat screen draws an approval that carries `secretRequest` as the
 * read-only secret card, with no Approve, whatever the handshake has said:
 * only a backend with agent_secret_request_v1 sends the field.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { renderComponent } from '../../test/render'
import { useConnectionsStore } from '../../stores/connections'
import { useChatStore } from '../../stores/chat'

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }))
jest.mock('expo-network', () => ({}))

beforeEach(() => useConnectionsStore.getState().startDemo())
afterEach(() => useConnectionsStore.getState().stopDemo())

it('shows the secret card, not the approval with Approve', async () => {
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
  act(() => {
    useChatStore.getState().ingestNow('demo', {
      type: 'request.opened',
      threadId: 'demo-done',
      requestId: 'sbsec_1',
      requestType: 'tool',
      toolName: 'mcp__switchboard__request_secret',
      detail: 'An agent asks for a secret. Answer it in Switchboard on your computer.',
      secretRequest: {
        name: 'TAILSCALE_AUTHKEY',
        title: 'Tailscale key',
        instructions: 'Open the admin page',
        ttl: '24h',
      },
    })
  })
  const texts = view.texts()
  expect(texts).toContain('Answer this on your computer.')
  expect(texts).toContain('Decline')
  expect(texts).not.toContain('Approve')
})
