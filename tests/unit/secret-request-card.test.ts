// @vitest-environment jsdom
/**
 * The desktop secret card: the value stays in an uncontrolled password input
 * (never in the DOM as text or in a prop), Save is off until the value fits,
 * keys stop at the card, Save clears the field and sends the trimmed value
 * once, an error keeps the card, and the result row becomes the saved line
 * with Extend and Delete now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ChatMessage } from '../../src/shared/types'
import { SecretRequestCard, SecretResultLine } from '../../src/renderer/components/chat/SecretRequestCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const VALUE = 'sb-test-not-a-secret'
const HOUR = 3_600_000

const api = {
  answer: vi.fn(),
  extend: vi.fn(),
  delete: vi.fn(),
  list: vi.fn(),
}

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  ;(window as unknown as { api: unknown }).api = { agentSecret: api }
  api.answer.mockResolvedValue({ ok: true })
  api.list.mockResolvedValue({ ok: true, secrets: [] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.useRealTimers()
})

function cardMessage(name = 'TAILSCALE_AUTHKEY', title = 'Tailscale auth key for test VMs'): ChatMessage {
  return {
    id: 'approval_sbsec_1',
    role: 'assistant',
    content: '',
    timestamp: 0,
    approval: {
      toolName: 'request_secret',
      detail: 'An agent asks for a secret.',
      status: 'pending',
      secretRequest: {
        name,
        title,
        instructions: 'Create it at https://login.tailscale.com/admin/settings/keys.',
        ttl: '24h',
      },
    },
  }
}

const input = () => container.querySelector('input') as HTMLInputElement
const button = (label: string) => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label)
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function type(value: string) {
  act(() => {
    input().value = value
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SecretRequestCard', () => {
  it('renders the header, title, instructions with the host in bold and a password field', () => {
    act(() => root.render(createElement(SecretRequestCard, { message: cardMessage(), sessionId: 'chat' })))
    expect(container.textContent).toContain('Asked by the agent in this chat')
    expect(container.textContent).not.toContain('Switchboard')
    expect(container.querySelector('b')?.textContent).toBe('login.tailscale.com')
    expect(input().type).toBe('password')
    expect(input().getAttribute('autocomplete')).toBe('new-password')
    expect(input().getAttribute('spellcheck')).toBe('false')
    expect(input().getAttribute('autocorrect')).toBe('off')
    expect(input().hasAttribute('value')).toBe(false)
    expect(container.querySelector('[data-testid="secret-footer"]')?.textContent).toBe(
      "Kept out of chat, in a private file this agent's commands can read for 24 hours.",
    )
    expect(button('Save securely').disabled).toBe(true)
  })

  it('turns Save on for a value, notes a trim, and keeps the value out of the markup', () => {
    act(() => root.render(createElement(SecretRequestCard, { message: cardMessage(), sessionId: 'chat' })))
    type(`${VALUE}  `)
    expect(button('Save securely').disabled).toBe(false)
    expect(container.textContent).toContain('Trimmed spaces at the end')
    expect(container.innerHTML).not.toContain(VALUE)
    type('   ')
    expect(button('Save securely').disabled).toBe(true)
  })

  it('stops keys at the card', () => {
    const seen = vi.fn()
    document.addEventListener('keydown', seen)
    document.addEventListener('keyup', seen)
    act(() => root.render(createElement(SecretRequestCard, { message: cardMessage(), sessionId: 'chat' })))
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    input().dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }))
    document.removeEventListener('keydown', seen)
    document.removeEventListener('keyup', seen)
    expect(seen).not.toHaveBeenCalled()
  })

  it('shows the value for 10 seconds, then masks it', () => {
    vi.useFakeTimers()
    act(() => root.render(createElement(SecretRequestCard, { message: cardMessage(), sessionId: 'chat' })))
    act(() => button('').click())
    expect(input().type).toBe('text')
    act(() => vi.advanceTimersByTime(10_000))
    expect(input().type).toBe('password')
  })

  it('clears the field and sends the trimmed value once', async () => {
    act(() => root.render(createElement(SecretRequestCard, { message: cardMessage(), sessionId: 'chat' })))
    type(`${VALUE}\n`)
    await act(async () => button('Save securely').click())
    expect(input().value).toBe('')
    expect(api.answer).toHaveBeenCalledOnce()
    expect(api.answer).toHaveBeenCalledWith('chat', 'sbsec_1', { save: VALUE })
  })

  it('keeps the card open with the message when the answer is refused', async () => {
    api.answer.mockResolvedValue({ ok: false, message: 'Switchboard could not save it. Try again.' })
    act(() => root.render(createElement(SecretRequestCard, { message: cardMessage(), sessionId: 'chat' })))
    type(VALUE)
    await act(async () => button('Save securely').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Switchboard could not save it. Try again.')
    expect(button('Decline').disabled).toBe(false)
    expect(input().value).toBe('')
  })

  it('declines without a value', async () => {
    act(() => root.render(createElement(SecretRequestCard, { message: cardMessage(), sessionId: 'chat' })))
    await act(async () => button('Decline').click())
    expect(api.answer).toHaveBeenCalledWith('chat', 'sbsec_1', { decline: true })
  })

  it('says a provider key is not needed by Switchboard', () => {
    act(() =>
      root.render(
        createElement(SecretRequestCard, { message: cardMessage('ANTHROPIC_API_KEY', 'API key'), sessionId: 'chat' }),
      ),
    )
    expect(container.textContent).toContain("Switchboard does not need this. Only this agent's commands get it.")
  })
})

describe('SecretResultLine', () => {
  const row = {
    requestId: 'sbsec_1',
    title: 'Secret TAILSCALE_AUTHKEY',
    outcome: 'done' as const,
    text: 'Saved TAILSCALE_AUTHKEY.',
    delivery: 'turn' as const,
  }

  it('shows the time left, extends in place and deletes', async () => {
    const now = Date.now()
    api.list.mockResolvedValue({
      ok: true,
      secrets: [
        {
          id: 'sec_1',
          name: 'TAILSCALE_AUTHKEY',
          cardId: 'sbsec_1',
          createdAt: now,
          expiresAt: now + 3 * HOUR + 60_000,
          deletedAt: null,
          status: 'live',
        },
      ],
    })
    api.extend.mockResolvedValue({ ok: true, expiresAt: now + 24 * HOUR + 60_000 })
    api.delete.mockResolvedValue({ ok: true })
    await act(async () =>
      root.render(createElement(SecretResultLine, { row, messageId: 'apr_sbsec_1', sessionId: 'chat' })),
    )
    expect(container.textContent).toContain('Saved TAILSCALE_AUTHKEY, 3 h left')
    await act(async () => button('Extend').click())
    expect(api.extend).toHaveBeenCalledWith('chat', 'sec_1')
    expect(container.textContent).toContain('24 h left')
    api.list.mockResolvedValue({ ok: true, secrets: [] })
    await act(async () => button('Delete now').click())
    expect(api.delete).toHaveBeenCalledWith('chat', 'sec_1')
    expect(container.textContent).toBe('TAILSCALE_AUTHKEY deleted')
  })

  it('shows Declined and expired lines with no buttons', async () => {
    await act(async () =>
      root.render(
        createElement(SecretResultLine, { row: { ...row, outcome: 'declined' }, messageId: 'm', sessionId: 'chat' }),
      ),
    )
    expect(container.textContent).toBe('Declined TAILSCALE_AUTHKEY')
    await act(async () =>
      root.render(
        createElement(SecretResultLine, { row: { ...row, outcome: 'expired' }, messageId: 'm', sessionId: 'chat' }),
      ),
    )
    expect(container.textContent).toBe('TAILSCALE_AUTHKEY expired')
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })
})
