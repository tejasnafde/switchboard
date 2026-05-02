/**
 * Unit tests for `decideDragOutcome` — the pure dispatcher behind sidebar
 * drag-end. Same-workspace drops emit `reorder`; cross-workspace drops
 * emit `reassign` (the workspace-id swap, no reorder). Anything else
 * falls through to `noop`.
 */
import { describe, it, expect } from 'vitest'
import { decideDragOutcome } from '../../src/renderer/components/sidebar/dragLogic'
import type { Project } from '../../src/shared/types'

function p(path: string, workspaceId: string | null = null): Project {
  return { path, name: path, sessions: [], workspaceId }
}

describe('decideDragOutcome', () => {
  it('returns noop when active === over', () => {
    const projects = [p('/a'), p('/b')]
    expect(decideDragOutcome(projects, '/a', '/a')).toEqual({ type: 'noop' })
  })

  it('returns noop when either id is missing from the list', () => {
    const projects = [p('/a'), p('/b')]
    expect(decideDragOutcome(projects, '/a', '/missing')).toEqual({ type: 'noop' })
    expect(decideDragOutcome(projects, '/missing', '/a')).toEqual({ type: 'noop' })
  })

  it('reorders within the same workspace', () => {
    const projects = [p('/a', 'w1'), p('/b', 'w1'), p('/c', 'w1')]
    expect(decideDragOutcome(projects, '/a', '/c')).toEqual({
      type: 'reorder',
      oldIndex: 0,
      newIndex: 2,
    })
  })

  it('reorders across the ungrouped (null workspaceId) bucket', () => {
    const projects = [p('/a'), p('/b'), p('/c')]
    expect(decideDragOutcome(projects, '/c', '/a')).toEqual({
      type: 'reorder',
      oldIndex: 2,
      newIndex: 0,
    })
  })

  it('reassigns when dragging into a different workspace', () => {
    const projects = [p('/a', 'w1'), p('/b', 'w2')]
    expect(decideDragOutcome(projects, '/a', '/b')).toEqual({
      type: 'reassign',
      projectPath: '/a',
      targetWorkspaceId: 'w2',
    })
  })

  it('reassigns from ungrouped (null) to a named workspace', () => {
    const projects = [p('/a', null), p('/b', 'w2')]
    expect(decideDragOutcome(projects, '/a', '/b')).toEqual({
      type: 'reassign',
      projectPath: '/a',
      targetWorkspaceId: 'w2',
    })
  })

  it('reassigns to ungrouped when target has no workspace', () => {
    const projects = [p('/a', 'w1'), p('/b', null)]
    expect(decideDragOutcome(projects, '/a', '/b')).toEqual({
      type: 'reassign',
      projectPath: '/a',
      targetWorkspaceId: null,
    })
  })
})
