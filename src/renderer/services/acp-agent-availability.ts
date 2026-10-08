/**
 * Which generic ACP agents (Gemini CLI, Mistral Vibe, Cline, Copilot) are
 * installed on the local backend. An agent whose CLI is missing is not
 * offered in the provider picker or in Settings > Accounts.
 */
import { useEffect, useState } from 'react'
import { GENERIC_ACP_AGENTS, isGenericAcpAgent, type GenericAcpAgent } from '@shared/acp-agents'
import type { AgentType } from '@shared/types'
import { createRendererLogger } from '../logger'

const log = createRendererLogger('service:acp-agents')

let installed: ReadonlySet<string> = new Set()
let probeSeq = 0

/**
 * The agent types to offer, in order: every built-in agent, and a generic
 * ACP agent only when it is installed or is in `keep` (the chat's own agent,
 * or one the user already made an account for).
 */
export function offeredAgentTypes<T extends AgentType>(all: readonly T[], installedAgents: ReadonlySet<string>, keep: ReadonlySet<string> = new Set()): T[] {
  return all.filter((type) => !isGenericAcpAgent(type) || installedAgents.has(type) || keep.has(type))
}

/** Asks the backend about every generic ACP agent; a failed answer counts as not installed. */
export async function probeInstalledAcpAgents(isAvailable: (agent: GenericAcpAgent) => Promise<boolean>): Promise<ReadonlySet<string>> {
  const seq = ++probeSeq
  const answers = await Promise.all(GENERIC_ACP_AGENTS.map(async (agent) => {
    try {
      return (await isAvailable(agent)) ? agent : null
    } catch (err) {
      log.warn(`availability check for ${agent} failed`, err)
      return null
    }
  }))
  const result = new Set(answers.filter((agent): agent is GenericAcpAgent => agent !== null))
  // An older probe finishing late must not replace a newer answer.
  if (seq === probeSeq) installed = result
  return result
}

/** The installed generic ACP agents, re-checked each time `active` turns true. */
export function useInstalledAcpAgents(active = true): ReadonlySet<string> {
  const [agents, setAgents] = useState(installed)
  useEffect(() => {
    if (!active) return
    let current = true
    void probeInstalledAcpAgents((agent) => window.api.provider.isAvailable(agent)).then((result) => {
      if (current) setAgents(result)
    })
    return () => { current = false }
  }, [active])
  return agents
}

export function _resetInstalledAcpAgentsForTests(): void {
  installed = new Set()
  probeSeq = 0
}
