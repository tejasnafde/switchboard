import { describe, it, expect } from 'vitest'
import { assembleClaudeForkAtEvent } from '../../src/main/agent/jsonl-truncate'

// ── Multi-fragment Claude (compaction-rotated session_id) ────────
//
// Claude SDK rotates session_id during compaction, so a single thread can
// span multiple `<sid>.jsonl` files. `assembleClaudeForkAtEvent` walks them in
// chronological order and cuts at one exact event id.

const fragmentA =
  [
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'a-u1',
      sessionId: 'sess-a',
      message: { role: 'user', content: 'q1' },
    }),
    JSON.stringify({
      parentUuid: 'a-u1',
      type: 'assistant',
      uuid: 'a-a1',
      sessionId: 'sess-a',
      message: { role: 'assistant', content: [{ type: 'text', text: 'r1' }] },
    }),
    JSON.stringify({
      parentUuid: 'a-a1',
      type: 'user',
      uuid: 'a-u2',
      sessionId: 'sess-a',
      message: { role: 'user', content: 'q2' },
    }),
  ].join('\n') + '\n'

const fragmentB =
  [
    // Compaction summary line that wires fragment B back to fragment A.
    JSON.stringify({ type: 'summary', summary: 'compact', leafUuid: 'a-u2' }),
    JSON.stringify({
      parentUuid: null,
      type: 'user',
      uuid: 'b-u1',
      sessionId: 'sess-b',
      message: { role: 'user', content: 'q3' },
    }),
    JSON.stringify({
      parentUuid: 'b-u1',
      type: 'assistant',
      uuid: 'b-a1',
      sessionId: 'sess-b',
      message: { role: 'assistant', content: [{ type: 'text', text: 'r3' }] },
    }),
    JSON.stringify({
      parentUuid: 'b-a1',
      type: 'user',
      uuid: 'b-u2',
      sessionId: 'sess-b',
      message: { role: 'user', content: 'q4' },
    }),
  ].join('\n') + '\n'

describe('assembleClaudeForkAtEvent', () => {
  it('cuts at the exact stable Claude event id and rewrites session and cwd metadata', () => {
    const result = assembleClaudeForkAtEvent([fragmentA, fragmentB], 'b-a1', {
      newSessionId: 'fork-session',
      newCwd: '/repo/.switchboard/worktrees/fork',
    })
    const lines = result.newContent
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))

    expect(result).toMatchObject({ anchorUuid: 'b-a1', anchorFound: true })
    expect(lines.at(-1).uuid).toBe('b-a1')
    expect(lines.every((line) => line.sessionId === 'fork-session')).toBe(true)
    expect(lines.every((line) => line.cwd === '/repo/.switchboard/worktrees/fork')).toBe(true)
  })

  it('rejects a missing or duplicated event id instead of cutting a similar message', () => {
    expect(assembleClaudeForkAtEvent([fragmentA], 'missing', { newSessionId: 'fork' })).toMatchObject({
      anchorFound: false,
      anchorUuid: null,
      newContent: '',
    })
    const duplicate = `${fragmentA}${fragmentA}`
    expect(assembleClaudeForkAtEvent([duplicate], 'a-a1', { newSessionId: 'fork' })).toMatchObject({
      anchorFound: false,
      anchorUuid: null,
      newContent: '',
    })
  })
})
