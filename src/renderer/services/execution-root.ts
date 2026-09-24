/**
 * Where a session actually runs, for the renderer.
 *
 * Every terminal-creation entry point used to inline its own lookup, and five
 * of them read `session.projectPath` directly. That is why a chat could follow
 * a worktree and still open its next terminal in the parent checkout: the
 * branch chip moved, the cwd expression did not.
 *
 * There is now one lookup. Call it instead of reaching into the store.
 */
import { resolveExecutionRoot, type ExecutionRoot } from '../../shared/execution-root'
import { useAgentStore } from '../stores/agent-store'

/** The parts of a session that determine its execution root. */
export interface ExecutionRootBearingSession {
  projectPath?: string
  worktreePath?: string | null
  worktreeBranch?: string | null
  machineId?: string
  executionRootRevision?: number
}

/**
 * Pure form. Returns null when the session has no project identity at all,
 * which is the one case where there is genuinely no root to report - callers
 * then fall back to their own default rather than inventing a path.
 */
export function executionRootForSession(
  session: ExecutionRootBearingSession | null | undefined,
): ExecutionRoot | null {
  if (!session?.projectPath) return null
  return resolveExecutionRoot({
    projectPath: session.projectPath,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    machineId: session.machineId,
    executionRootRevision: session.executionRootRevision,
  })
}

/** Store-bound form. Reads the CURRENT root, so it tracks a relocation. */
export function sessionExecutionRoot(sessionId: string | null | undefined): ExecutionRoot | null {
  if (!sessionId) return null
  return executionRootForSession(
    useAgentStore.getState().sessions.find((s) => s.id === sessionId),
  )
}

/**
 * The cwd to hand a new terminal. `undefined` rather than null, because that
 * is what `PaneOptions.cwd` and `terminal:create` already expect for "no
 * opinion".
 */
export function sessionExecutionRootPath(sessionId: string | null | undefined): string | undefined {
  return sessionExecutionRoot(sessionId)?.path
}
