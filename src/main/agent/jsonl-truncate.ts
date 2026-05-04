/**
 * Pure JSONL truncation for the "Fork from here" feature.
 *
 * The renderer hands us a 1-based count of *visible* events to keep
 * (its own message-array index of the clicked message). We replay the
 * same visibility predicate the JsonlParser uses, copy lines through
 * the Nth visible event, and report the resume anchor (Claude only —
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
   * sessionId is what shows up in the UI's session metadata — keep them
   * in sync so the new file reads as a brand-new session, not a clone.
   */
  newSessionId?: string
}

export interface TruncateClaudeResult {
  newContent: string
  /** uuid of the last kept visible line — the resume anchor — or null if none. */
  anchorUuid: string | null
  keptVisibleCount: number
}

/**
 * Truncate a Claude Code JSONL transcript through the Nth visible event.
 *
 * Visibility mirrors `JsonlParser.normalizeEvent` for the Claude branch:
 * `assistant` lines with text or tool_use, `user` lines with real text
 * or images (not pure tool_result blocks), and `result` lines.
 */
export function truncateClaudeJsonl(
  content: string,
  upToVisibleIndex: number,
  opts: TruncateClaudeOptions = {},
): TruncateClaudeResult {
  if (upToVisibleIndex <= 0) {
    return { newContent: '', anchorUuid: null, keptVisibleCount: 0 }
  }

  const lines = content.split('\n')
  const kept: string[] = []
  let visibleSoFar = 0
  let anchorUuid: string | null = null

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue

    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(trimmed) as Record<string, unknown> } catch { /* malformed — skip entirely */ continue }

    const visible = isClaudeVisible(parsed)
    if (visible) {
      // Stop if we've already kept N visible lines and this one would be N+1.
      if (visibleSoFar >= upToVisibleIndex) break
      visibleSoFar++
      if (typeof parsed.uuid === 'string') anchorUuid = parsed.uuid
    }

    if (opts.newSessionId && typeof parsed.sessionId === 'string') {
      parsed.sessionId = opts.newSessionId
      kept.push(JSON.stringify(parsed))
    } else {
      kept.push(trimmed)
    }
  }

  return {
    newContent: kept.length > 0 ? kept.join('\n') + '\n' : '',
    anchorUuid,
    keptVisibleCount: visibleSoFar,
  }
}

/** Same predicate as JsonlParser's Claude branch — exported so fork.ts
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
    // Pure tool_result/image blocks come from the tool-use protocol — the
    // parser hides them from the user-facing transcript. An image block
    // with no surrounding text is still "visible" because Switchboard
    // keeps image-only user messages.
    const onlyToolResults = m.content.every((b: Record<string, unknown>) =>
      b.type === 'tool_result',
    )
    if (onlyToolResults) return false
    return true
  }
  return false
}

// ── Codex ────────────────────────────────────────────────────────

export interface TruncateCodexResult {
  newContent: string
  keptVisibleCount: number
}

export function truncateCodexJsonl(
  content: string,
  upToVisibleIndex: number,
): TruncateCodexResult {
  if (upToVisibleIndex <= 0) {
    return { newContent: '', keptVisibleCount: 0 }
  }

  const lines = content.split('\n')
  const kept: string[] = []
  let visibleSoFar = 0

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(trimmed) as Record<string, unknown> } catch { continue }

    const visible = isCodexVisible(parsed)
    if (visible) {
      if (visibleSoFar >= upToVisibleIndex) break
      visibleSoFar++
    }
    kept.push(trimmed)
  }

  return {
    newContent: kept.length > 0 ? kept.join('\n') + '\n' : '',
    keptVisibleCount: visibleSoFar,
  }
}

/**
 * Concatenate Claude JSONL fragments and truncate the merged stream
 * through the Nth visible event. Used by fork.ts when the source thread
 * spans multiple `.jsonl` files (Claude SDK rotates session_id during
 * compaction). Earlier fragments come through verbatim; the cut lands
 * inside the fragment whose visible-event range covers the target index.
 *
 * Pure helper — fs reads happen in the caller. The order of `fragments`
 * is the chronological order the caller establishes (oldest first).
 */
export function assembleClaudeFork(
  fragments: string[],
  upToVisibleIndex: number,
  opts: TruncateClaudeOptions = {},
): TruncateClaudeResult {
  if (upToVisibleIndex <= 0 || fragments.length === 0) {
    return { newContent: '', anchorUuid: null, keptVisibleCount: 0 }
  }

  const parts: string[] = []
  let consumed = 0
  let anchorUuid: string | null = null
  for (const content of fragments) {
    const remaining = upToVisibleIndex - consumed
    if (remaining <= 0) break
    const r = truncateClaudeJsonl(content, remaining, opts)
    if (r.newContent) parts.push(r.newContent)
    if (r.anchorUuid) anchorUuid = r.anchorUuid
    consumed += r.keptVisibleCount
    // Stop once the cut landed inside a fragment (we kept exactly the
    // remaining quota). When the fragment was shorter than remaining we
    // exhausted it and should continue into the next one.
    if (r.keptVisibleCount >= remaining) break
  }
  return { newContent: parts.join(''), anchorUuid, keptVisibleCount: consumed }
}

/** Count visible Claude events in a raw JSONL string. Used by fork.ts
 *  to find which fragment in a multi-file thread contains the cut point. */
export function countClaudeVisibleEvents(content: string): number {
  let n = 0
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    try {
      if (isClaudeVisible(JSON.parse(trimmed))) n++
    } catch { /* skip malformed */ }
  }
  return n
}

function isCodexVisible(event: Record<string, unknown>): boolean {
  if (event.type !== 'response_item') return false
  const payload = event.payload as Record<string, unknown> | undefined
  if (!payload || payload.type !== 'message') return false
  const role = payload.role
  if (role !== 'user' && role !== 'assistant') return false
  if (!Array.isArray(payload.content)) return false
  return payload.content.some((b: Record<string, unknown>) => {
    const t = b.type
    return (t === 'input_text' || t === 'output_text' || t === 'text') &&
      typeof b.text === 'string' && b.text.length > 0
  })
}
