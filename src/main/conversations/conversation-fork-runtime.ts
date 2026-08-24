import { getProviderInstanceFull } from '../db/providerInstances'
import {
  getConversationById,
  getConversationByThreadId,
  getDb,
  getSessionLayout,
  listConversationSegments,
} from '../db/database'
import { SqliteConversationForkStore } from '../db/conversation-fork'
import {
  ConversationForkCoordinator,
  type ConversationForkWorktreePort,
} from './conversation-fork-coordinator'
import { DefaultProviderForkArtifacts } from './fork-provider-artifacts'
import { projectForkSourceExecution } from './fork-source'
import { loadConversationHistory } from './history'

let coordinator: ConversationForkCoordinator | null = null
let worktreePort: ConversationForkWorktreePort | null = null

export function configureConversationForkWorktreePort(port: ConversationForkWorktreePort): void {
  worktreePort = port
}

export function getConversationForkCoordinator(): ConversationForkCoordinator {
  if (coordinator) return coordinator
  const store = new SqliteConversationForkStore(getDb())
  coordinator = new ConversationForkCoordinator({
    store,
    loadSource: async (request) => {
      const row = getConversationByThreadId(request.sourceConversationId)
      if (!row) throw new Error(`Fork source conversation not found: ${request.sourceConversationId}`)
      const layout = getSessionLayout(row.id)
      const source = projectForkSourceExecution({
        ...row,
        launch_config_name: layout?.launchConfigName ?? null,
      }, { machineId: request.machineId ?? 'local' })
      const history = await loadConversationHistory(row.id, row.project_path)
      return { source, history: history.forkMessages }
    },
    providerArtifacts: new DefaultProviderForkArtifacts({
      resolveInstance: getProviderInstanceFull,
      listCompatibleSessionIds: (conversationId, providerInstanceId) => {
        const ids = listConversationSegments(conversationId)
          .filter((segment) =>
            segment.provider === 'claude-code'
            && segment.provider_instance_id === providerInstanceId)
          .map((segment) => segment.provider_session_id)
        const row = getConversationById(conversationId)
        if (row?.agent_type === 'claude-code'
          && row.provider_instance_id === providerInstanceId
          && row.session_id
          && !ids.includes(row.session_id)) {
          ids.push(row.session_id)
        }
        return ids
      },
    }),
    worktrees: {
      prepare: (input) => {
        if (!worktreePort) throw new Error('Conversation fork worktree port is unavailable')
        return worktreePort.prepare(input)
      },
      create: (input) => {
        if (!worktreePort) throw new Error('Conversation fork worktree port is unavailable')
        return worktreePort.create(input)
      },
    },
  })
  return coordinator
}

export function resetConversationForkCoordinatorForTests(): void {
  coordinator = null
  worktreePort = null
}
