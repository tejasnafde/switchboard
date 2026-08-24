import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { parseLaunchConfigFile, type LaunchConfig, type LaunchConfigTerminal } from '../../shared/launch-config'
import type { UserTurnSubmissionResult, UserTurnSubmissionV1, ProviderKind } from '../../shared/provider-events'
import type { WorkspaceLaunchIntent } from '../../shared/worktree-creation'
import type { ProviderSession, SessionStartOpts } from '../provider/types'
import type {
  ManagedTerminalProvisioningResult,
  ManagedTerminalSpec,
  ManagedTerminalRuntime,
} from '../terminal/managed-terminal-runtime'
import type { WorktreeStartupLauncherPort } from './worktree-creation-service'

export interface ManagedProviderRegistry {
  startManagedSession(input: SessionStartOpts): Promise<ProviderSession>
  submitManagedUserTurn(input: UserTurnSubmissionV1): Promise<UserTurnSubmissionResult>
}

export interface WorktreeTerminalProvisioner {
  provision(input: {
    creationId: string
    projectPath: string
    worktreePath: string
    launch: WorkspaceLaunchIntent
  }): Promise<ManagedTerminalProvisioningResult>
}

type LaunchConfigReader = (projectPath: string) => string | null

function stableTerminalId(creationId: string, position: string): string {
  const creationHash = createHash('sha256').update(creationId).digest('hex').slice(0, 16)
  return `worktree-${creationHash}-${position}`
}

function rootedCwd(worktreePath: string, cwd: string | undefined): string {
  const root = resolve(worktreePath)
  const candidate = resolve(root, cwd ?? '.')
  const fromRoot = relative(root, candidate)
  if (fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromRoot)) {
    throw new Error('Launch config terminal cwd escapes the worktree.')
  }
  return candidate
}

function selectedConfig(yaml: string | null, requestedName: string | undefined): LaunchConfig {
  if (!yaml) return { terminals: [] }
  const file = parseLaunchConfigFile(yaml)
  const configs = file.configs ?? {}
  return (requestedName ? configs[requestedName] : undefined) ??
    configs.default ??
    { terminals: file.terminals, ...(file.rows ? { rows: file.rows } : {}) }
}

function configTerminals(config: LaunchConfig): Array<{
  terminal: LaunchConfigTerminal
  position: string
}> {
  if (config.rows?.length) {
    return config.rows.flatMap((row, rowIndex) =>
      row.panes.map((terminal, paneIndex) => ({
        terminal,
        position: `r${rowIndex}-p${paneIndex}`,
      })),
    )
  }
  return config.terminals.map((terminal, paneIndex) => ({
    terminal,
    position: `r0-p${paneIndex}`,
  }))
}

export class WorktreeLaunchConfigTerminalProvisioner implements WorktreeTerminalProvisioner {
  constructor(
    private readonly readConfig: LaunchConfigReader,
    private readonly runtime: ManagedTerminalRuntime,
  ) {}

  async provision(input: {
    creationId: string
    projectPath: string
    worktreePath: string
    launch: WorkspaceLaunchIntent
  }): Promise<ManagedTerminalProvisioningResult> {
    let terminals: ManagedTerminalSpec[]
    try {
      const config = selectedConfig(
        this.readConfig(input.projectPath),
        input.launch.launchConfigName,
      )
      terminals = configTerminals(config).map(({ terminal, position }) => ({
        id: stableTerminalId(input.creationId, position),
        cwd: rootedCwd(input.worktreePath, terminal.cwd),
        ...(terminal.on_start ? { initialCommand: terminal.on_start } : {}),
        ...(terminal.wait_for ? { waitFor: terminal.wait_for } : {}),
      }))
      if (terminals.length === 0) {
        terminals.push({
          id: stableTerminalId(input.creationId, 'r0-p0'),
          cwd: rootedCwd(input.worktreePath, undefined),
        })
      }
      if (input.launch.startupCommand) {
        terminals.push({
          id: stableTerminalId(input.creationId, 'startup'),
          cwd: rootedCwd(input.worktreePath, undefined),
          initialCommand: input.launch.startupCommand,
        })
      }
    } catch {
      return { status: 'failed', terminalIds: [] }
    }
    return this.runtime.provision(terminals)
  }
}

function providerKind(provider: Exclude<WorkspaceLaunchIntent['initialAgent'], undefined>['provider']): ProviderKind {
  return provider === 'claude-code' ? 'claude' : provider
}

export class ProviderWorktreeStartupLauncher implements WorktreeStartupLauncherPort {
  constructor(
    private readonly registry: () => ManagedProviderRegistry | null,
    private readonly terminals?: WorktreeTerminalProvisioner,
  ) {}

  async launch(input: Parameters<WorktreeStartupLauncherPort['launch']>[0]) {
    let terminalIds: string[] = []
    if (this.terminals && input.launch.terminalPolicy !== 'skip') {
      const terminalResult = await this.terminals.provision({
        creationId: input.creationId,
        projectPath: input.projectPath,
        worktreePath: input.worktreePath,
        launch: input.launch,
      })
      terminalIds = terminalResult.terminalIds
      if (terminalResult.status === 'failed') {
        return { status: 'failed' as const, terminalIds }
      }
    }

    const initialAgent = input.launch.initialAgent
    if (!initialAgent) return { status: 'succeeded' as const, terminalIds }
    const registry = this.registry()
    if (!registry) return { status: 'failed' as const, terminalIds }
    let session: ProviderSession
    try {
      session = await registry.startManagedSession({
        threadId: input.conversationId,
        provider: providerKind(initialAgent.provider),
        cwd: input.worktreePath,
        ...(initialAgent.instanceId ? { instanceId: initialAgent.instanceId } : {}),
        ...(initialAgent.model ? { model: initialAgent.model } : {}),
        ...(initialAgent.runtimeMode ? { runtimeMode: initialAgent.runtimeMode } : {}),
      })
    } catch {
      return { status: 'failed' as const, terminalIds }
    }
    if (!initialAgent.prompt) {
      return {
        status: 'succeeded' as const,
        terminalIds,
        providerThreadId: session.threadId,
      }
    }
    try {
      const result = await registry.submitManagedUserTurn({
        version: 1,
        threadId: input.conversationId,
        origin: input.initialPromptOrigin,
        providerText: initialAgent.prompt,
        displayBody: initialAgent.prompt,
        ...(initialAgent.runtimeMode ? { runtimeMode: initialAgent.runtimeMode } : {}),
      })
      return {
        status: result.status === 'accepted'
          ? 'succeeded' as const
          : result.status === 'pending' || result.status === 'ambiguous'
            ? 'ambiguous' as const
            : 'failed' as const,
        terminalIds,
        providerThreadId: session.threadId,
        initialPromptOrigin: input.initialPromptOrigin,
      }
    } catch {
      return {
        status: 'ambiguous' as const,
        terminalIds,
        providerThreadId: session.threadId,
        initialPromptOrigin: input.initialPromptOrigin,
      }
    }
  }
}
