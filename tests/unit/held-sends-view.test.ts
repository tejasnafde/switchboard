// @vitest-environment jsdom
/**
 * While a chat opens its message list is hidden, so the panel lists held
 * sends from useHeldSends. The chat may have no store entry yet.
 */
import { afterEach, expect, it } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { cancelHeldSend, holdSend, resetHeldSendsForTests, useHeldSends } from '../../src/renderer/services/held-sends'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => resetHeldSendsForTests())

it('shows a send held for an opening chat and drops it on Cancel', () => {
  function View() {
    return createElement(
      'p',
      null,
      useHeldSends('opening')
        .map((send) => send.message)
        .join(','),
    )
  }
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => root.render(createElement(View)))
  expect(container.textContent).toBe('')
  let id = ''
  act(() => {
    holdSend('opening', { message: 'first' })
    id = holdSend('opening', { message: 'second' })
  })
  expect(container.textContent).toBe('first,second')
  act(() => {
    cancelHeldSend('opening', id)
  })
  expect(container.textContent).toBe('first')
  act(() => root.unmount())
})
