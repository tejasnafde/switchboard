/**
 * bumpSessionActivity: when a session sends/receives a message, bump its
 * activity timestamp (the `startedAt` field the sidebar sorts + labels by,
 * which is loaded from conversations.updated_at) and re-sort its project's
 * sessions newest-first - so the active chat jumps to the top with "now"
 * live, not only after a reload.
 */
import { describe, it, expect } from 'vitest'
import { bumpSessionActivity } from '../../src/renderer/components/sidebar/sessionActivity'
import type { Project } from '@shared/types'

const projects = (): Project[] => [
  {
    path: '/repo',
    name: 'repo',
    sessions: [
      { id: 'a', source: 'switchboard', title: 'A', startedAt: 300, messageCount: 1, filePath: '' },
      { id: 'b', source: 'switchboard', title: 'B', startedAt: 200, messageCount: 1, filePath: '' },
      { id: 'c', source: 'switchboard', title: 'C', startedAt: 100, messageCount: 1, filePath: '' },
    ],
  },
  {
    path: '/other',
    name: 'other',
    sessions: [{ id: 'z', source: 'switchboard', title: 'Z', startedAt: 500, messageCount: 1, filePath: '' }],
  },
]

describe('bumpSessionActivity', () => {
  it('moves the bumped session to the top of its project and stamps the new time', () => {
    const out = bumpSessionActivity(projects(), 'c', 999)
    expect(out[0].sessions.map((s) => s.id)).toEqual(['c', 'a', 'b'])
    expect(out[0].sessions[0].startedAt).toBe(999)
  })

  it('leaves other projects untouched', () => {
    const out = bumpSessionActivity(projects(), 'c', 999)
    expect(out[1]).toEqual(projects()[1])
  })

  it('returns the SAME array reference when the session id is not found (no needless re-render)', () => {
    const input = projects()
    expect(bumpSessionActivity(input, 'missing', 999)).toBe(input)
  })

  it('is a no-op-shaped stable sort when the bump does not change order', () => {
    const out = bumpSessionActivity(projects(), 'a', 999)
    expect(out[0].sessions.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(out[0].sessions[0].startedAt).toBe(999)
  })
})
