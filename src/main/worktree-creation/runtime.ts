import type { BackendHost } from '../backend/host'
import { getConversationById, getDb, listConversationSegments } from '../db/database'
import { SqliteWorktreeCreationStore } from '../db/worktree-creation'
import { SqliteConversationForkStore } from '../db/conversation-fork'
import { getProviderInstanceFull } from '../db/providerInstances'
import {
  createWorktreeCreationProgressSink,
  registerWorktreeCreationHandlers,
  type RetargetableWorktreeCreationProgressSink,
  type WorktreeCreationApi,
} from '../ipc/worktree-creation'
import { userDataDir } from '../runtime'
import { ExecFileGitWorktreeAdapter } from './git-adapter'
import {
  startWorktreeCreationService,
  type WorktreeCreationProgressSink,
} from './worktree-creation-service'
import {
  LaunchConfigWorktreeSetupConfig,
  ProcessWorktreeSetupRunner,
} from './setup-adapters'
import {
  ProviderWorktreeStartupLauncher,
  WorktreeLaunchConfigTerminalProvisioner,
  type ManagedProviderRegistry,
} from './startup-launcher'
import { readLaunchConfig } from '../launch-config/launch-config-store'
import { getManagedTerminalRuntime } from '../ipc/terminal'
import {
  ConversationForkWorktreePort,
  ForkWorktreeOwnerAdapter,
} from '../conversations/fork-worktree-owner'
import { DefaultProviderForkArtifacts } from '../conversations/fork-provider-artifacts'
import { configureConversationForkWorktreePort } from '../conversations/conversation-fork-runtime'
import type {
  GetWorktreeCreationRequest,
  WorktreeCreationActionRequest,
  WorktreeCreationRequest,
  WorktreeCreationSnapshot,
} from '../../shared/worktree-creation'

export interface WorktreeCreationRuntime {
  registerHost(host: BackendHost): void
  createWorktreeTransaction(input: WorktreeCreationRequest): Promise<WorktreeCreationSnapshot>
  getWorktreeCreation(input: GetWorktreeCreationRequest): Promise<WorktreeCreationSnapshot>
  actOnWorktreeCreation(input: WorktreeCreationActionRequest): Promise<WorktreeCreationSnapshot>
}

type WorktreeCreationRuntimeApi = WorktreeCreationApi

export type WorktreeCreationServiceFactory = (
  progressSink: WorktreeCreationProgressSink,
) => Promise<WorktreeCreationRuntimeApi>

export function createWorktreeCreationRuntime(
  initialHost: BackendHost,
  createService: WorktreeCreationServiceFactory,
): WorktreeCreationRuntime {
  const progressSink: RetargetableWorktreeCreationProgressSink =
    createWorktreeCreationProgressSink(initialHost)
  const service = createService(progressSink)
  const api: WorktreeCreationApi = {
    createWorktreeTransaction: async (input) =>
      (await service).createWorktreeTransaction(input),
    getWorktreeCreation: async (input) =>
      (await service).getWorktreeCreation(input),
    actOnWorktreeCreation: async (input) =>
      (await service).actOnWorktreeCreation(input),
  }
  const registerHost = (host: BackendHost): void => {
    progressSink.registerHost(host)
    registerWorktreeCreationHandlers(host, api)
  }
  registerHost(initialHost)
  return {
    registerHost,
    createWorktreeTransaction: api.createWorktreeTransaction,
    getWorktreeCreation: api.getWorktreeCreation,
    actOnWorktreeCreation: api.actOnWorktreeCreation,
  }
}

export function createDefaultWorktreeCreationRuntime(
  host: BackendHost,
  getProviderRegistry: () => ManagedProviderRegistry | null = () => null,
): WorktreeCreationRuntime {
  return createWorktreeCreationRuntime(host, async (progressSink) => {
    const database = getDb()
    const store = new SqliteWorktreeCreationStore(database)
    const forks = new SqliteConversationForkStore(database)
    const git = new ExecFileGitWorktreeAdapter()
    const providerArtifacts = new DefaultProviderForkArtifacts({
      resolveInstance: getProviderInstanceFull,
      listCompatibleSessionIds: (conversationId, providerInstanceId) => {
        const ids = listConversationSegments(conversationId)
          .filter((segment) => segment.provider === 'claude-code'
            && segment.provider_instance_id === providerInstanceId)
          .map((segment) => segment.provider_session_id)
        const row = getConversationById(conversationId)
        if (row?.agent_type === 'claude-code'
          && row.provider_instance_id === providerInstanceId
          && row.session_id
          && !ids.includes(row.session_id)) ids.push(row.session_id)
        return ids
      },
    })
    const service = startWorktreeCreationService({
      store,
      git,
      progressSink,
      userDataDir: userDataDir(),
      setupConfig: new LaunchConfigWorktreeSetupConfig(),
      setupRunner: new ProcessWorktreeSetupRunner(),
      startupLauncher: new ProviderWorktreeStartupLauncher(
        getProviderRegistry,
        new WorktreeLaunchConfigTerminalProvisioner(
          readLaunchConfig,
          getManagedTerminalRuntime(),
        ),
      ),
      forkOwner: new ForkWorktreeOwnerAdapter(store, forks, providerArtifacts),
    })
    configureConversationForkWorktreePort(new ConversationForkWorktreePort(service, forks, git))
    return service
  })
}
