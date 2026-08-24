import type { BackendHost } from '../backend/host'
import { getDb } from '../db/database'
import { SqliteWorktreeCreationStore } from '../db/worktree-creation'
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
  ForkWorktreeCoordinator,
  ForkWorktreeOwnerAdapter,
  type ForkWorktreeCoordinatorInput,
} from '../conversations/fork-worktree-owner'
import type { ForkWorktreeCreationResult } from '../conversations/fork'
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
  forkConversationWithWorktree(input: ForkWorktreeCoordinatorInput): Promise<ForkWorktreeCreationResult>
}

interface WorktreeCreationRuntimeApi extends WorktreeCreationApi {
  forkConversationWithWorktree?(input: ForkWorktreeCoordinatorInput): Promise<ForkWorktreeCreationResult>
}

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
  const forkConversationWithWorktree = async (
    input: ForkWorktreeCoordinatorInput,
  ): Promise<ForkWorktreeCreationResult> => {
    const coordinator = (await service).forkConversationWithWorktree
    if (!coordinator) throw new Error('Fork worktree creation is unavailable in this runtime.')
    return coordinator(input)
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
    forkConversationWithWorktree,
  }
}

export function createDefaultWorktreeCreationRuntime(
  host: BackendHost,
  getProviderRegistry: () => ManagedProviderRegistry | null = () => null,
): WorktreeCreationRuntime {
  return createWorktreeCreationRuntime(host, async (progressSink) => {
    const store = new SqliteWorktreeCreationStore(getDb())
    const service = startWorktreeCreationService({
      store,
      git: new ExecFileGitWorktreeAdapter(),
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
      forkOwner: new ForkWorktreeOwnerAdapter(store),
    })
    const coordinator = new ForkWorktreeCoordinator(service)
    return Object.assign(service, {
      forkConversationWithWorktree: (input: ForkWorktreeCoordinatorInput) => coordinator.create(input),
    })
  })
}
