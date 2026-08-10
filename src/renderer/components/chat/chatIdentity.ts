interface ChatIdentityInput {
  machineId?: string
  machineName?: string
  projectPath?: string
  title: string
  worktreeBranch?: string | null
}

export interface ChatIdentity {
  breadcrumb: string[]
  branch: string | null
}

export function chatIdentity(input: ChatIdentityInput): ChatIdentity {
  const breadcrumb: string[] = []
  if (input.machineId && input.machineId !== 'local') {
    breadcrumb.push(input.machineName || input.machineId)
  }
  const pathParts = input.projectPath?.split('/').filter(Boolean) ?? []
  const folder = pathParts[pathParts.length - 1]
  if (folder) breadcrumb.push(folder)
  breadcrumb.push(input.title)
  return { breadcrumb, branch: input.worktreeBranch ?? null }
}
