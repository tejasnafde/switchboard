/**
 * A new chat starts as a renderer-only draft: no conversation row, no provider
 * session, no worktree. Its id is stable per (machine, project), so the text
 * the draft store persists under that id comes back after a relaunch, and a
 * second "new chat" for the same project reopens the same draft instead of
 * stacking empty ones.
 */
export type DraftCheckout = 'project' | 'worktree'

export interface DraftChatOptions {
  checkout: DraftCheckout
  /** Base ref for a new worktree. Ignored for a project checkout. */
  baseRef: string
}

const PREFIX = 'draft:'

export function draftSessionId(machineId: string, projectPath: string): string {
  return `${PREFIX}${machineId}:${projectPath}`
}

export function isDraftSessionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(PREFIX)
}
