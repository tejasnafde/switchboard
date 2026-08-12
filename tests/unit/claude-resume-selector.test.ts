import { describe, expect, it } from 'vitest'
import { selectClaudeResumeId } from '../../src/main/provider/adapters/claude-adapter'

const CLAUDE = '11111111-1111-4111-8111-111111111111'
const CODEX = '22222222-2222-4222-8222-222222222222'

describe('selectClaudeResumeId', () => {
  it('ignores provider-ambiguous family ids without a Claude transcript', () => {
    expect(selectClaudeResumeId(undefined, undefined, [CODEX, CLAUDE], (id) => id === CLAUDE)).toBe(CLAUDE)
  })

  it('does not trust a UUID hint that only exists in a Codex home', () => {
    expect(selectClaudeResumeId(undefined, CODEX, [CODEX], () => false)).toBeUndefined()
  })

  it('prefers a typed Claude segment with an existing transcript', () => {
    expect(selectClaudeResumeId(CLAUDE, CODEX, [CODEX], (id) => id === CLAUDE)).toBe(CLAUDE)
  })
})
