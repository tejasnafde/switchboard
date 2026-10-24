/**
 * The message search screen: Android's copy for each state, the 200 ms
 * debounce, one row per hit, and a tap that opens the chat.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { TextInput } from 'react-native'
import type { MessageSearchResult } from '@shared/message-search'
import MessageSearchScreen from '../MessageSearchScreen'
import { renderComponent } from '../../test/render'

const mockSearch = jest.fn<Promise<MessageSearchResult[]>, [string]>()
jest.mock('../../stores/connections', () => ({
  getClient: () => ({ searchMessages: (query: string) => mockSearch(query) }),
  useConnectionsStore: (select: (s: { configs: { id: string; label: string }[] }) => unknown) =>
    select({ configs: [{ id: 'conn', label: 'Studio Mac' }] }),
}))

const hit: MessageSearchResult = {
  messageId: 'm1',
  conversationId: 'c1',
  role: 'assistant',
  content: 'full',
  snippet: '...the **sync** loop...',
  conversationTitle: 'Fix sync jitter',
  projectPath: '/Users/t/switchboard',
  agentType: 'codex',
  worktreePath: '/wt',
  worktreeBranch: null,
}

const navigation = { navigate: jest.fn(), setOptions: jest.fn() }
const route = { params: { connectionId: 'conn' } }

function renderScreen() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return renderComponent(<MessageSearchScreen navigation={navigation as any} route={route as any} />)
}

async function type(view: ReturnType<typeof renderScreen>, text: string) {
  act(() => view.root.findByType(TextInput).props.onChangeText(text))
  await act(async () => {
    jest.advanceTimersByTime(200)
    await Promise.resolve()
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  mockSearch.mockReset()
  navigation.navigate.mockReset()
  navigation.setOptions.mockReset()
})
afterEach(() => jest.useRealTimers())

describe('MessageSearchScreen', () => {
  it('names the machine it searches in the header', () => {
    renderScreen()
    const { headerTitle } = navigation.setOptions.mock.calls[0][0]
    const header = renderComponent(headerTitle())
    expect(header.texts()).toEqual(['Search chats', 'Studio Mac'])
  })

  it('asks for two characters and does not search one', async () => {
    const view = renderScreen()
    expect(view.texts()).toContain('Search every chat')
    await type(view, 's')
    expect(mockSearch).not.toHaveBeenCalled()
    expect(view.texts()).toContain('Enter at least two characters to search messages on this machine.')
  })

  it('waits for the debounce, sends only the last query, and opens a hit', async () => {
    mockSearch.mockResolvedValue([hit])
    const view = renderScreen()
    act(() => view.root.findByType(TextInput).props.onChangeText('sy'))
    act(() => jest.advanceTimersByTime(100))
    await type(view, ' sync ')
    expect(mockSearch).toHaveBeenCalledTimes(1)
    expect(mockSearch).toHaveBeenCalledWith('sync')
    expect(view.texts()).toEqual(
      expect.arrayContaining(['Fix sync jitter', 'the sync loop', 'switchboard · Assistant']),
    )
    act(() => view.root.findByProps({ testID: 'search-row-c1:m1' }).props.onPress())
    expect(navigation.navigate).toHaveBeenCalledWith('Thread', {
      connectionId: 'conn',
      threadId: 'c1',
      title: 'Fix sync jitter',
      projectPath: '/Users/t/switchboard',
      worktreePath: '/wt',
      worktreeBranch: undefined,
    })
  })

  it('says nothing matched', async () => {
    mockSearch.mockResolvedValue([])
    const view = renderScreen()
    await type(view, 'zzz')
    expect(view.texts()).toContain('No matches')
    expect(view.texts().join('')).toContain('No saved message contains “zzz”.')
  })

  it('shows the error and retries', async () => {
    mockSearch.mockRejectedValueOnce(new Error('invoke timed out: app:search-messages'))
    const view = renderScreen()
    await type(view, 'sync')
    expect(view.texts()).toEqual(expect.arrayContaining(['Search unavailable', 'Search timed out. Retry.']))
    mockSearch.mockResolvedValue([hit])
    await act(async () => {
      view.root.findByProps({ testID: 'search-retry' }).props.onPress()
      await Promise.resolve()
    })
    expect(mockSearch).toHaveBeenCalledTimes(2)
    expect(view.texts()).toContain('Fix sync jitter')
    expect(view.byLabel('Fix sync jitter, the sync loop, switchboard · Assistant').props.accessibilityRole).toBe(
      'button',
    )
  })

  it('drops a late answer to an older query', async () => {
    let resolveOld: (r: MessageSearchResult[]) => void = () => {}
    mockSearch.mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
    mockSearch.mockResolvedValueOnce([])
    const view = renderScreen()
    await type(view, 'sync')
    await type(view, 'zzz')
    await act(async () => {
      resolveOld([hit])
      await Promise.resolve()
    })
    expect(view.texts()).not.toContain('Fix sync jitter')
    expect(view.texts()).toContain('No matches')
  })
})
