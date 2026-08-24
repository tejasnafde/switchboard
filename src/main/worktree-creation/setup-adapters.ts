import { spawn } from 'node:child_process'
import { parseLaunchConfigFile, type WorktreeSetupConfig } from '../../shared/launch-config'
import { readLaunchConfig } from '../launch-config/launch-config-store'
import type {
  WorktreeSetupConfigPort,
  WorktreeSetupRunnerPort,
} from './worktree-creation-service'

type LaunchConfigReader = (projectPath: string) => string | null | Promise<string | null>

export const DEFAULT_SETUP_TIMEOUT_MS = 30 * 60 * 1_000

export class LaunchConfigWorktreeSetupConfig implements WorktreeSetupConfigPort {
  constructor(private readonly read: LaunchConfigReader = readLaunchConfig) {}

  async load(projectPath: string): Promise<WorktreeSetupConfig | undefined> {
    const yaml = await this.read(projectPath)
    if (!yaml) return undefined
    return parseLaunchConfigFile(yaml).worktree?.setup
  }
}

interface SetupProcessResult {
  exitCode: number
}

type SetupProcessExecutor = (input: {
  cwd: string
  command: string
  signal: AbortSignal
}) => Promise<SetupProcessResult>

const executeSetupProcess: SetupProcessExecutor = ({ cwd, command, signal }) => new Promise((resolve, reject) => {
  const child = spawn(command, {
    cwd,
    shell: true,
    stdio: 'ignore',
    env: process.env,
    signal,
  })
  child.once('error', reject)
  child.once('close', (code) => resolve({ exitCode: code ?? 1 }))
})

export class ProcessWorktreeSetupRunner implements WorktreeSetupRunnerPort {
  constructor(
    private readonly execute: SetupProcessExecutor = executeSetupProcess,
    private readonly timeoutMs: number = DEFAULT_SETUP_TIMEOUT_MS,
  ) {}

  async run(input: {
    creationId: string
    cwd: string
    command: string
    signal?: AbortSignal
  }): ReturnType<WorktreeSetupRunnerPort['run']> {
    const controller = new AbortController()
    const cancel = (): void => controller.abort()
    if (input.signal?.aborted) return Promise.resolve({ kind: 'outcome_unknown' })
    input.signal?.addEventListener('abort', cancel, { once: true })
    const timeout = setTimeout(cancel, this.timeoutMs)
    try {
      const result = await this.execute({
        cwd: input.cwd,
        command: input.command,
        signal: controller.signal,
      })
      return result.exitCode === 0
        ? { kind: 'succeeded', exitCode: result.exitCode }
        : { kind: 'failed', exitCode: result.exitCode }
    } catch {
      return controller.signal.aborted ? { kind: 'outcome_unknown' } : { kind: 'failed' }
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', cancel)
    }
  }
}
