import type { MobileNewSessionCreationState, MobileNewSessionIntent } from './newSessionCreation'

export function shouldOfferWorktreeCreation(
  capabilitySupported: boolean | undefined,
  state: MobileNewSessionCreationState,
): boolean {
  if (capabilitySupported === true) return true
  return state.intent?.checkout.kind === 'worktree' &&
    state.status !== 'idle' &&
    state.status !== 'ready'
}

export function restoredWorktreeForm(intent: MobileNewSessionIntent | undefined) {
  if (intent?.checkout.kind !== 'worktree') return null
  return {
    checkoutKind: 'worktree' as const,
    baseRef: intent.checkout.baseRef,
    setupPolicy: intent.checkout.setupPolicy,
    provider: intent.provider,
    agentType: intent.conversation.agentType,
    firstMessage: intent.firstMessage ?? '',
  }
}
