export interface IdeWorkspaceBinding {
  sessionId: string
  machineId: string
  folder: string
}

let committedBinding: IdeWorkspaceBinding | null = null

export function sameIdeWorkspaceTarget(
  left: IdeWorkspaceBinding | null,
  right: IdeWorkspaceBinding | null,
): boolean {
  return left?.machineId === right?.machineId && left?.folder === right?.folder
}

export function nextCommittedIdeBinding(
  current: IdeWorkspaceBinding | null,
  desired: IdeWorkspaceBinding,
  navigationCompleted: boolean,
): IdeWorkspaceBinding | null {
  if (current && sameIdeWorkspaceTarget(current, desired)) return desired
  return navigationCompleted ? desired : current
}

export function commitIdeWorkspaceBinding(binding: IdeWorkspaceBinding): void {
  committedBinding = binding
}

export function getCommittedIdeWorkspaceBinding(): IdeWorkspaceBinding | null {
  return committedBinding
}

export function clearIdeWorkspaceBinding(): void {
  committedBinding = null
}
