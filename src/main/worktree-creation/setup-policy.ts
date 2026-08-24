import type { WorktreeSetupConfig } from '../../shared/launch-config'
import type {
  WorktreeSetupPolicy,
  WorktreeSetupReceipt,
} from '../../shared/worktree-creation'

type SetupAction = 'await_decision' | 'run' | 'skip' | 'not_configured'

export interface ResolvedWorktreeSetup {
  action: SetupAction
  startupPolicy: 'wait-for-setup' | 'start-immediately'
  command?: string
  receipt: WorktreeSetupReceipt
}

export function resolveWorktreeSetup(
  requestedPolicy: WorktreeSetupPolicy,
  config: WorktreeSetupConfig | undefined,
): ResolvedWorktreeSetup {
  const startupPolicy = config?.startupPolicy ?? 'wait-for-setup'
  const resolvedPolicy = requestedPolicy === 'inherit'
    ? config?.defaultPolicy ?? 'skip'
    : requestedPolicy

  if (resolvedPolicy === 'ask') {
    return {
      action: 'await_decision',
      startupPolicy,
      ...(config?.command ? { command: config.command } : {}),
      receipt: {
        requestedPolicy,
        resolvedPolicy,
        status: 'awaiting_decision',
        ...(config?.command ? { commandSource: 'launch-config' } : {}),
      },
    }
  }

  if (resolvedPolicy === 'run') {
    if (!config?.command) {
      return {
        action: 'not_configured',
        startupPolicy,
        receipt: {
          requestedPolicy,
          resolvedPolicy,
          status: 'not_configured',
        },
      }
    }
    return {
      action: 'run',
      startupPolicy,
      command: config.command,
      receipt: {
        requestedPolicy,
        resolvedPolicy,
        status: 'pending',
        commandSource: 'launch-config',
      },
    }
  }

  return {
    action: 'skip',
    startupPolicy,
    receipt: {
      requestedPolicy,
      resolvedPolicy: 'skip',
      status: config ? 'skipped' : 'not_configured',
    },
  }
}
