/**
 * Where Open settings as JSON shows the file. The embedded IDE serves the
 * folder of the chat beside it, and can open a file outside that folder, but
 * only a local chat's workbench runs on this Mac, where the file is. With no
 * local chat there is no workbench to route to, so the system editor opens it.
 */
export interface OpenTargetSession {
  projectPath?: string | null
  worktreePath?: string | null
  machineId?: string | null
}

export function settingsJsonOpenTarget(session: OpenTargetSession | null | undefined): 'ide' | 'system' {
  if (!session || session.machineId) return 'system'
  return session.worktreePath || session.projectPath ? 'ide' : 'system'
}
