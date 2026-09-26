import { describe, expect, it } from 'vitest'
import type { SessionSummary, Workspace } from '@shared/types'
import { projectPickerOptions, type PickerProject } from '../../src/renderer/components/settings/project-picker-options'

const session = (startedAt: number) => ({ startedAt }) as SessionSummary
const project = (name: string, workspaceId: string | null, starts: number[] = [], path = `/p/${name}`): PickerProject => ({
  path, name, workspaceId, sessions: starts.map(session),
})
const workspace = (id: string, name: string, sortOrder: number): Workspace => ({ id, name, sortOrder, color: null, createdAt: 0 })

const rows = (options: ReturnType<typeof projectPickerOptions>) => options.map((o) => `${o.group}:${o.label}`)

describe('projectPickerOptions', () => {
  it('lists the projects with the newest chats first, then each workspace in its sort order, then ungrouped', () => {
    const projects = [
      project('ssg-api', 'ssg', [5]),
      project('someday', null),
      project('switchboard', null, [10, 90]),
      project('retail-core', 'retail'),
      project('ssg-web', 'ssg'),
      project('scout', 'retail', [50]),
    ]
    const workspaces = [workspace('retail', 'RETAILIQ', 2), workspace('ssg', 'SSG', 1)]
    expect(rows(projectPickerOptions(projects, workspaces, 2))).toEqual([
      'Recent:switchboard',
      'Recent:scout',
      'SSG:ssg-api',
      'SSG:ssg-web',
      'RETAILIQ:retail-core',
      'Ungrouped:someday',
    ])
  })

  it('breaks a recency tie by sidebar order and skips projects with no chats', () => {
    const projects = [project('a', null, [7]), project('b', null), project('c', null, [7])]
    expect(rows(projectPickerOptions(projects, []))).toEqual(['Recent:a', 'Recent:c', 'Other projects:b'])
  })

  it('names the only group "Projects" when there is nothing recent and no workspace', () => {
    expect(rows(projectPickerOptions([project('a', null), project('b', null)], []))).toEqual(['Projects:a', 'Projects:b'])
  })

  it('treats a project in a deleted workspace as ungrouped', () => {
    const workspaces = [workspace('w', 'Work', 0)]
    expect(rows(projectPickerOptions([project('a', 'w'), project('b', 'gone')], workspaces))).toEqual(['Work:a', 'Ungrouped:b'])
  })

  it('uses the path as the value and a search keyword, and tells same-named projects apart', () => {
    const options = projectPickerOptions([
      project('api', null, [], '/work/acme/api'),
      project('api', null, [], '/home/side/api'),
      project('web', null, [], '/work/acme/web'),
    ], [])
    expect(options.map((o) => [o.value, o.hint, o.keywords])).toEqual([
      ['/work/acme/api', 'acme', ['/work/acme/api']],
      ['/home/side/api', 'side', ['/home/side/api']],
      ['/work/acme/web', undefined, ['/work/acme/web']],
    ])
  })
})
