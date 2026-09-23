import type { AgentStatus, ChatMessage, Project, SessionSummary } from '@shared/types'
import { sessionPreviewLine } from '../../services/sessionPreview'

export interface RecentLiveSession {
  id: string
  machineId?: string
  status: AgentStatus
  messages: ChatMessage[]
  unreadCount?: number
}

export type RecentSessionStatus = 'approval' | 'input' | 'working' | 'failed' | 'done'

const STATUS_PRIORITY: Record<RecentSessionStatus, number> = {
  approval: 6,
  input: 5,
  working: 4,
  failed: 3,
  done: 2,
}

function recentSessionStatus(
  session: SessionSummary,
  live: RecentLiveSession | undefined,
): RecentSessionStatus | undefined {
  if (session.worktreeRecovery?.cleanupDisposition === 'retained') return 'failed'
  if (live?.messages.some((message) => message.approval?.status === 'pending')) return 'approval'
  if (live?.messages.some((message) => message.question?.status === 'pending')) return 'input'
  if (live?.status === 'running' || live?.status === 'thinking') return 'working'
  if (live?.status === 'error') return 'failed'
  if ((live?.unreadCount ?? 0) > 0) return 'done'
  return undefined
}

export interface RecentSessionItem {
  session: SessionSummary
  projectPath: string
  projectName: string
  machineId: string
  status?: RecentSessionStatus
  /**
   * Live, in-memory-only preview of the session's latest assistant message
   * (the agent's own `<agent_digest>` status line when reported, else a
   * raw truncated preview) - see `sessionPreview.ts`. Undefined for a
   * session with no live assistant message yet (e.g. not opened this run).
   */
  previewLine?: string
}

export function deriveRecentSessions(_input: {
  localProjects: Project[]
  remoteProjects: Record<string, Project[]>
  liveSessions: RecentLiveSession[]
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
      const status = recentSessionStatus(session, live)
      return {
        session,
        projectPath: project.path,
        projectName: project.name,
        machineId,
        status,
        previewLine: live ? sessionPreviewLine(live.messages) : undefined,
        priority: status ? STATUS_PRIORITY[status] : 0,
      }
    })))
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.priority - a.priority || b.session.startedAt - a.session.startedAt)
    .map(({ priority: _priority, ...item }) => item)
}
