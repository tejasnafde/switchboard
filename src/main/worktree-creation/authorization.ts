import type {
  WorktreeCreationActionRequest,
  WorktreeCreationRequest,
} from '../../shared/worktree-creation'
import { currentBackendRequestContext, remoteDeviceHasScope } from '../backend/request-context'

export function authorizeWorktreeCreationRequest(
  request: WorktreeCreationRequest,
): WorktreeCreationRequest {
  const remote = currentBackendRequestContext()?.transport === 'remote'
  const canProvisionTerminals = remoteDeviceHasScope('terminal')
  if (remote && !canProvisionTerminals && request.setup.policy !== 'skip') {
    throw new Error('Remote worktree setup requires the terminal device scope; choose skip setup.')
  }
  if (remote && !canProvisionTerminals && request.launch?.startupCommand) {
    throw new Error('A remote startup command requires the terminal device scope.')
  }
  if (!request.launch) return request
  return {
    ...request,
    launch: {
      ...request.launch,
      terminalPolicy: canProvisionTerminals
        ? request.launch.terminalPolicy ?? 'provision'
        : 'skip',
    },
  }
}

export function authorizeWorktreeCreationAction(
  request: WorktreeCreationRequest,
  action: WorktreeCreationActionRequest['action'],
): void {
  if (currentBackendRequestContext()?.transport !== 'remote' || remoteDeviceHasScope('terminal')) return
  if (action === 'choose_setup_run') {
    throw new Error('Remote worktree setup requires the terminal device scope.')
  }
  if (action === 'remove') {
    throw new Error('Remote worktree removal requires the terminal device scope.')
  }
  if (action !== 'retry' && action !== 'choose_setup_skip') return
  if (action === 'retry' && request.setup.policy !== 'skip') {
    throw new Error('Retrying remote worktree setup requires the terminal device scope.')
  }
  if (request.launch && request.launch.terminalPolicy !== 'skip') {
    throw new Error('Retrying remote terminal provisioning requires the terminal device scope.')
  }
}
