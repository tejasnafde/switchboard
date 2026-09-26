import type { Project, Workspace } from '@shared/types'
import type { ComboboxOption } from '../ui/combobox-options'

export type PickerProject = Pick<Project, 'path' | 'name' | 'sessions' | 'workspaceId'>

const RECENT_PROJECT_COUNT = 3

function lastStarted(project: PickerProject): number {
  return (project.sessions ?? []).reduce((latest, session) => Math.max(latest, session.startedAt ?? 0), 0)
}

function parentDirName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : path
}

/**
 * The Settings project picker's rows: the projects with the newest chats
 * first under "Recent", then every other project under its sidebar
 * workspace in sidebar order, ungrouped ones last. A project is listed once.
 * Two projects with the same name are told apart by their parent folder.
 */
export function projectPickerOptions(
  projects: PickerProject[],
  workspaces: Workspace[],
  recentCount = RECENT_PROJECT_COUNT,
): ComboboxOption[] {
  const nameCount = new Map<string, number>()
  for (const project of projects) nameCount.set(project.name, (nameCount.get(project.name) ?? 0) + 1)
  const option = (project: PickerProject, group: string): ComboboxOption => ({
    value: project.path,
    label: project.name,
    hint: (nameCount.get(project.name) ?? 0) > 1 ? parentDirName(project.path) : undefined,
    group,
    keywords: [project.path],
  })

  const recent = projects
    .map((project, index) => ({ project, index, at: lastStarted(project) }))
    .filter((entry) => entry.at > 0)
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .slice(0, recentCount)
    .map((entry) => entry.project)
  const recentPaths = new Set(recent.map((project) => project.path))

  const orderedWorkspaces = [...workspaces].sort((a, b) => a.sortOrder - b.sortOrder)
  const known = new Set(orderedWorkspaces.map((workspace) => workspace.id))
  const rest = projects.filter((project) => !recentPaths.has(project.path))
  const grouped = orderedWorkspaces.flatMap((workspace) =>
    rest.filter((project) => project.workspaceId === workspace.id).map((project) => option(project, workspace.name)),
  )
  const ungrouped = rest.filter((project) => !project.workspaceId || !known.has(project.workspaceId))
  const ungroupedHeading = grouped.length > 0 ? 'Ungrouped' : recent.length > 0 ? 'Other projects' : 'Projects'

  return [
    ...recent.map((project) => option(project, 'Recent')),
    ...grouped,
    ...ungrouped.map((project) => option(project, ungroupedHeading)),
  ]
}
