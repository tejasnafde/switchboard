// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { renderCounts, resetRenderCounts, useRenderCount } from '../../src/renderer/services/render-counter'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(resetRenderCounts)

it('counts each render under its name and clears on reset', () => {
  let bump = () => {}
  function Counted() {
    useRenderCount('Counted')
    const [n, setN] = useState(0)
    bump = () => setN(n + 1)
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(createElement(Counted)))
  act(() => bump())
  expect(renderCounts()).toEqual({ Counted: 2 })
  expect(window.__sbRenderCounts?.()).toEqual({ Counted: 2 })
  resetRenderCounts()
  expect(renderCounts()).toEqual({})
  act(() => root.unmount())
})
