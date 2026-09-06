/**
 * Pure mapping from the Terminal-tab "CLI Binary" selector value to the
 * agentType used to resolve login identity. Kept out of
 * UnifiedProviderPicker.tsx so it's testable without React/DOM - this
 * project's vitest config runs in the `node` environment and only renderer
 * .ts (not .tsx) modules are directly importable in tests.
 */
import { describe, it, expect } from 'vitest'
import { terminalLoginAgentType } from '../../src/renderer/shared/terminalLogin'

describe('terminalLoginAgentType', () => {
  it('maps the "claude" CLI binary to claude-code', () => {
    expect(terminalLoginAgentType('claude')).toBe('claude-code')
  })

  it('maps the "codex" CLI binary to codex', () => {
    expect(terminalLoginAgentType('codex')).toBe('codex')
  })

  it('returns null for a custom/arbitrary command - no instance identity to resolve', () => {
    expect(terminalLoginAgentType('bash')).toBeNull()
    expect(terminalLoginAgentType('/usr/local/bin/my-cli')).toBeNull()
    expect(terminalLoginAgentType('')).toBeNull()
  })
})
