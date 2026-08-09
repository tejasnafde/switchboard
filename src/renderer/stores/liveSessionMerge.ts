/**
 * Fold the backend's running sessions into this window's list.
 *
 * Every agent-store reducer is a `sessions.map(...)`, so an event for a thread
 * this window did not start matched no row and was dropped. A phone-started
 * chat looked idle while it streamed, and its sub-agent messages - which exist
 * only in the live stream - were unrecoverable.
 *
 * Generic over the row type so the rules test without a whole `AgentSession`.
 */

import type { LiveSessionSummary } from '@shared/live-sessions'

export type { LiveSessionSummary }

/** The backend also has `connecting` and `stopped`, which no renderer code
 *  handles. A blind cast stranded rows in states nothing matches. */
export function toAgentStatus(status: string): 'idle' | 'running' | 'thinking' | 'error' | 'exited' {
  switch (status) {
    case 'running':
    case 'thinking':
    case 'error':
      return status
    case 'connecting':
      // Nothing has streamed yet, but a turn is on its way.
      return 'running'
    case 'stopped':
      return 'exited'
    default:
      return 'idle'
  }
}

/** `claude` on the wire is `claude-code` in the store. Total by design. */
export function toAgentType(provider: string): 'claude-code' | 'codex' | 'opencode' {
  switch (provider) {
    case 'codex':
    case 'opencode':
      return provider
    default:
      return 'claude-code'
  }
}

export interface MergeInput<Row> {
  existing: readonly Row[]
  live: readonly LiveSessionSummary[]
  /** Build a row for a session this window has never seen. */
  create: (session: LiveSessionSummary) => Row
  /** Update a row that already exists. Status ONLY - see below. */
  applyStatus: (row: Row, status: string) => Row
  /** Defaults to reading `.id`. */
  idOf?: (row: Row) => string
}

/**
 * Existing rows take a status update and nothing else - this window's row is
 * better informed about everything except whether a turn is live. A session
 * absent from `live` is left alone: not started is not the same as closed.
 */
export function mergeLiveSessions<Row>(input: MergeInput<Row>): Row[] {
  const idOf = input.idOf ?? ((row: Row) => (row as { id: string }).id)
  const byId = new Map<string, LiveSessionSummary>()
  // Last writer wins on a duplicate.
  for (const session of input.live) byId.set(session.threadId, session)

  const updated = input.existing.map((row) => {
    const match = byId.get(idOf(row))
    if (!match) return row
    byId.delete(idOf(row))
    return input.applyStatus(row, match.status)
  })

  // Appended: the sidebar renders this order, and reshuffling on every
  // reconnect would move rows under the user's cursor.
  return [...updated, ...[...byId.values()].map(input.create)]
}
