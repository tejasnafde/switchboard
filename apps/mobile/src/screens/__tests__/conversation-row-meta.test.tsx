/**
 * Line 2 of a conversation row: the live preview of a loaded thread, else the
 * status line the backend stored when the last turn ended.
 */
import React from 'react'
import { act } from 'react-test-renderer'
import { RowMeta } from '../ConversationsScreen'
import { useChatStore, threadKey, type ThreadState } from '../../stores/chat'
import { renderComponent } from '../../test/render'

const key = threadKey('conn', 't1')

afterEach(() => {
  act(() => { useChatStore.setState({ threads: {} }) })
})

describe('RowMeta', () => {
  it('shows the stored status line for a thread that is not loaded', () => {
    const v = renderComponent(<RowMeta threadKeyStr={key} title="Fix login" statusLine="Tests pass, PR open" />)
    expect(v.texts()).toContain('Tests pass, PR open')
  })

  it('prefers the live preview once the thread is loaded', () => {
    act(() => {
      useChatStore.setState({
        threads: {
          [key]: {
            items: [{ kind: 'text', id: 'a1', text: 'Now reading the router', stream: 'assistant', done: false }],
          } as unknown as ThreadState,
        },
      })
    })
    const v = renderComponent(<RowMeta threadKeyStr={key} title="Fix login" statusLine="Tests pass, PR open" />)
    expect(v.texts()).toContain('Now reading the router')
    expect(v.texts()).not.toContain('Tests pass, PR open')
  })

  it('prefers the stored line over a feed restored from disk', () => {
    act(() => {
      useChatStore.setState({
        threads: {
          [key]: {
            cached: true,
            items: [{ kind: 'text', id: 'a1', text: 'Yesterday reading the router', stream: 'assistant', done: true }],
          } as unknown as ThreadState,
        },
      })
    })
    const v = renderComponent(<RowMeta threadKeyStr={key} title="Fix login" statusLine="Tests pass, PR open" />)
    expect(v.texts()).toContain('Tests pass, PR open')
    const bare = renderComponent(<RowMeta threadKeyStr={key} title="Fix login" />)
    expect(bare.texts()).toContain('Yesterday reading the router')
  })

  it('shows no second line when there is neither', () => {
    const v = renderComponent(<RowMeta threadKeyStr={key} title="Fix login" />)
    expect(v.texts()).toEqual(['Fix login'])
  })
})
