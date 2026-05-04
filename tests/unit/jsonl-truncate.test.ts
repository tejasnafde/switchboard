import { describe, it, expect } from 'vitest'
import { truncateClaudeJsonl, truncateCodexJsonl, assembleClaudeFork } from '../../src/main/agent/jsonl-truncate'

// ── Claude JSONL fixtures ────────────────────────────────────────
//
// Mirror the real wire format: each line is a JSON object with a `uuid`
// per event, a `parentUuid` link, and a top-level `type` of
// `user | assistant | summary`. Switchboard's renderer-side ChatMessage
// stream comes from `JsonlParser.normalizeEvent`, which only yields
// `assistant`/`user`/`result` lines that carry visible content.
//
// `truncateClaudeJsonl` takes a 1-based count of *visible* events to
// keep — that's the contract the IPC layer can compute by indexing the
// renderer's loaded message array. It returns the truncated text plus
// the uuid of the last kept visible line (the resume anchor).

const claudeFixture = [
  // Pre-history summary line — non-visible, kept for context.
  JSON.stringify({ type: 'summary', summary: 'old chat', leafUuid: 'sum-1' }),
  // Visible user #1
  JSON.stringify({
    parentUuid: null, type: 'user', uuid: 'u1', sessionId: 'orig-session',
    message: { role: 'user', content: 'hello' },
  }),
  // Visible assistant #2
  JSON.stringify({
    parentUuid: 'u1', type: 'assistant', uuid: 'a1', sessionId: 'orig-session',
    message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  }),
  // Visible user #3
  JSON.stringify({
    parentUuid: 'a1', type: 'user', uuid: 'u2', sessionId: 'orig-session',
    message: { role: 'user', content: 'follow up' },
  }),
  // Visible assistant #4
  JSON.stringify({
    parentUuid: 'u2', type: 'assistant', uuid: 'a2', sessionId: 'orig-session',
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] },
  }),
].join('\n') + '\n'

describe('truncateClaudeJsonl', () => {
  it('keeps lines up through the Nth visible event', () => {
    const r = truncateClaudeJsonl(claudeFixture, 2)
    // Expect: summary + u1 + a1 (3 lines)
    const lines = r.newContent.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(r.anchorUuid).toBe('a1')
    expect(r.keptVisibleCount).toBe(2)
  })

  it('keeps everything when N exceeds the visible count', () => {
    const r = truncateClaudeJsonl(claudeFixture, 99)
    const lines = r.newContent.trim().split('\n')
    expect(lines).toHaveLength(5)
    expect(r.anchorUuid).toBe('a2')
    expect(r.keptVisibleCount).toBe(4)
  })

  it('returns null anchor when N=0', () => {
    const r = truncateClaudeJsonl(claudeFixture, 0)
    expect(r.anchorUuid).toBeNull()
    expect(r.keptVisibleCount).toBe(0)
  })

  it('rewrites sessionId on kept lines when newSessionId is provided', () => {
    const r = truncateClaudeJsonl(claudeFixture, 2, { newSessionId: 'fresh-uuid' })
    const lines = r.newContent.trim().split('\n').map((l) => JSON.parse(l))
    // The summary line has no sessionId — leave it alone.
    expect(lines[0].type).toBe('summary')
    expect(lines[1].sessionId).toBe('fresh-uuid')
    expect(lines[2].sessionId).toBe('fresh-uuid')
  })

  it('skips malformed lines gracefully', () => {
    const dirty = '{"not valid json\n' + claudeFixture
    const r = truncateClaudeJsonl(dirty, 1)
    expect(r.anchorUuid).toBe('u1')
  })
})

// ── Codex JSONL fixtures ─────────────────────────────────────────
//
// Codex events don't have a per-line uuid; the truncation contract is
// purely positional. We count `response_item` events whose payload is a
// user/assistant message — same predicate JsonlParser uses for Codex.

const codexFixture = [
  JSON.stringify({ type: 'session_meta', payload: {} }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } }),
  // Developer/system prompt — skipped by the parser, kept verbatim.
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'preamble' }] },
  }),
  // Visible user #1
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
  }),
  // Visible assistant #2
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
  }),
  // Visible user #3
  JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
  }),
].join('\n') + '\n'

