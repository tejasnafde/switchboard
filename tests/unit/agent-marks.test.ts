import { describe, expect, it } from 'vitest'
import { AGENT_MARKS, agentMark, agentMarkInitials } from '@shared/agent-marks'
import { ACP_COMMAND_AGENT } from '@shared/acp-agents'
import { AGENT_PROVIDERS } from '@shared/types'

describe('agent marks', () => {
  it('ships a mark for every agent with a published one', () => {
    const missing = AGENT_PROVIDERS.filter((agent) => !AGENT_MARKS[agent])
    // A local ACP command is whatever binary the user named: it has no mark.
    expect(missing).toEqual([ACP_COMMAND_AGENT])
  })

  it('draws only closed paths sized by their own viewBox', () => {
    for (const [agent, mark] of Object.entries(AGENT_MARKS)) {
      expect(mark.viewBox, agent).toMatch(/^0 0 \d+ \d+$/)
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

  it('falls back to two letters of the agent name', () => {
    expect(agentMarkInitials('Local')).toBe('LO')
    expect(agentMarkInitials('  ')).toBe('··')
  })
})
