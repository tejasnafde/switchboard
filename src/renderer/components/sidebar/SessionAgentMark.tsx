import { agentLabel, toAgentProvider, type SessionSummary } from '@shared/types'
import { AgentMark } from '../ui/agent-mark'

/**
 * The agent's mark on a sidebar chat row. A row stored before the provider
 * was recorded, and a row the sidebar inserted the moment a chat was created,
 * fall back to the session source, which names the agent for every agent that
 * writes its own transcript.
 */
export function SessionAgentMark({ session }: { session: Pick<SessionSummary, 'agentType' | 'source'> }) {
  const agent = toAgentProvider(session.agentType ?? session.source)
  return <AgentMark agent={agent} label={agentLabel(agent)} className="sidebar-row-mark" />
}
