/** A remote (SSH) host the user has added. The local machine is synthesized in
 *  the renderer and not stored, so every Machine row is a remote. */
export interface Machine {
  id: string
  name: string
  sshAlias: string | null
  sshHost: string
  sshUser: string | null
  sshPort: number
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
}

/** A host candidate parsed from ~/.ssh/config for the "Add machine" picker. */
export interface SshHost {
  alias: string
  hostName?: string
  user?: string
  port: number
}
