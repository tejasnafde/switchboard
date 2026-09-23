import { describe, expect, it } from 'vitest'
import { sessionPreviewLine } from '../../src/renderer/services/sessionPreview'
import type { ChatMessage } from '@shared/types'

function assistantMessage(content: string, id = 'm1', timestamp = 1): ChatMessage {
  return { id, role: 'assistant', content, timestamp }
}

describe('sessionPreviewLine', () => {
  it('returns undefined for no messages', () => {
    expect(sessionPreviewLine([])).toBeUndefined()
  })

  it('returns undefined when there is no assistant message', () => {
    const messages: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }]
    expect(sessionPreviewLine(messages)).toBeUndefined()
  })

  it('prefers the digest from the latest assistant message', () => {
    const messages = [
      assistantMessage('<agent_digest>Reading files</agent_digest>', 'm1', 1),
      assistantMessage('<agent_digest>Writing tests</agent_digest>', 'm2', 2),
    ]
    expect(sessionPreviewLine(messages)).toBe('Writing tests')
  })

  it('falls back to a truncated raw preview when there is no digest', () => {
    const messages = [assistantMessage("I'll start by looking at the existing cost tracking code in src/main here")]
    const preview = sessionPreviewLine(messages)
    expect(preview).toBe("I'll start by looking at the existing cost tracking code in src/main …")
    expect(preview!.length).toBe(70)
  })

  it('does not truncate a short raw message', () => {
    const messages = [assistantMessage('Done.')]
    expect(sessionPreviewLine(messages)).toBe('Done.')
  })

  it('strips a streaming partial tag from the raw fallback instead of showing it', () => {
    const messages = [assistantMessage('Working on it. <agent_di')]
    expect(sessionPreviewLine(messages)).toBe('Working on it.')
  })

  it('skips a trailing non-assistant message and uses the last assistant one', () => {
    const messages: ChatMessage[] = [
      assistantMessage('<agent_digest>Done: tests green</agent_digest>', 'm1', 1),
      { id: 'u2', role: 'user', content: 'thanks', timestamp: 2 },
    ]
    expect(sessionPreviewLine(messages)).toBe('Done: tests green')
  })

  it('skips an assistant message with empty content and looks further back', () => {
    const messages = [
      assistantMessage('<agent_digest>Real status</agent_digest>', 'm1', 1),
      { id: 'm2', role: 'assistant' as const, content: '', timestamp: 2 },
    ]
    expect(sessionPreviewLine(messages)).toBe('Real status')
  })
})
