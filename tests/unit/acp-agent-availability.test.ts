import { beforeEach, describe, expect, it } from 'vitest'
import { _resetInstalledAcpAgentsForTests, offeredAgentTypes, probeInstalledAcpAgents } from '../../src/renderer/services/acp-agent-availability'
import { AGENT_TYPES } from '../../src/shared/types'

beforeEach(() => _resetInstalledAcpAgentsForTests())

describe('offeredAgentTypes', () => {
  it('offers built-in agents always and a generic ACP agent only when installed or kept', () => {
    expect(offeredAgentTypes(AGENT_TYPES, new Set())).toEqual(['claude-code', 'codex', 'opencode', 'terminal'])
    expect(offeredAgentTypes(AGENT_TYPES, new Set(['vibe']), new Set(['copilot'])))
      .toEqual(['claude-code', 'codex', 'opencode', 'vibe', 'copilot', 'terminal'])
  })
})

describe('probeInstalledAcpAgents', () => {
  it('asks about every generic agent and counts a failed answer as not installed', async () => {
    const asked: string[] = []
    const installed = await probeInstalledAcpAgents(async (agent) => {
      asked.push(agent)
      if (agent === 'cline') throw new Error('backend gone')
      return agent === 'gemini' || agent === 'cline'
    })
    expect(asked).toEqual(['gemini', 'vibe', 'cline', 'copilot'])
    expect([...installed]).toEqual(['gemini'])
  })
})
