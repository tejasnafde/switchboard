/**
 * Turning a relocation result into what the chat UI should do.
 *
 * The old Follow button had one outcome because it only wrote a pointer. A
 * real transaction has several, and three of them are not failures: the move
 * happened, it was already there, or it is waiting for the running turn.
 *
 * "Queued" is the one worth being careful about. Reporting it as an error
 * would make the user click again, and two relocations racing for one thread
 * is exactly what the backend's claim exists to prevent - so the UI should
 * not manufacture the race it is being protected from.
 */
import type { RelocateExecutionRootResult } from '@shared/execution-root-relocation'

export interface RelocationOutcomeView {
  /** Apply to the session store. Null means nothing moved. */
  applyRoot: { path: string; branch: string | null; revision: number } | null
  /** Drop the drift suggestion. False while a queued move is still pending. */
  clearSuggestion: boolean
  /** One short line, or null when the branch chip already tells the story. */
  notice: string | null
  isError: boolean
  /** The same request could plausibly succeed if repeated. */
  retryable: boolean
  /** Offer a deliberate restart that loses the thread. */
  offerRestart: boolean
}

const NOTICES: Partial<Record<string, string>> = {
  'stale-revision': 'This chat moved somewhere else in the meantime. Try again.',
  busy: 'This chat is already changing. Try again in a moment.',
  'target-missing': 'That worktree no longer exists.',
  'different-repository': 'That directory belongs to a different repository.',
  'invalid-target': 'That is not a usable directory for this chat.',
  'wrong-machine': 'That directory belongs to a different machine.',
  'continuity-unsupported':
    'This agent cannot carry the conversation into another directory. Restarting it there would lose the thread.',
  'rollback-failed':
    'The move failed and the agent could not be restarted where it was. Restart the chat to continue.',
}

export function describeRelocationOutcome(
  result: RelocateExecutionRootResult,
): RelocationOutcomeView {
  if (result.ok) {
    if (result.outcome === 'queued') {
      return {
        applyRoot: null,
        // Keep the suggestion: nothing has moved yet, and dropping it would
        // leave no sign that anything is pending if the turn errors out.
        clearSuggestion: false,
        notice: 'Following when this turn finishes.',
        isError: false,
        retryable: false,
        offerRestart: false,
      }
    }
    return {
      applyRoot: {
        path: result.root.path,
        branch: result.root.branch,
        revision: result.root.revision,
      },
      clearSuggestion: true,
      // The branch chip and the terminal defaults have already changed. A
      // toast saying so would be telling the user what they can see.
      notice: null,
      isError: false,
      retryable: false,
      offerRestart: false,
    }
  }

  const known = NOTICES[result.code]
  const notice = result.rolledBack && !known
    ? `${result.message} The chat is still in its original directory.`
    : known ?? result.message

  return {
    applyRoot: null,
    // A target that is gone cannot be followed on a retry either, so the
    // suggestion is dead and should stop being offered.
    clearSuggestion: result.code === 'target-missing' || result.code === 'different-repository',
    notice: result.rolledBack && known ? `${known} The chat is still in its original directory.` : notice,
    isError: true,
    retryable: result.code === 'busy' || result.code === 'stale-revision',
    offerRestart: result.code === 'continuity-unsupported',
  }
}
