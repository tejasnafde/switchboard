import type { AgentStatus, ChatMessage, Project, SessionSummary } from '@shared/types'

export interface RecentLiveSession {
  id: string
  machineId?: string
  status: AgentStatus
  messages: ChatMessage[]
}

export interface RecentSessionItem {
  session: SessionSummary
  projectPath: string
  projectName: string
  machineId: string
  attentionLabel?: 'Approval' | 'Question' | 'Failed'
}

export function deriveRecentSessions(_input: {
  localProjects: Project[]
  remoteProjects: Record<string, Project[]>
  liveSessions: RecentLiveSession[]
  limit: number
}): RecentSessionItem[] {
  const liveById = new Map(
    _input.liveSessions.map((session) => [`${session.machineId ?? 'local'}\0${session.id}`, session]),
  )
  const projectSets = [
    { machineId: 'local', projects: _input.localProjects },
    ...Object.entries(_input.remoteProjects).map(([machineId, projects]) => ({ machineId, projects })),
  ]
  const seen = new Set<string>()
  return projectSets
    .flatMap(({ machineId, projects }) => projects.flatMap((project) => project.sessions.map((session) => {
      const key = `${machineId}\0${session.id}`
      if (seen.has(key)) return null
      seen.add(key)
      const live = liveById.get(key)
      const attentionLabel = live?.messages.some((message) => message.approval?.status === 'pending')
        ? 'Approval' as const
        : live?.messages.some((message) => message.question?.status === 'pending')
          ? 'Question' as const
          : live?.status === 'error'
            ? 'Failed' as const
            : undefined
      const priority = attentionLabel ? 2 : live?.status === 'running' || live?.status === 'thinking' ? 1 : 0
      return {
        session,
        projectPath: project.path,
        projectName: project.name,
        machineId,
        attentionLabel,
        priority,
      }
    })))
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.priority - a.priority || b.session.startedAt - a.session.startedAt)
    .slice(0, _input.limit)
    .map(({ priority: _priority, ...item }) => item)
}
