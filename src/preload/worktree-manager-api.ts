import { WorktreeManagerChannels } from '@shared/ipc-channels'
import type { Transport } from '@shared/transport'
import type {
  WorktreeInventory,
  WorktreeProtection,
  WorktreeProtectionPatch,
  WorktreeRemovalAck,
} from '@shared/worktree-manager'

export function createWorktreeManagerApi(transport: Transport) {
  return {
    inventory: (projectPaths?: string[]): Promise<WorktreeInventory> =>
      transport.invoke(WorktreeManagerChannels.INVENTORY, projectPaths),
    size: (path: string, opts?: { refresh?: boolean }): Promise<{ bytes: number | null }> =>
      transport.invoke(WorktreeManagerChannels.SIZE, path, opts),
    remove: (request: {
      projectPath: string
      worktreePath: string
      acknowledged: WorktreeRemovalAck | null
    }): Promise<{ ok: true } | { ok: false; error: string }> =>
      transport.invoke(WorktreeManagerChannels.REMOVE, request),
    getProtection: (): Promise<WorktreeProtection> =>
      transport.invoke(WorktreeManagerChannels.GET_PROTECTION),
    setProtection: (patch: WorktreeProtectionPatch): Promise<WorktreeProtection> =>
      transport.invoke(WorktreeManagerChannels.SET_PROTECTION, patch),
  }
}
