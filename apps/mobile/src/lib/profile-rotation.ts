/**
 * Orchestrates ThreadScreen's "rotate to another instance of the SAME
 * agent" branch of `rotateProfile`. Dependencies are injected so the
 * `context-unavailable` DB-only repoint path - no live backend session for
 * this thread yet, e.g. a freshly created thread nobody has sent a first
 * message on - is testable without react-native, navigation, or a real
 * backend.
 *
 * That path mirrors the desktop client (ChatPanel.tsx handleInstanceChange):
 * `switchInstance` requires a live session to rotate, so its refusal here is
 * not an error to surface, it is the signal to persist the pick against the
 * conversation row directly instead - never starting or stopping a session,
 * never losing the conversation.
 */
import type { ProviderInstanceSwitchResult } from '@shared/provider-events'

export type ProfileRotationOutcome =
  | { kind: 'switched' }
  | { kind: 'conflict'; message: string }
  /** No live session to rotate - the caller must fall back to a DB-only
   *  write (`setConversationProviderInstanceId`), never start/stop a session. */
  | { kind: 'db-only-repoint' }
  | { kind: 'error'; message: string }

export function classifySwitchResult(result: ProviderInstanceSwitchResult): ProfileRotationOutcome {
  if (result.ok) return { kind: 'switched' }
  if (result.code === 'context-conflict') return { kind: 'conflict', message: result.message }
  if (result.code === 'context-unavailable') return { kind: 'db-only-repoint' }
  return { kind: 'error', message: result.message }
}

export interface RotateWithinAgentDeps {
  switchInstance: (
    threadId: string,
    input: {
      targetInstanceId: string
      expectedCurrentInstanceId: string | null
      onContextConflict?: 'fail' | 'start-fresh'
    },
  ) => Promise<ProviderInstanceSwitchResult>
  /** DB-only repoint for the `db-only-repoint` outcome. */
  setConversationProviderInstanceId: (threadId: string, instanceId: string) => Promise<unknown>
  /** Prompts "stay here" vs "start fresh" for a `conflict` outcome; resolves
   *  true to retry with `onContextConflict: 'start-fresh'`. */
  confirmStartFresh: (message: string) => Promise<boolean>
}

export type RotateWithinAgentResult =
  /** The caller should update its local provider/instance state. */
  | { applied: true }
  /** The user chose to stay on the current profile at a conflict prompt. */
  | { applied: false }

/**
 * Throws with a user-facing message on any outcome other than a successful
 * switch, a completed DB-only repoint, or a declined conflict prompt - the
 * caller's existing catch/reportError handles surfacing it.
 */
export async function rotateWithinAgent(
  threadId: string,
  currentInstanceId: string | undefined,
  nextInstanceId: string,
  deps: RotateWithinAgentDeps,
): Promise<RotateWithinAgentResult> {
  const result = await deps.switchInstance(threadId, {
    targetInstanceId: nextInstanceId,
    expectedCurrentInstanceId: currentInstanceId ?? null,
  })
  let outcome = classifySwitchResult(result)

  if (outcome.kind === 'conflict') {
    const startFresh = await deps.confirmStartFresh(outcome.message)
    if (!startFresh) return { applied: false }
    const retried = await deps.switchInstance(threadId, {
      targetInstanceId: nextInstanceId,
      expectedCurrentInstanceId: currentInstanceId ?? null,
      onContextConflict: 'start-fresh',
    })
    outcome = classifySwitchResult(retried)
  }

  if (outcome.kind === 'error') throw new Error(outcome.message)
  if (outcome.kind === 'db-only-repoint') {
    await deps.setConversationProviderInstanceId(threadId, nextInstanceId)
  }
  return { applied: true }
}
