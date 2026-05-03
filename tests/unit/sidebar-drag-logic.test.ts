/**
 * Unit tests for `decideDragOutcome` — the pure dispatcher behind sidebar
 * drag-end. Indices are computed in the *rendered* flat order (the same
 * array passed to SortableContext.items), NOT raw `projects` order — this
 * is what fixes the "swap adjacent items across a workspace boundary"
 * bug. Same-workspace drops emit `reorder`; cross-workspace drops emit
 * `reassign` carrying both the new workspaceId and the rendered drop
 * indices so the caller can land the item at the correct visual slot.
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
    expect(decideDragOutcome(projects, ['/a', '/b'], '/a', '/a')).toEqual({ type: 'noop' })
  })

  it('returns noop when either id is missing from the list', () => {
    const projects = [p('/a'), p('/b')]
    expect(decideDragOutcome(projects, ['/a', '/b'], '/a', '/missing')).toEqual({ type: 'noop' })
    expect(decideDragOutcome(projects, ['/a', '/b'], '/missing', '/a')).toEqual({ type: 'noop' })
  })

  it('reorders within the same workspace using rendered indices', () => {
    const projects = [p('/a', 'w1'), p('/b', 'w1'), p('/c', 'w1')]
    const rendered = ['/a', '/b', '/c']
    expect(decideDragOutcome(projects, rendered, '/a', '/c')).toEqual({
      type: 'reorder',
      oldIndex: 0,
      newIndex: 2,
    })
  })

  it('reorders across the ungrouped (null workspaceId) bucket', () => {
    const projects = [p('/a'), p('/b'), p('/c')]
    const rendered = ['/a', '/b', '/c']
    expect(decideDragOutcome(projects, rendered, '/c', '/a')).toEqual({
      type: 'reorder',
      oldIndex: 2,
      newIndex: 0,
    })
  })

  it('reassigns when dragging into a different workspace, carrying drop indices', () => {
    const projects = [p('/a', 'w1'), p('/b', 'w2')]
    const rendered = ['/a', '/b']
    expect(decideDragOutcome(projects, rendered, '/a', '/b')).toEqual({
      type: 'reassign',
      projectPath: '/a',
      targetWorkspaceId: 'w2',
      oldIndex: 0,
      newIndex: 1,
    })
  })

  it('reassigns from ungrouped (null) to a named workspace', () => {
    const projects = [p('/a', null), p('/b', 'w2')]
    const rendered = ['/b', '/a']
    expect(decideDragOutcome(projects, rendered, '/a', '/b')).toEqual({
      type: 'reassign',
      projectPath: '/a',
      targetWorkspaceId: 'w2',
      oldIndex: 1,
      newIndex: 0,
    })
  })

  it('reassigns to ungrouped when target has no workspace', () => {
    const projects = [p('/a', 'w1'), p('/b', null)]
    const rendered = ['/a', '/b']
    expect(decideDragOutcome(projects, rendered, '/a', '/b')).toEqual({
      type: 'reassign',
      projectPath: '/a',
      targetWorkspaceId: null,
      oldIndex: 0,
      newIndex: 1,
    })
  })

  it('uses rendered order — not raw projects order — for indices', () => {
    // Raw `projects` is interleaved (e.g. by added_at), but rendered order
    // is grouped by workspace. This is the regression case for the
    // cross-boundary "swap" bug: dragging the first project of W2 (rendered
    // index 2) onto the last project of W1 (rendered index 1) must yield
    // rendered indices {2,1}, NOT raw indices {1,2}.
    const projects = [
      p('/w1-a', 'w1'),
      p('/w2-a', 'w2'),  // raw index 1
      p('/w1-b', 'w1'),  // raw index 2
      p('/w2-b', 'w2'),
    ]
    const rendered = ['/w1-a', '/w1-b', '/w2-a', '/w2-b']
    expect(decideDragOutcome(projects, rendered, '/w2-a', '/w1-b')).toEqual({
      type: 'reassign',
      projectPath: '/w2-a',
      targetWorkspaceId: 'w1',
      oldIndex: 2,
      newIndex: 1,
    })
  })

  it('reorder uses rendered indices when raw and rendered orders differ', () => {
    const projects = [
      p('/w2-a', 'w2'),  // raw 0, rendered 2
      p('/w1-a', 'w1'),  // raw 1, rendered 0
      p('/w2-b', 'w2'),  // raw 2, rendered 3
      p('/w1-b', 'w1'),  // raw 3, rendered 1
    ]
    const rendered = ['/w1-a', '/w1-b', '/w2-a', '/w2-b']
    expect(decideDragOutcome(projects, rendered, '/w2-b', '/w2-a')).toEqual({
      type: 'reorder',
      oldIndex: 3,
      newIndex: 2,
    })
  })
})
