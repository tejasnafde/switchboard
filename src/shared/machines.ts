/** A remote (SSH) host the user has added. The local machine is synthesized in
 *  the renderer and not stored, so every Machine row is a remote. */
export interface Machine {
  id: string
  name: string
  sshAlias: string | null
  sshHost: string
  sshUser: string | null
  sshPort: number
  /** Run remote work as this user via sudo (e.g. 'ubuntu'); null = the ssh login user. */
  remoteUser: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface MachineInput {
  id?: string
  name: string
  sshAlias?: string | null
  sshHost: string
  sshUser?: string | null
  sshPort?: number
  remoteUser?: string | null
}

/** A host candidate parsed from ~/.ssh/config for the "Add machine" picker. */
export interface SshHost {
  alias: string
  hostName?: string
  user?: string
  port: number
}

/** A trimmed project + chat list, cached per remote so its tree can be browsed
 *  read-only while offline. Populated from the remote on connect (M4). */
export interface CachedProject {
  path: string
  name: string
  sessions: Array<{ id: string; title: string; agentType?: string | null }>
}

export interface MachineSnapshot {
  syncedAt: number
  projects: CachedProject[]
}
