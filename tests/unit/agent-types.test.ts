/**
 * AgentType union and label helpers.
 *
 * These are the single source of truth for which agent kinds the app supports.
 * Tests lock down the set so adding a new kind forces an explicit test update,
 * and catch any label helper that's missing a branch for the new kind.
 */
import { describe, it, expect } from 'vitest'
import {
  AGENT_TYPES,
  isAgentType,
  agentLabel,
  agentShortLabel,
  defaultInstanceId,
} from '../../src/shared/types'
import type { AgentType } from '../../src/shared/types'

describe('AGENT_TYPES', () => {
  it('contains all four agent kinds', () => {
    expect(AGENT_TYPES).toContain('claude-code')
    expect(AGENT_TYPES).toContain('codex')
    expect(AGENT_TYPES).toContain('opencode')
    expect(AGENT_TYPES).toContain('terminal')
    expect(AGENT_TYPES).toHaveLength(4)
  })
})

describe('isAgentType', () => {
  it('returns true for all valid kinds', () => {
    for (const t of AGENT_TYPES) {
      expect(isAgentType(t)).toBe(true)
    }
  })

  it('returns false for unknown strings', () => {
    expect(isAgentType('gemini')).toBe(false)
    expect(isAgentType('')).toBe(false)
    expect(isAgentType(null)).toBe(false)
    expect(isAgentType(undefined)).toBe(false)
    expect(isAgentType(42)).toBe(false)
  })
})

describe('agentLabel', () => {
  it('returns the full display name for each kind', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code')
    expect(agentLabel('codex')).toBe('Codex')
    expect(agentLabel('opencode')).toBe('OpenCode')
    expect(agentLabel('terminal')).toBe('Terminal')
  })

  it('falls back to Claude Code for undefined', () => {
    expect(agentLabel(undefined)).toBe('Claude Code')
  })

  it('covers every member of AGENT_TYPES without returning the fallback', () => {
    // Ensures no agent kind silently falls through to the default branch.
    const fallback = agentLabel(undefined)
    for (const t of AGENT_TYPES) {
      if (t === 'claude-code') continue // claude-code is the fallback by design
      expect(agentLabel(t)).not.toBe(fallback)
    }
  })
})

describe('agentShortLabel', () => {
  it('returns the short label for each kind', () => {
    expect(agentShortLabel('claude-code')).toBe('Claude')
    expect(agentShortLabel('codex')).toBe('Codex')
    expect(agentShortLabel('opencode')).toBe('OpenCode')
    expect(agentShortLabel('terminal')).toBe('Terminal')
  })

  it('falls back to Claude for undefined', () => {
    expect(agentShortLabel(undefined)).toBe('Claude')
  })
})

describe('defaultInstanceId', () => {
  it('returns <kind>-default for every known kind', () => {
    const kinds: AgentType[] = ['claude-code', 'codex', 'opencode', 'terminal']
    for (const k of kinds) {
      expect(defaultInstanceId(k)).toBe(`${k}-default`)
    }
  })
})
