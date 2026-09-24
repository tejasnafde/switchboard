import type { AgentStatus, ChatMessage, Project, SessionSummary } from '@shared/types'
import type { PendingBlockingEvent } from '@shared/pending-requests'
import { sessionPreviewLine } from '../../services/sessionPreview'

export interface RecentLiveSession {
  id: string
  machineId?: string
  status: AgentStatus
  messages: ChatMessage[]
  unreadCount?: number
  /** The backend's open cards for the thread - see `AgentSession.pendingRequests`. */
  pendingRequests?: readonly PendingBlockingEvent[]
}

export type RecentSessionStatus = 'approval' | 'input' | 'plan' | 'failed' | 'working' | 'done'

const STATUS_PRIORITY: Record<RecentSessionStatus, number> = {
  approval: 6,
  input: 5,
  plan: 4,
  failed: 3,
  working: 2,
  done: 1,
}

function recentSessionStatus(
  session: SessionSummary,
  live: RecentLiveSession | undefined,
): RecentSessionStatus | undefined {
  if (session.worktreeRecovery?.cleanupDisposition === 'retained') return 'failed'
  const pending = live?.pendingRequests ?? []
  if (pending.some((event) => event.type === 'request.opened')) return 'approval'
  if (pending.some((event) => event.type === 'question.asked')) return 'input'
  if (pending.some((event) => event.type === 'plan.proposed')) return 'plan'
  if (live?.status === 'error') return 'failed'
  if (live?.status === 'running' || live?.status === 'thinking') return 'working'
  if ((live?.unreadCount ?? 0) > 0) return 'done'
  return undefined
}

/**
 * Line 2 of a Recents row. A state that waits on the user says what it waits
 * for; otherwise the agent's own status line, or the project it belongs to.
 */
function recentStatusLine(
  session: SessionSummary,
  status: RecentSessionStatus | undefined,
  live: RecentLiveSession | undefined,
  previewLine: string | undefined,
  projectName: string,
): string {
  const pending = live?.pendingRequests ?? []
  switch (status) {
    case 'approval': {
      const request = pending.find((event) => event.type === 'request.opened')
      return `Waiting on your approval: ${request?.type === 'request.opened' ? request.toolName : 'tool call'}`
    }
    case 'input': {
      const question = pending.find((event) => event.type === 'question.asked')
      const text = question?.type === 'question.asked' ? question.questions[0]?.question : undefined
      return text ? `Question: ${text}` : 'Waiting on your answer'
    }
    case 'plan':
      return 'Plan ready for your review'
    case 'failed':
      return session.worktreeRecovery?.cleanupDisposition === 'retained'
        ? 'Worktree recovery needs you'
        : 'Stopped with an error'
    default:
      return previewLine ?? projectName
  }
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
  /** Line 2 of the row - see `recentStatusLine`. */
  statusLine: string
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
      const previewLine = live ? sessionPreviewLine(live.messages) : undefined
      return {
        session,
        projectPath: project.path,
        projectName: project.name,
        machineId,
        status,
        previewLine,
        statusLine: recentStatusLine(session, status, live, previewLine, project.name),
        priority: status ? STATUS_PRIORITY[status] : 0,
      }
    })))
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((a, b) => b.priority - a.priority || b.session.startedAt - a.session.startedAt)
    .map(({ priority: _priority, ...item }) => item)
}
