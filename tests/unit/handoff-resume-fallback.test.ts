/**
 * A native session that cannot be resumed must not leave the agent blind:
 * the next message carries the visible conversation (Codex and OpenCode via
 * withVisibleHistory, Claude by rewriting the unread SDK message).
 */
import { describe, expect, it, vi } from 'vitest'
import { withVisibleHistory } from '../../src/main/provider/visible-history'
import { prefixUserMessage } from '../../src/main/provider/adapters/claude-adapter'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const PREAMBLE = 'Conversation so far:\nuser: q\n\nRespond to the latest user message, using the conversation above as context.'

describe('withVisibleHistory', () => {
  it('prefixes the first message after a failed resume, once', async () => {
    const state = { needsVisibleHistory: true, portableHistory: vi.fn().mockResolvedValue(PREAMBLE) }
    expect(await withVisibleHistory(state, 't', 'next')).toBe(`${PREAMBLE}\n\nnext`)
    expect(await withVisibleHistory(state, 't', 'later')).toBe('later')
    expect(state.portableHistory).toHaveBeenCalledTimes(1)
  })

  it('leaves a resumed session alone', async () => {
    const state = { portableHistory: vi.fn() }
    expect(await withVisibleHistory(state, 't', 'next')).toBe('next')
    expect(state.portableHistory).not.toHaveBeenCalled()
  })

  it('sends the message as typed when the history cannot be read', async () => {
    const state = { needsVisibleHistory: true, portableHistory: vi.fn().mockRejectedValue(new Error('disk')) }
    expect(await withVisibleHistory(state, 't', 'next')).toBe('next')
  })
})

describe('prefixUserMessage', () => {
  const message = (content: SDKUserMessage['message']['content']) =>
    ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }) as SDKUserMessage

  it('prefixes plain text', () => {
    const m = message('next')
    prefixUserMessage(m, PREAMBLE)
    expect(m.message.content).toBe(`${PREAMBLE}\n\nnext`)
  })

  it('prefixes the text block next to images', () => {
    const m = message([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }, { type: 'text', text: 'look' }])
    prefixUserMessage(m, PREAMBLE)
    expect(m.message.content).toEqual([expect.objectContaining({ type: 'image' }), { type: 'text', text: `${PREAMBLE}\n\nlook` }])
  })

  it('adds a text block to an image-only message', () => {
    const m = message([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }])
    prefixUserMessage(m, PREAMBLE)
    expect(m.message.content).toEqual([expect.objectContaining({ type: 'image' }), { type: 'text', text: PREAMBLE }])
  })
})
