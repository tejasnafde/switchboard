// @vitest-environment jsdom
/**
 * One chat streaming must not re-render the composer of another chat, nor the
 * command palette that stays mounted while closed. Both used to subscribe to
 * the whole `sessions` array, which changes on every streamed token.
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// Every preload call resolves to an empty list; every `onX` subscription returns an unsubscribe.
function stubApi(): unknown {
  const call = () => Promise.resolve([])
  return new Proxy(call, {
    get: (_t, key) =>
      key === 'then' ? undefined : typeof key === 'string' && /^on[A-Z]/.test(key) ? () => () => {} : stubApi(),
    apply: call,
  })
}
;(window as unknown as { api: unknown }).api = stubApi()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const { useAgentStore } = await import('../../src/renderer/stores/agent-store')
const { renderCounts, resetRenderCounts } = await import('../../src/renderer/services/render-counter')
const { ChatInput } = await import('../../src/renderer/components/chat/ChatInput')
const { CommandPalette } = await import('../../src/renderer/components/CommandPalette')

let root: Root

beforeEach(async () => {
  for (const id of ['a', 'b', 'c']) {
    useAgentStore.getState().addSession({
      id,
      agentType: 'claude-code',
      status: 'idle',
      projectPath: '/tmp/p',
      title: id,
      startedAt: 0,
    })
  }
  useAgentStore.getState().appendMessage('a', { id: 'm1', role: 'assistant', content: '', timestamp: 1 })
  root = createRoot(document.createElement('div'))
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        createElement(ChatInput, { key: 'b', sessionId: 'b', onSend: async () => ({ accepted: true }) }),
        createElement(CommandPalette, { key: 'p', open: false, onClose: () => {} }),
      ),
    )
  })
  resetRenderCounts()
})

afterEach(() => act(() => root.unmount()))

it('streaming into chat a re-renders neither chat b composer nor the closed palette', () => {
  for (let i = 1; i <= 100; i++) {
    act(() => {
      useAgentStore.getState().updateStatus('a', 'running')
      useAgentStore.getState().updateMessage('a', 'm1', { content: 'x'.repeat(i) })
    })
  }
  expect(renderCounts()).toEqual({})
})

it('a rename re-renders the palette but not the other composer', () => {
  act(() => useAgentStore.getState().setTitle('a', 'renamed'))
  expect(renderCounts()).toEqual({ CommandPalette: 1 })
})
