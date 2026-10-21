// @vitest-environment jsdom
/**
 * Relative-time labels refresh from one shared minute tick, and the tick
 * re-renders the label only, never the row around it.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { RelativeTimeLabel } from '../../src/renderer/components/sidebar/RelativeTimeLabel'
import { renderCounts, resetRenderCounts, useRenderCount } from '../../src/renderer/services/render-counter'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-21T10:00:30Z'))
  resetRenderCounts()
})
afterEach(() => vi.useRealTimers())

function Row({ timestamp }: { timestamp: number }) {
  useRenderCount('Row')
  return createElement('div', null, createElement(RelativeTimeLabel, { timestamp }))
}

it('a minute tick updates the label without re-rendering the row', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const start = Date.now()
  act(() =>
    root.render(
      createElement('div', null, createElement(Row, { timestamp: start }), createElement(Row, { timestamp: start })),
    ),
  )
  expect(container.textContent).toBe('nownow')
  expect(vi.getTimerCount()).toBe(1)

  act(() => vi.advanceTimersByTime(60_000))
  expect(container.textContent).toBe('1m1m')
  expect(renderCounts()).toEqual({ Row: 2, RelativeTimeLabel: 4 })

  act(() => root.unmount())
  expect(vi.getTimerCount()).toBe(0)
})
