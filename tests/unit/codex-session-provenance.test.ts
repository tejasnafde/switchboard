import { describe, expect, it } from 'vitest'
import { parseCodexSessionMetaRecord } from '../../src/main/projects/session-scanner'

describe('parseCodexSessionMetaRecord', () => {
  it('classifies structured Codex thread spawns as delegated child runs', () => {
    const meta = parseCodexSessionMetaRecord({
      type: 'session_meta',
      payload: {
        id: 'child-thread',
        cwd: '/repo',
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'parent-thread',
              depth: 1,
            },
          },
        },
      },
    })

    expect(meta).toMatchObject({
      id: 'child-thread',
      cwd: '/repo',
      relationship: 'subagent',
      parentSessionId: 'parent-thread',
      depth: 1,
    })
  })

  it('keeps a normal or rotated foreground thread independent', () => {
    expect(parseCodexSessionMetaRecord({
      type: 'session_meta',
      payload: { id: 'foreground', cwd: '/repo', source: 'cli' },
    })).toMatchObject({ relationship: 'foreground', parentSessionId: null })
  })

  it('rejects malformed records instead of guessing lineage', () => {
    expect(parseCodexSessionMetaRecord({ type: 'session_meta', payload: { id: 'x' } })).toBeNull()
  })
})
