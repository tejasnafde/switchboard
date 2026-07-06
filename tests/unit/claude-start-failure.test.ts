import { describe, it, expect } from 'vitest'
import { formatClaudeStartFailure } from '../../src/main/provider/adapters/claude-adapter'

describe('formatClaudeStartFailure', () => {
  it('appends a sign-in hint to opaque process-exit failures when creds are unknown', () => {
    const out = formatClaudeStartFailure('Claude Code process exited with code 1', false)
    expect(out).toContain('exited with code 1')
    expect(out).toContain('claude login')
    expect(out).toContain('ANTHROPIC_API_KEY')
  })

  it('leaves the raw message alone when credentials are known present', () => {
    const raw = 'Claude Code process exited with code 1'
    expect(formatClaudeStartFailure(raw, true)).toBe(raw)
  })

  it('leaves non-exit errors alone regardless of creds', () => {
    const raw = 'ENOENT: spawn claude'
    expect(formatClaudeStartFailure(raw, false)).toBe(raw)
  })
})
