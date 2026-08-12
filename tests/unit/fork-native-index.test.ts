import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { resolveNativeForkIndex } from '../../src/main/conversations/fork'

const message = (id: string, content: string, timestamp: number): ChatMessage => ({
  id, role: 'assistant', content, timestamp,
})

describe('resolveNativeForkIndex', () => {
  it('maps a unified selection back to its provider-native index', () => {
    const claudeOne = message('claude-1', 'Claude one', 100)
    const codex = message('codex-1', 'Codex middle', 200)
    const claudeTwo = message('claude-2', 'Claude two', 300)

    expect(resolveNativeForkIndex(
      [claudeOne, codex, claudeTwo],
      [claudeOne, claudeTwo],
      2,
    )).toBe(1)
  })

  it('returns null when the selected message belongs to another provider', () => {
    const claude = message('claude-1', 'Claude one', 100)
    const codex = message('codex-1', 'Codex middle', 200)

    expect(resolveNativeForkIndex([claude, codex], [claude], 1)).toBeNull()
  })
})
