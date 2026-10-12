import { describe, expect, it, vi } from 'vitest'
import {
  messageIdByQuote,
  resolvePillMessage,
  type PillMessageDeps,
} from '../../src/renderer/services/pill-message-open'
import type { PillChipTarget } from '../../src/renderer/services/pill-chip-model'

type Message = { id: string; role: string; content: string; displayBody?: string }

function target(overrides: Partial<Extract<PillChipTarget, { type: 'message' }>> = {}) {
  return { type: 'message' as const, role: 'assistant' as const, quote: 'the cache key', source: null, ...overrides }
}

function deps(
  chats: Record<string, Message[]>,
  options: { focused?: string | null; full?: Record<string, Message[]>; openable?: string[] } = {},
) {
  const loaded: Record<string, Message[]> = { ...chats }
  let focused = options.focused ?? null
  const value: PillMessageDeps = {
    focusedId: () => focused,
    sessionMessages: (id) => loaded[id],
    openChat: vi.fn(async (id: string) => {
      if (!(options.openable ?? []).includes(id)) return null
      loaded[id] ??= []
      focused = id
      return id
    }),
    ensureFullHistory: vi.fn(async (id: string) => {
      if (options.full?.[id]) loaded[id] = options.full[id]
      return true
    }),
    isCurrent: () => true,
  }
  return value
}

const older: Message = { id: 'm1', role: 'assistant', content: 'we key the cache key by inode' }
const newer: Message = { id: 'm2', role: 'assistant', content: 'unrelated' }

describe('resolvePillMessage', () => {
  it('finds a message by id in the chat the chip sits in, without opening anything', async () => {
    const d = deps({ chat: [older, newer] }, { focused: 'chat' })
    const result = await resolvePillMessage(target({ source: { conversationId: 'chat', messageId: 'm1' } }), 'chat', d)
    expect(result).toEqual({ status: 'found', sessionId: 'chat', messageId: 'm1' })
    expect(d.openChat).not.toHaveBeenCalled()
    expect(d.ensureFullHistory).not.toHaveBeenCalled()
  })

  it('opens the source chat when it is another chat, then loads its full history for an older message', async () => {
    const d = deps({ here: [] }, { focused: 'here', openable: ['there'], full: { there: [older, newer] } })
    const result = await resolvePillMessage(target({ source: { conversationId: 'there', messageId: 'm1' } }), 'here', d)
    expect(d.openChat).toHaveBeenCalledWith('there')
    expect(d.ensureFullHistory).toHaveBeenCalledWith('there')
    expect(result).toEqual({ status: 'found', sessionId: 'there', messageId: 'm1' })
  })

  it('reports a source chat that no longer exists', async () => {
    const d = deps({ here: [] }, { focused: 'here' })
    const result = await resolvePillMessage(
      target({ source: { conversationId: 'deleted', messageId: 'm1' } }),
      'here',
      d,
    )
    expect(result).toEqual({ status: 'chat-missing' })
  })

  it('opens an old pill without ids by its quote in the chat it sits in', async () => {
    const d = deps({ chat: [older, newer] }, { focused: 'chat' })
    expect(await resolvePillMessage(target(), 'chat', d)).toEqual({
      status: 'found',
      sessionId: 'chat',
      messageId: 'm1',
    })
    expect(d.openChat).not.toHaveBeenCalled()
  })

  it('reports a message that is gone even after the full history loads', async () => {
    const d = deps({ chat: [newer] }, { focused: 'chat', full: { chat: [newer] } })
    const result = await resolvePillMessage(
      target({ quote: 'not here', source: { conversationId: 'chat', messageId: 'gone' } }),
      'chat',
      d,
    )
    expect(d.ensureFullHistory).toHaveBeenCalledWith('chat')
    expect(result).toEqual({ status: 'message-missing' })
  })

  it('falls back to the quote when a reloaded history carries a different id', async () => {
    const d = deps({ chat: [older] }, { focused: 'chat' })
    const result = await resolvePillMessage(
      target({ source: { conversationId: 'chat', messageId: 'live-id' } }),
      'chat',
      d,
    )
    expect(result).toEqual({ status: 'found', sessionId: 'chat', messageId: 'm1' })
  })

  it('stops when a newer open replaced this one while history loaded', async () => {
    const d = deps({ chat: [] }, { focused: 'chat', full: { chat: [older] } })
    let current = true
    d.isCurrent = () => current
    d.ensureFullHistory = vi.fn(async () => {
      current = false
      return true
    })
    expect(await resolvePillMessage(target(), 'chat', d)).toEqual({ status: 'superseded' })
  })
})

describe('resolvePillMessage after navigation', () => {
  it('drops the jump when focus left the opened chat while its history loaded', async () => {
    const d = deps({ here: [] }, { focused: 'here', openable: ['there'], full: { there: [older] } })
    d.ensureFullHistory = vi.fn(async () => {
      d.focusedId = () => 'elsewhere'
      return true
    })
    const result = await resolvePillMessage(target({ source: { conversationId: 'there', messageId: 'm1' } }), 'here', d)
    expect(result).toEqual({ status: 'superseded' })
  })
})

describe('messageIdByQuote', () => {
  it('matches the newest message of the role, reading a user display body', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', content: 'expanded', displayBody: 'please fix the cache key' },
      { id: 'a1', role: 'assistant', content: 'the cache key' },
      { id: 'u2', role: 'user', content: 'the cache key again' },
    ]
    expect(messageIdByQuote(messages, 'user', 'the cache key')).toBe('u2')
    expect(messageIdByQuote(messages, 'assistant', 'the cache key')).toBe('a1')
    expect(messageIdByQuote(messages, 'user', '')).toBeNull()
  })
})
