/**
 * The real screens render the demo's bundled data through the demo client, so
 * a reviewer sees the sample project's chats and the sample pull requests.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import ConversationsScreen from '../ConversationsScreen'
import ReviewsScreen from '../ReviewsScreen'
import { renderComponent } from '../../test/render'
import { useConnectionsStore } from '../../stores/connections'
import { useReviewsStore } from '../../stores/reviews'

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
jest.mock('expo-network', () => ({}))

const navigation = { navigate: jest.fn(), replace: jest.fn(), setOptions: jest.fn() }

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  useReviewsStore.setState({ byConnection: {} })
  useConnectionsStore.getState().startDemo()
})
afterEach(() => useConnectionsStore.getState().stopDemo())

describe('demo screens', () => {
  it('lists the three sample chats', async () => {
    const route = { params: { connectionId: 'demo', projectPath: '/demo/acme-console', projectName: 'acme-console' } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = renderComponent(<ConversationsScreen navigation={navigation as any} route={route as any} />)
    await settle()
    expect(view.texts()).toEqual(
      expect.arrayContaining([
        'Run the test suite after the fix',
        'Add pagination to the orders table',
        'Retry uploads when a signed URL expires',
      ]),
    )
  })

  it('lists the sample pull requests on the Reviews tab', async () => {
    const route = { params: { connectionId: 'demo', label: 'Demo machine' } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = renderComponent(<ReviewsScreen navigation={navigation as any} route={route as any} />)
    await settle()
    expect(view.texts()).toEqual(expect.arrayContaining(['Fix rounding in invoice totals', 'NEEDS YOU']))
  })
})

jest.mock('@react-navigation/elements', () => ({ useHeaderHeight: () => 0 }))

describe('demo thread', () => {
  it('shows the Bash approval and plays the approve script', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ThreadScreen = require('../ThreadScreen').default
    const route = {
      params: {
        connectionId: 'demo',
        threadId: 'demo-approval',
        title: 'Run the test suite',
        projectPath: '/demo/acme-console',
      },
    }
    const view = renderComponent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <ThreadScreen navigation={{ ...navigation, addListener: () => () => undefined } as any} route={route as any} />,
    )
    await settle()
    // Once, though both the live event and the pending-request recovery carry it.
    expect(view.texts().filter((t) => t === 'Approval needed')).toHaveLength(1)
    expect(view.texts()).toContain('npm test -- src/billing')

    const approve = view.root.findAll((n) => n.props.children === 'Approve' && typeof n.type === 'string')[0]
    let button = approve.parent
    while (button && !button.props.onPress) button = button.parent
    await act(async () => {
      button?.props.onPress()
      await new Promise((resolve) => setTimeout(resolve, 3_000))
    })
    expect(view.texts()).toContain('Approved')
    expect(view.texts().some((t) => t.includes('All 12 billing tests pass'))).toBe(true)
  })
})

describe('demo finished turn', () => {
  it('renders the diagram and the file changes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ThreadScreen = require('../ThreadScreen').default
    const route = {
      params: {
        connectionId: 'demo',
        threadId: 'demo-done',
        title: 'Retry uploads',
        projectPath: '/demo/acme-console',
      },
    }
    const view = renderComponent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <ThreadScreen navigation={{ ...navigation, addListener: () => () => undefined } as any} route={route as any} />,
    )
    await settle()
    await settle()
    expect(view.texts()).toEqual(expect.arrayContaining(['Diagram', 'Changed 3 files']))
    expect(view.root.findAllByProps({ testID: 'webview' }).length).toBeGreaterThan(0)
  })
})
