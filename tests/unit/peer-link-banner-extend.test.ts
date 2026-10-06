// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PeerLinkBanner } from '../../src/renderer/components/chat/PeerLinkBanner'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

function extendButton(): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((b) => /Extend/.test(b.textContent ?? '')) as HTMLButtonElement
}

describe('PeerLinkBanner Extend', () => {
  it('shows a spinner while extending, then "Extended" for two seconds', async () => {
    let finish!: () => void
    const extendPeerLink = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    ;(window as unknown as { api: unknown }).api = {
      provider: {
        listPeerLinks: vi.fn(async () => [{ peerThreadId: 'peer', title: 'Worker A', used: 7, budget: 20, expiresAt: Date.now() + 60_000, windowMs: 1_800_000 }]),
        onPeerLinksChanged: vi.fn(() => () => {}),
        extendPeerLink,
        unlinkPeer: vi.fn(),
      },
    }
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => { root!.render(createElement(PeerLinkBanner, { sessionId: 's1' })) })
    await vi.waitFor(() => expect(extendButton()).toBeTruthy())

    vi.useFakeTimers()
    await act(async () => { extendButton().click() })
    expect(extendPeerLink).toHaveBeenCalledOnce()
    expect(extendButton().textContent).toBe('Extending')
    expect(extendButton().disabled).toBe(true)

    await act(async () => { finish() })
    expect(extendButton().textContent).toBe('Extended')
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(extendButton().textContent).toBe('Extend (+20)')
  })
})
