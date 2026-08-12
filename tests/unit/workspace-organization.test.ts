import { describe, expect, it } from 'vitest'
import {
  moveProjectToWorkspace,
  reorderProjectsWithinWorkspace,
  reorderWorkspacesById,
} from '../../src/shared/workspaceOrganization'
import type { Project, Workspace } from '../../src/shared/types'

const workspace = (id: string, sortOrder: number): Workspace => ({
  id,
  name: id.toUpperCase(),
  color: null,
  sortOrder,
  createdAt: sortOrder,
})

const project = (path: string, workspaceId: string | null): Project => ({
  path,
  name: path.slice(1),
  workspaceId,
  sessions: [],
})

describe('reorderWorkspacesById', () => {
  it('moves the active workspace and rewrites contiguous sort orders', () => {
    const result = reorderWorkspacesById(
      [workspace('a', 0), workspace('b', 1), workspace('c', 2)],
      'c',
      'a',
    )

    expect(result.map(({ id, sortOrder }) => [id, sortOrder])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ])
  })

  it('returns the original array when either workspace is unknown', () => {
    const input = [workspace('a', 0), workspace('b', 1)]
    expect(reorderWorkspacesById(input, 'missing', 'a')).toBe(input)
    expect(reorderWorkspacesById(input, 'a', 'missing')).toBe(input)
  })
})

describe('reorderProjectsWithinWorkspace', () => {
  it('reorders only the selected workspace and preserves every other group', () => {
    const projects = [
      project('/a', 'one'),
      project('/b', 'one'),
      project('/c', 'two'),
      project('/d', null),
    ]

    const result = reorderProjectsWithinWorkspace(projects, 'one', '/b', '/a')

    expect(result.map((item) => item.path)).toEqual(['/b', '/a', '/c', '/d'])
    expect(result.find((item) => item.path === '/c')?.workspaceId).toBe('two')
    expect(result.find((item) => item.path === '/d')?.workspaceId).toBeNull()
  })

  it('does not move a project across workspaces through an in-group reorder', () => {
    const input = [project('/a', 'one'), project('/b', 'two')]
    expect(reorderProjectsWithinWorkspace(input, 'one', '/a', '/b')).toBe(input)
  })
})

describe('moveProjectToWorkspace', () => {
  it('appends the project to the target group without disturbing other groups', () => {
    const projects = [
      project('/a', 'one'),
      project('/b', 'two'),
      project('/c', 'two'),
      project('/d', null),
    ]

    const result = moveProjectToWorkspace(projects, '/a', 'two')

    expect(result.map((item) => item.path)).toEqual(['/b', '/c', '/a', '/d'])
    expect(result.find((item) => item.path === '/a')?.workspaceId).toBe('two')
  })

  it('appends to Ungrouped and preserves the project object when the path is missing', () => {
    const projects = [project('/a', 'one'), project('/b', null)]
    expect(moveProjectToWorkspace(projects, '/a', null).map((item) => item.path)).toEqual(['/b', '/a'])
    expect(moveProjectToWorkspace(projects, '/missing', null)).toBe(projects)
  })
})
