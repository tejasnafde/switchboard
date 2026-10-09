import type { ChatSearchItem } from '@shared/chat-search'
import { toAgentProvider, type AgentType, type Project, type SessionSource, type SessionSummary } from '@shared/types'

export interface GoToChatItem extends ChatSearchItem {
  key: string
  session: SessionSummary
  projectPath: string
  machineId: string
  agent: AgentType
}

export interface ArchivedChatRow {
  id: string
  project_path: string
  title: string
  updated_at: number
  /** Absent from a backend older than Go to chat. */
  agent_type?: string
  origin_source?: string | null
}

// A machine snapshot row can lack a time; it sorts last and shows none.
const timeOf = (ms: number | undefined) => (Number.isFinite(ms) ? ms as number : 0)

const agentOf = (session: SessionSummary): AgentType =>
  session.agentType === 'terminal' ? 'terminal' : toAgentProvider(session.agentType ?? session.source)

/**
 * Every chat the sidebar lists (local projects, then each remote machine's),
 * plus the local archived chats, as Go to chat rows. A chat listed twice keeps
 * its first row, as the sidebar's Recents does.
 */
export function goToChatItems(input: {
  localProjects: readonly Project[]
  remoteProjects: Readonly<Record<string, readonly Project[]>>
  archived: readonly ArchivedChatRow[]
}): GoToChatItem[] {
  const items: GoToChatItem[] = []
  const seen = new Set<string>()
  const push = (item: Omit<GoToChatItem, 'key'>) => {
    const key = `${item.machineId}\0${item.session.id}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ ...item, key })
  }
  const sets = [['local', input.localProjects] as const, ...Object.entries(input.remoteProjects)]
  for (const [machineId, projects] of sets) {
    for (const project of projects) {
      for (const session of project.sessions) {
        push({
          session, projectPath: project.path, machineId, agent: agentOf(session),
          title: session.title, projectName: project.name, lastActivity: timeOf(session.startedAt),
        })
      }
    }
  }
  const localNames = new Map(input.localProjects.map((p) => [p.path, p.name]))
  for (const row of input.archived) {
    const session: SessionSummary = {
      id: row.id,
      source: (row.origin_source ?? (row.agent_type === 'terminal' ? 'switchboard' : toAgentProvider(row.agent_type))) as SessionSource,
      title: row.title,
      startedAt: row.updated_at,
      messageCount: 0,
      filePath: '',
      agentType: row.agent_type ?? null,
    }
    push({
      session, projectPath: row.project_path, machineId: 'local', agent: agentOf(session),
      title: row.title,
      projectName: localNames.get(row.project_path) ?? row.project_path.split(/[\\/]/).filter(Boolean).pop() ?? row.project_path,
      lastActivity: row.updated_at,
      archived: true,
    })
  }
  return items
}
