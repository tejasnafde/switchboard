import { describe, expect, it } from 'vitest'
import {
  settingsChipLabel,
  showsTurnDuration,
  threadSubtitle,
  usageAccessibilityLabel,
  usageLine,
} from '../../apps/mobile/src/lib/thread-chrome'

describe('phone chat header subtitle', () => {
  it('names the profile, then the status, without the model', () => {
    expect(threadSubtitle({ status: 'running', instanceName: 'SSG', provider: 'claude' })).toBe('SSG · Working')
    expect(threadSubtitle({ status: 'idle', provider: 'codex' })).toBe('Codex · Ready')
    expect(threadSubtitle({ status: 'error', provider: 'gemini' })).toBe('Gemini · Needs attention')
    expect(threadSubtitle({ status: 'connecting' })).toBe('Reconnecting')
  })

  it('says a cached feed is saved locally', () => {
    expect(threadSubtitle({ status: 'running', cached: true, instanceName: 'SSG' })).toBe('Saved locally')
  })
})

describe('usage line', () => {
  const full = { usedTokens: 576_511, maxTokens: 1_000_000, costUsd: 904.67, lastTurnDurationMs: 1300 }

  it('joins tokens, cost and the last turn', () => {
    expect(usageLine(full)).toBe('576,511 of 1,000,000 tokens · $904.67 · last turn 1.3s')
    expect(usageAccessibilityLabel(full)).toBe(
      'context 58 percent, 576,511 of 1,000,000 tokens, cost 904.67 dollars, last turn 1.3s',
    )
  })

  it('drops what is not known yet', () => {
    expect(usageLine({ usedTokens: 1200, maxTokens: null })).toBe('1,200 tokens')
    expect(usageLine({ costUsd: 0.042 })).toBe('$0.042')
    expect(usageLine({})).toBeNull()
    expect(usageAccessibilityLabel({})).toBeNull()
  })
})

describe('turn duration threshold', () => {
  it('shows "Worked for" from 30 s', () => {
    expect(showsTurnDuration(undefined)).toBe(false)
    expect(showsTurnDuration(29_999)).toBe(false)
    expect(showsTurnDuration(30_000)).toBe(true)
  })
})

describe('model and mode chip', () => {
  it('puts the model and the mode on one label', () => {
    expect(settingsChipLabel('claude-opus-5-5', 'full-access')).toBe('claude-opus-5-5 · Full access')
    expect(settingsChipLabel(null, 'accept-edits')).toBe('Model · Auto-accept edits')
  })
})
