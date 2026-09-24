import type { Project, ProjectOrganizationItem, Workspace } from './types'

function move<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export function projectOrganizationItems(projects: Project[]): ProjectOrganizationItem[] {
  return projects.map((project) => ({
    path: project.path,
    workspaceId: project.workspaceId ?? null,
  }))
}

export function reorderWorkspacesById(
  workspaces: Workspace[],
  activeId: string,
  overId: string,
): Workspace[] {
  const from = workspaces.findIndex((workspace) => workspace.id === activeId)
  const to = workspaces.findIndex((workspace) => workspace.id === overId)
  if (from === -1 || to === -1 || from === to) return workspaces
  return move(workspaces, from, to).map((workspace, sortOrder) => ({ ...workspace, sortOrder }))
}

export function reorderProjectsWithinWorkspace(
  projects: Project[],
  workspaceId: string | null,
  activePath: string,
  overPath: string,
): Project[] {
  const paths = projects
    .filter((project) => (project.workspaceId ?? null) === workspaceId)
    .map((project) => project.path)
  const from = paths.indexOf(activePath)
  const to = paths.indexOf(overPath)
  if (from === -1 || to === -1 || from === to) return projects

  const group = projects.filter((project) => (project.workspaceId ?? null) === workspaceId)
  const orderedProjects = move(group, from, to)
  let index = 0
  return projects.map((project) => {
    if ((project.workspaceId ?? null) !== workspaceId) return project
    return orderedProjects[index++]
  })
}

export function moveProjectToWorkspace(
  projects: Project[],
  projectPath: string,
  workspaceId: string | null,
): Project[] {
  const from = projects.findIndex((project) => project.path === projectPath)
  if (from === -1) return projects

  const moving = { ...projects[from], workspaceId }
  const remaining = projects.filter((project) => project.path !== projectPath)
  let targetIndex = -1
  for (let index = 0; index < remaining.length; index++) {
    if ((remaining[index].workspaceId ?? null) === workspaceId) targetIndex = index
  }
  const next = [...remaining]
  next.splice(targetIndex + 1, 0, moving)
  return next
}
