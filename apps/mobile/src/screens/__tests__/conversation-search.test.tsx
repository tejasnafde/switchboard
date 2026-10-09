/**
 * The search box at the top of a project's chat list ranks with the shared
 * Go to chat rules (`@shared/chat-search`); an empty box keeps today's list.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { TextInput } from 'react-native'
import ConversationsScreen from '../ConversationsScreen'
import { renderComponent } from '../../test/render'

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})

const titles = [
  'Fix sync jitter', 'Review #612', 'Sync backoff cap', 'Landing copy pass', 'Android parity',
  'Notebook sync engine', 'sync', 'Docs pass', 'Release notes',
]
const mockRows = titles.map((title, i) => ({
  id: `c${i}`, project_path: '/p', agent_type: 'claude-code', session_id: null, title,
  created_at: 0, updated_at: 1000 - i,
}))

jest.mock('../../stores/connections', () => ({
  getClient: () => ({ getConversations: () => Promise.resolve(mockRows) }),
}))

const navigation = { setOptions: jest.fn(), navigate: jest.fn() }
const route = { params: { connectionId: 'conn', projectPath: '/p', projectName: 'switchboard' } }

async function renderScreen() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = renderComponent(<ConversationsScreen navigation={navigation as any} route={route as any} />)
  await act(async () => { await Promise.resolve() })
  return view
}

const shownTitles = (texts: string[]) => texts.filter((t) => titles.includes(t))

describe('ConversationsScreen search', () => {
  it('lists every chat newest first with an empty box', async () => {
    const view = await renderScreen()
    expect(shownTitles(view.texts())).toEqual(titles)
  })

  it('ranks exact, then starts with, then contains', async () => {
    const view = await renderScreen()
    const input = view.root.findByType(TextInput)
    act(() => { input.props.onChangeText('SYNC') })
    expect(shownTitles(view.texts())).toEqual(['sync', 'Sync backoff cap', 'Fix sync jitter', 'Notebook sync engine'])
  })

  it('says nothing matched', async () => {
    const view = await renderScreen()
    act(() => { view.root.findByType(TextInput).props.onChangeText('zzz') })
    expect(view.texts()).toContain('No matches')
  })
})
