import { describe, expect, it } from 'vitest'
import { AGENT_MARKS, agentMark } from '@shared/agent-marks'
import { ACP_COMMAND_AGENT } from '@shared/acp-agents'
import { AGENT_PROVIDERS } from '@shared/types'

describe('agent marks', () => {
  it('ships a mark for every agent with a published one', () => {
    const missing = AGENT_PROVIDERS.filter((agent) => !AGENT_MARKS[agent])
    // A local ACP command is whatever binary the user named: it has no mark.
    expect(missing).toEqual([ACP_COMMAND_AGENT])
  })

  it('sizes every mark by the extent of its own artwork', () => {
    for (const [agent, mark] of Object.entries(AGENT_MARKS)) {
      const [x, y, width, height] = mark.viewBox.split(' ').map(Number)
      expect([x, y, width, height].every(Number.isFinite), agent).toBe(true)
      expect(width, agent).toBeGreaterThan(0)
      expect(height, agent).toBeGreaterThan(0)
      // Side by side at one size, a mark drawn into a box far larger than
      // itself looks like a different, smaller icon.
      expect(Math.min(width, height) / Math.max(width, height), agent).toBeGreaterThan(0.6)
      expect(mark.paths.length, agent).toBeGreaterThan(0)
      for (const d of mark.paths) expect(d[0], agent).toMatch(/[Mm]/)
    }
  })

  it('takes either spelling of Claude and never guesses for an unknown agent', () => {
    expect(agentMark('claude')).toBe(AGENT_MARKS['claude-code'])
    expect(agentMark('claude-code')).toBe(AGENT_MARKS['claude-code'])
    expect(agentMark('some-future-agent')).toBeUndefined()
    expect(agentMark(null)).toBeUndefined()
  })
})
