// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Combobox } from '../../src/renderer/components/ui/combobox'
import type { ComboboxOption } from '../../src/renderer/components/ui/combobox-options'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
const scrolled: HTMLElement[] = []
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const onValueChange = vi.fn()
const options: ComboboxOption[] = [
  { value: 'first', label: 'switchboard', group: 'Recent', keywords: ['/u/projects/switchboard'] },
  { value: 'prefix', label: 'projects-site', group: 'Recent' },
  { value: 'current', label: 'scout', group: 'Other', keywords: ['/u/projects/scout'] },
  { value: 'exact', label: 'projects', group: 'Other' },
]

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this)
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  scrolled.length = 0
  onValueChange.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function render(open = true, searchable = true, highlightFirstOnOpen = true) {
  await act(async () =>
    root.render(
      createElement(Combobox, {
        value: 'current',
        options,
        open,
        searchable,
        highlightFirstOnOpen,
        onValueChange,
      }),
    ),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}
async function type(query: string) {
  const input = document.querySelector<HTMLInputElement>('[cmdk-input]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, query)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
}
const rows = () => [...document.querySelectorAll<HTMLElement>('[cmdk-item]')]
const highlighted = () => document.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')

function expectTop(value: string) {
  expect(rows()[0].dataset.value).toBe(value)
  expect(highlighted()).toBe(rows()[0])
  expect(scrolled).toContain(rows()[0])
}

describe('Combobox search selection', () => {
  it('highlights and scrolls to the top row on open, including a controlled reopen', async () => {
    await render()
    expectTop('first')
    await type('projects')
    await render(false)
    scrolled.length = 0
    await render()
    expectTop('first')
  })

  it('keeps ranked results in order across groups and picks the exact name on Enter', async () => {
    await render()
    await type('projects')
    expectTop('exact')
    expect(rows().map((row) => row.dataset.value)).toEqual(['exact', 'prefix', 'first', 'current'])
    await act(async () => {
      document
        .querySelector('[cmdk-input]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onValueChange).toHaveBeenCalledWith('exact')
  })

  it('returns to the top result after keyboard navigation and another query', async () => {
    await render()
    await type('proj')
    await act(async () => {
      document
        .querySelector('[cmdk-input]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    await type('projects')
    expectTop('exact')
    await type('')
    expectTop('first')
    await type('no-match')
    expect(rows()).toEqual([])
  })

  it('scrolls a remounted selected row when the selected value stays the same', async () => {
    await render()
    const previous = highlighted()
    scrolled.length = 0
    await type('switchboard')
    expect(highlighted()).not.toBe(previous)
    expectTop('first')
    scrolled.length = 0
    await type('SWITCHBOARD')
    expectTop('first')
    scrolled.length = 0
    await type('')
    expectTop('first')
  })

  it('scrolls the highlighted search result even when animation frames have not run', async () => {
    await render()
    scrolled.length = 0
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    await type('projects')
    expectTop('exact')
  })

  it('keeps the current value on open in other searchable settings pickers', async () => {
    await render(true, true, false)
    expect(highlighted()?.dataset.value).toBe('current')
    await type('projects')
    expectTop('exact')
  })

  it('keeps the chosen value highlighted for a non-searchable select', async () => {
    await render(true, false)
    expect(highlighted()?.dataset.value).toBe('current')
  })
})
