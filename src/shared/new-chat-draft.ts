/**
 * A new chat starts as a renderer-only draft: no conversation row, no provider
 * session, no worktree. Its id is stable per (machine, project), so the text
 * the draft store persists under that id comes back after a relaunch, and a
 * second "new chat" for the same project reopens the same draft instead of
 * stacking empty ones.
 */
/** `existing` starts the chat inside a worktree that is already on disk. */
export type DraftCheckout = 'project' | 'worktree' | 'existing'

export interface DraftChatOptions {
  checkout: DraftCheckout
  /** Base ref for a new worktree. Ignored for the other checkouts. */
  baseRef: string
  /** The worktree an `existing` checkout runs in. */
  existing?: { path: string; branch: string }
}

const PREFIX = 'draft:'

export function draftSessionId(machineId: string, projectPath: string): string {
  return `${PREFIX}${machineId}:${projectPath}`
}

export function isDraftSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(PREFIX)
}
