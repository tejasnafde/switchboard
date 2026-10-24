/**
 * A project's chat list groups into Needs you, Working and Done recently
 * while any chat needs you or works, each header with a plain count, and
 * stays one plain list otherwise. The rule itself is tested in
 * tests/unit/mobile-chat-activity.test.ts.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import ConversationsScreen from '../ConversationsScreen'
import { useChatStore, threadKey, emptyThread, type ThreadState } from '../../stores/chat'
import { renderComponent } from '../../test/render'

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual('react')
  return { useFocusEffect: (effect: () => void) => useEffect(effect, [effect]) }
})

const titles = ['Fix login', 'Add search', 'Ship docs', 'Tidy CSS']
const mockRows = titles.map((title, i) => ({
  id: `c${i}`,
  project_path: '/p',
  agent_type: 'claude-code',
  session_id: null,
  title,
  created_at: 0,
  updated_at: 1000 - i,
}))

jest.mock('../../stores/connections', () => ({
  getClient: () => ({ getConversations: () => Promise.resolve(mockRows), supportsCapability: () => undefined }),
}))

const navigation = { setOptions: jest.fn(), navigate: jest.fn() }
const route = { params: { connectionId: 'conn', projectPath: '/p', projectName: 'switchboard' } }

function setThreads(threads: Record<string, Partial<ThreadState>>) {
  act(() => {
    useChatStore.setState({
      threads: Object.fromEntries(
        Object.entries(threads).map(([id, t]) => [threadKey('conn', id), { ...emptyThread(), ...t }]),
      ),
    })
  })
}

async function renderScreen() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = renderComponent(<ConversationsScreen navigation={navigation as any} route={route as any} />)
  await act(async () => {
    await Promise.resolve()
  })
  return view
}

const HEADERS = ['NEEDS YOU', 'WORKING', 'DONE RECENTLY']
const shown = (texts: string[]) => texts.filter((t) => titles.includes(t) || HEADERS.includes(t) || /^\d+$/.test(t))

afterEach(() => {
  act(() => {
    useChatStore.setState({ threads: {} })
  })
})

describe('ConversationsScreen groups', () => {
  it('puts an open card and an error under Needs you, a running chat under Working', async () => {
    setThreads({
      c1: {
        status: 'idle',
        pendingRequests: [
          {
            type: 'request.opened',
            threadId: 'c1',
            requestId: 'r1',
            requestType: 'command',
            toolName: 'Bash',
            detail: 'ls',
          },
        ],
      },
      c2: { status: 'running' },
      c3: { status: 'error' },
    })
    const view = await renderScreen()
    expect(shown(view.texts())).toEqual([
      'NEEDS YOU',
      '2',
      'Add search',
      'Tidy CSS',
      'WORKING',
      '1',
      'Ship docs',
      'DONE RECENTLY',
      '1',
      'Fix login',
    ])
  })

  it('moves a chat when its card closes live', async () => {
    setThreads({ c0: { status: 'idle' } })
    const view = await renderScreen()
    act(() => {
      useChatStore.getState().ingestNow('conn', {
        type: 'request.opened',
        threadId: 'c0',
        requestId: 'r1',
        toolName: 'Bash',
        detail: 'ls',
      } as never)
    })
    expect(shown(view.texts()).slice(0, 3)).toEqual(['NEEDS YOU', '1', 'Fix login'])
    act(() => {
      useChatStore.getState().ingestNow('conn', { type: 'request.closed', threadId: 'c0', requestId: 'r1' } as never)
    })
    expect(view.texts()).not.toContain('NEEDS YOU')
  })

  it('stays one plain list when nothing needs you or works', async () => {
    setThreads({ c0: { status: 'idle' } })
    const view = await renderScreen()
    expect(shown(view.texts())).toEqual(titles)
  })
})
