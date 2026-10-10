// @vitest-environment jsdom
/**
 * Opening a message search hit hands the query to the chat's in-pane find
 * (cmd+F): the bar opens with the query typed in, its cursor on the chosen
 * message, and next/previous walk the chat's other matches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatMessage } from '../../src/shared/types'

vi.mock('../../src/renderer/services/history-loader', () => ({
  ensureFullHistory: vi.fn(async () => true),
}))

const { ensureFullHistory } = await import('../../src/renderer/services/history-loader')
const { useChatSearch } = await import('../../src/renderer/components/chat/useChatSearch')
const { InPaneSearchBar } = await import('../../src/renderer/components/InPaneSearchBar')
const { useAgentStore } = await import('../../src/renderer/stores/agent-store')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function message(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, timestamp: 1 } as ChatMessage
}

function Harness({ messages }: { messages: ChatMessage[] }) {
  const search = useChatSearch({ messages, sessionId: 's1', sessionIdOverride: undefined, chatSlot: 'primary' })
  return search.searchOpen
    ? createElement(InPaneSearchBar, {
        key: search.findPrefill?.stamp ?? 'find',
        initialValue: search.findPrefill?.query,
        onQuery: search.handleChatSearchQuery,
        onNext: search.handleChatSearchNext,
        onPrev: search.handleChatSearchPrev,
        onClose: search.handleChatSearchClose,
        matches: search.chatSearchMatchInfo,
      })
    : null
}

let root: Root | null = null
let container: HTMLDivElement

async function render(messages: ChatMessage[]) {
  await act(async () => {
    root!.render(createElement(Harness, { messages }))
  })
}

const scrolledTo = () => useAgentStore.getState().pendingScrollToMessage?.messageId
const counter = () => document.querySelector('input')?.parentElement?.querySelector('span')?.textContent
const button = (title: string) => document.querySelector<HTMLButtonElement>(`button[title^="${title}"]`)!

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useAgentStore.setState({ pendingChatFind: null, pendingScrollToMessage: null })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

describe('chat find prefill from message search', () => {
  const messages = [
    message('m1', 'the sync backoff has jitter'),
    message('m2', 'unrelated'),
    message('m3', 'sync jitter again'),
  ]

  it('opens the find bar with the query, on the chosen message', async () => {
    await render(messages)
    expect(document.querySelector('input')).toBeNull()

    await act(async () => {
      useAgentStore.getState().requestChatFind('s1', 'sync jitter', 'm3')
    })

    expect(document.querySelector('input')?.value).toBe('sync jitter')
    expect(counter()).toBe('2/2')
    expect(scrolledTo()).toBe('m3')
    expect(useAgentStore.getState().pendingScrollToMessage?.query).toBe('sync jitter')
    expect(useAgentStore.getState().pendingChatFind).toBeNull()

    await act(async () => { button('Next').click() })
    expect(scrolledTo()).toBe('m1')
    expect(counter()).toBe('1/2')
  })

  it('ignores a find meant for another chat', async () => {
    await render(messages)
    await act(async () => {
      useAgentStore.getState().requestChatFind('other', 'sync', 'm1')
    })
    expect(document.querySelector('input')).toBeNull()
    expect(useAgentStore.getState().pendingChatFind).not.toBeNull()
  })

  it('shows the chosen message first, then lands on it once the history holds it', async () => {
    await render(messages.slice(0, 2))
    await act(async () => {
      useAgentStore.getState().requestChatFind('s1', 'sync jitter', 'm3')
    })
    expect(scrolledTo()).toBe('m3')

    useAgentStore.setState({ pendingScrollToMessage: null })
    await render(messages)
    expect(counter()).toBe('2/2')
    expect(scrolledTo()).toBe('m3')
  })

  it('replaces the text of a bar that is already open', async () => {
    await render(messages)
    await act(async () => {
      useAgentStore.getState().requestChatFind('s1', 'unrelated', 'm2')
    })
    expect(document.querySelector('input')?.value).toBe('unrelated')
    // Two requests in one millisecond would share a stamp and not remount the bar.
    await new Promise((resolve) => setTimeout(resolve, 2))
    await act(async () => {
      useAgentStore.getState().requestChatFind('s1', 'jitter', 'm1')
    })
    expect(document.querySelector('input')?.value).toBe('jitter')
    expect(scrolledTo()).toBe('m1')
  })

  it('steps through the loaded matches when the full history fails to load', async () => {
    vi.mocked(ensureFullHistory).mockResolvedValueOnce(false)
    await render(messages.slice(0, 2))
    await act(async () => {
      useAgentStore.getState().requestChatFind('s1', 'sync jitter', 'm3')
    })
    expect(scrolledTo()).toBe('m1')
    expect(counter()).toBe('1/1')
  })
})
