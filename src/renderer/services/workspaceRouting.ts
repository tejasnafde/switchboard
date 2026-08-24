import { focusedChatSessionId, sessionForSlot, type ChatSlot, type ChatWorkspaceState } from './chatWorkspace'

export interface WorkspaceActionOrigin {
  explicitSessionId?: string | null
  terminalSessionId?: string | null
  ideSessionId?: string | null
  chatSlot?: ChatSlot | null
}

export function resolveWorkspaceActionSession(
  state: ChatWorkspaceState,
  origin: WorkspaceActionOrigin,
): string | null {
  return origin.explicitSessionId
    ?? origin.terminalSessionId
    ?? origin.ideSessionId
    ?? (origin.chatSlot ? sessionForSlot(state, origin.chatSlot) : null)
    ?? focusedChatSessionId(state)
    ?? state.primarySessionId
}
