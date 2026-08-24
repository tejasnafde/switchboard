import {
  displayedChatSessionIds,
  focusedChatSessionId,
  type ChatWorkspaceState,
} from './chatWorkspace'

type WorkspaceController = {
  selectSession?: (sessionId: string) => void
  removeSession?: (sessionId: string) => void
  rotateSession?: (fromSessionId: string, toSessionId: string) => void
}

let workspace: ChatWorkspaceState = {
  primarySessionId: null,
  secondarySessionId: null,
  focusedSlot: 'primary',
  splitRatio: 0.5,
}
let controller: WorkspaceController = {}

export function publishChatWorkspace(next: ChatWorkspaceState): void {
  workspace = next
}

export function displayedChatSessions(): string[] {
  return displayedChatSessionIds(workspace)
}

export function isChatSessionDisplayed(sessionId: string): boolean {
  return displayedChatSessions().includes(sessionId)
}

export function focusedRuntimeChatSession(): string | null {
  return focusedChatSessionId(workspace)
}

export function registerChatWorkspaceController(next: WorkspaceController): void {
  controller = next
}

export function selectRuntimeChatSession(sessionId: string): boolean {
  if (!controller.selectSession) return false
  controller.selectSession(sessionId)
  return true
}

export function removeRuntimeChatSession(sessionId: string): void {
  controller.removeSession?.(sessionId)
}

export function rotateRuntimeChatSession(fromSessionId: string, toSessionId: string): void {
  controller.rotateSession?.(fromSessionId, toSessionId)
}

export function resetChatWorkspaceRuntimeForTests(): void {
  workspace = {
    primarySessionId: null,
    secondarySessionId: null,
    focusedSlot: 'primary',
    splitRatio: 0.5,
  }
  controller = {}
}
