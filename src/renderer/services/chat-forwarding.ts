import { agentLabel, type AgentType } from '@shared/types'

interface ForwardSession {
  id: string
  title?: string
  type: AgentType
}

export function forwardingTargets<T extends ForwardSession>(
  sessions: readonly T[],
  sourceSessionId: string,
  displayedSessionIds: readonly string[],
): T[] {
  const displayed = new Set(displayedSessionIds)
  return sessions
    .filter((session) => session.id !== sourceSessionId)
    .sort((a, b) => Number(displayed.has(b.id)) - Number(displayed.has(a.id)))
}

export function buildForwardedContext(
  content: string,
  source: { title: string; provider: string },
): string {
  const quoted = content
    .split('\n')
    .slice(0, 40)
    .map((line) => `> ${line}`)
    .join('\n')
  return `[Forwarded from ${source.provider} · "${source.title}"]\n${quoted}\n`
}

export function forwardingSource(session: ForwardSession): { title: string; provider: string } {
  return {
    title: session.title ?? session.id.slice(0, 8),
    provider: agentLabel(session.type),
  }
}
