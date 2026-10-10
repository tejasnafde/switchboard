/**
 * Pure JSONL truncation for the "Fork from here" feature.
 *
 * The renderer hands us a 1-based count of *visible* events to keep
 * (its own message-array index of the clicked message). We replay the
 * same visibility predicate the JsonlParser uses, copy lines through
 * the Nth visible event, and report the resume anchor (Claude only -
 * Codex events lack a stable per-line id).
 *
 * Non-visible meta lines (Claude `summary`, Codex `session_meta` /
 * `event_msg`, system/developer prompts) ride along verbatim so the
 * truncated file still parses cleanly when the agent's CLI reloads it.
 *
 * Kept pure (no fs, no path encoding) so the orchestration in fork.ts
 * stays testable in isolation and these primitives are easy to reuse.
 */

export interface TruncateClaudeOptions {
  /**
   * If provided, every kept line's `sessionId` field is rewritten to
   * this value. The Claude SDK keys resume by filename, but the per-line
   * sessionId is what shows up in the UI's session metadata - keep them
   * in sync so the new file reads as a brand-new session, not a clone.
   */
  newSessionId?: string
  /** Execution root recorded in Claude's native history. Forks into a
   * worktree must not retain the source checkout as their resumed cwd. */
  newCwd?: string
}

export interface TruncateClaudeAtEventResult extends TruncateClaudeResult {
  anchorFound: boolean
}

export interface TruncateClaudeResult {
  newContent: string
  /** uuid of the last kept visible line - the resume anchor - or null if none. */
  anchorUuid: string | null
  keptVisibleCount: number
}

/** Same predicate as JsonlParser's Claude branch - exported so fork.ts
 *  can count visible events per fragment without re-implementing it. */
export function isClaudeVisible(event: Record<string, unknown>): boolean {
  const type = event.type
  if (type === 'assistant') {
    return assistantHasContent(event.message)
  }
  if (type === 'user') {
    return userHasContent(event.message)
  }
  if (type === 'result') return true
  return false
}

function assistantHasContent(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const m = message as Record<string, unknown>
  if (typeof m.content === 'string') return m.content.length > 0
  if (Array.isArray(m.content)) {
    return m.content.some((b: Record<string, unknown>) => b.type === 'text' || b.type === 'tool_use')
  }
  return false
}

function userHasContent(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const m = message as Record<string, unknown>
  if (typeof m.content === 'string') return m.content.length > 0
  if (Array.isArray(m.content)) {
    if (m.content.length === 0) return false
    // Pure tool_result/image blocks come from the tool-use protocol - the
    // parser hides them from the user-facing transcript. An image block
    // with no surrounding text is still "visible" because Switchboard
    // keeps image-only user messages.
    const onlyToolResults = m.content.every((b: Record<string, unknown>) => b.type === 'tool_result')
    if (onlyToolResults) return false
    return true
  }
  return false
}

/**
 * Assemble a Claude transcript through one exact durable JSONL event.
 *
 * This is the fork boundary used by the reliable contract. Unlike the
 * legacy visible-count helper, repeated text or renderer-only rows cannot
 * move the cut. A missing or duplicated event id is rejected as ambiguous.
 */
export function assembleClaudeForkAtEvent(
  fragments: string[],
  anchorEventId: string,
  opts: TruncateClaudeOptions = {},
): TruncateClaudeAtEventResult {
  const parsedFragments = fragments.map((content) =>
    content.split('\n').flatMap((raw) => {
      const trimmed = raw.trim()
      if (!trimmed) return []
      try {
        return [{ parsed: JSON.parse(trimmed) as Record<string, unknown> }]
      } catch {
        return []
      }
    }),
  )
  const matches = parsedFragments
    .flat()
    .filter(({ parsed }) => isClaudeVisible(parsed) && parsed.uuid === anchorEventId)
  if (matches.length !== 1) {
    return {
      newContent: '',
      anchorUuid: null,
      keptVisibleCount: 0,
      anchorFound: false,
    }
  }

  const kept: string[] = []
  let keptVisibleCount = 0
  let found = false
  for (const fragment of parsedFragments) {
    for (const { parsed } of fragment) {
      const visible = isClaudeVisible(parsed)
      if (visible) keptVisibleCount++
      if (opts.newSessionId) parsed.sessionId = opts.newSessionId
      if (opts.newCwd) parsed.cwd = opts.newCwd
      kept.push(JSON.stringify(parsed))
      if (visible && parsed.uuid === anchorEventId) {
        found = true
        break
      }
    }
    if (found) break
  }

  return {
    newContent: kept.length > 0 ? `${kept.join('\n')}\n` : '',
    anchorUuid: found ? anchorEventId : null,
    keptVisibleCount,
    anchorFound: found,
  }
}
