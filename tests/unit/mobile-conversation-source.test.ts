import { describe, expect, it } from 'vitest'
import { conversationSourceLabel } from '../../apps/mobile/src/lib/conversationSource'

describe('mobile conversation provenance', () => {
  it('shows Cursor provenance without changing the runnable provider', () => {
    expect(conversationSourceLabel({ agent_type: 'claude-code', origin_source: 'cursor' })).toBe('Cursor')
    expect(conversationSourceLabel({ agent_type: 'claude-code', origin_source: null })).toBe('Claude')
    expect(conversationSourceLabel({ agent_type: 'codex' })).toBe('Codex')
  })
})