// ── Multi-fragment Claude (compaction-rotated session_id) ────────
//
// Claude SDK rotates session_id during compaction, so a single thread can
// span multiple `<sid>.jsonl` files. `assembleClaudeFork` walks them in
// chronological order: earlier fragments come through verbatim, the cut
// lands inside the fragment whose visible-event range covers the target.

const fragmentA = [
  JSON.stringify({
    parentUuid: null, type: 'user', uuid: 'a-u1', sessionId: 'sess-a',
    message: { role: 'user', content: 'q1' },
  }),
  JSON.stringify({
    parentUuid: 'a-u1', type: 'assistant', uuid: 'a-a1', sessionId: 'sess-a',
    message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] },
  }),
  JSON.stringify({
    parentUuid: 'a-a1', type: 'user', uuid: 'a-u2', sessionId: 'sess-a',
    message: { role: 'user', content: 'q2' },
  }),
].join('\n') + '\n'

const fragmentB = [
  // Compaction summary line that wires fragment B back to fragment A.
  JSON.stringify({ type: 'summary', summary: 'compact', leafUuid: 'a-u2' }),
  JSON.stringify({
    parentUuid: null, type: 'user', uuid: 'b-u1', sessionId: 'sess-b',
    message: { role: 'user', content: 'q3' },
  }),
  JSON.stringify({
    parentUuid: 'b-u1', type: 'assistant', uuid: 'b-a1', sessionId: 'sess-b',
    message: { role: 'assistant', content: [{ type: 'text', text: 'r3' }] },
  }),
  JSON.stringify({
    parentUuid: 'b-a1', type: 'user', uuid: 'b-u2', sessionId: 'sess-b',
    message: { role: 'user', content: 'q4' },
  }),
].join('\n') + '\n'

describe('assembleClaudeFork', () => {
  it('cuts inside the first fragment, dropping later fragments entirely', () => {
    const r = assembleClaudeFork([fragmentA, fragmentB], 2, { newSessionId: 'fresh' })
    // Only fragmentA contributes; cut at visible #2 → u1 + a1.
    const lines = r.newContent.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.uuid)).toEqual(['a-u1', 'a-a1'])
    expect(r.anchorUuid).toBe('a-a1')
    expect(r.keptVisibleCount).toBe(2)
    // sessionId rewrite applied across the merge.
    expect(lines.every((l) => l.sessionId === 'fresh')).toBe(true)
  })

  it('walks past the first fragment to land the cut inside the second', () => {
    // fragmentA has 3 visible (u1,a1,u2); fragmentB has 3 (b-u1,b-a1,b-u2).
    // Picking visible #5 → all of A + summary + b-u1 + b-a1.
    const r = assembleClaudeFork([fragmentA, fragmentB], 5, { newSessionId: 'fresh' })
    const lines = r.newContent.trim().split('\n').map((l) => JSON.parse(l))
    // Order: a-u1, a-a1, a-u2 (all of A), summary, b-u1, b-a1
    expect(lines.map((l) => l.uuid ?? l.leafUuid)).toEqual([
      'a-u1', 'a-a1', 'a-u2', 'a-u2', 'b-u1', 'b-a1',
    ])
    expect(r.anchorUuid).toBe('b-a1')
    expect(r.keptVisibleCount).toBe(5)
  })

  it('returns empty result when N=0', () => {
    const r = assembleClaudeFork([fragmentA, fragmentB], 0)
    expect(r.newContent).toBe('')
    expect(r.anchorUuid).toBeNull()
    expect(r.keptVisibleCount).toBe(0)
  })

  it('caps at total visible count across all fragments', () => {
    const r = assembleClaudeFork([fragmentA, fragmentB], 99)
    expect(r.keptVisibleCount).toBe(6)
    expect(r.anchorUuid).toBe('b-u2')
  })
})

describe('truncateCodexJsonl', () => {
  it('keeps non-visible meta + N visible events', () => {
    const r = truncateCodexJsonl(codexFixture, 2)
    const lines = r.newContent.trim().split('\n')
    // session_meta + event_msg + developer + user + assistant = 5 lines
    expect(lines).toHaveLength(5)
    expect(r.keptVisibleCount).toBe(2)
  })

  it('caps at total visible count', () => {
    const r = truncateCodexJsonl(codexFixture, 99)
    expect(r.keptVisibleCount).toBe(3)
  })
})
