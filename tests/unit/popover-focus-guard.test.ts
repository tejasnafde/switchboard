// @vitest-environment jsdom
/**
 * Switching to another app moves focus onto a Radix focus guard at the edge
 * of <body>. That must not close an open popover, which it did (the provider
 * picker screenshot flake). Focus on a real element outside still closes it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Popover, PopoverContent, PopoverTrigger } from '../../src/renderer/components/ui/popover'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver

let root: Root
let container: HTMLDivElement

function Harness() {
  const [open, setOpen] = useState(true)
  return createElement('div', null,
    createElement('button', { id: 'outside' }, 'outside'),
    createElement(Popover, { open, onOpenChange: setOpen },
      createElement(PopoverTrigger, null, 'trigger'),
      createElement(PopoverContent, { 'aria-label': 'picker' }, createElement('input', { id: 'search' })),
    ),
  )
}

beforeEach(async () => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(createElement(Harness)))
  // Radix installs its focus-outside listener on the next tick.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  document.getElementById('search')?.focus()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const picker = () => document.querySelector('[role="dialog"][aria-label="picker"]')

describe('PopoverContent', () => {
  it('stays open when focus lands on a Radix focus guard', async () => {
    const guard = document.querySelector<HTMLElement>('[data-radix-focus-guard]')
    expect(guard).not.toBeNull()
    await act(async () => guard!.focus())
    expect(picker()).not.toBeNull()
  })

  it('still closes when focus moves to a real element outside', async () => {
    await act(async () => document.getElementById('outside')!.focus())
    expect(picker()).toBeNull()
  })
})
