/**
 * IPC for Settings > Archive & data > Worktrees and the kanban board's
 * worktree dialog. The logic lives in `../worktree-manager`.
 */
import { isAbsolute, resolve } from 'node:path'
import type { BackendHost } from '../backend/host'
import { WorktreeManagerChannels } from '@shared/ipc-channels'
import type { WorktreeProtectionPatch } from '@shared/worktree-manager'
import {
  buildWorktreeInventory,
  defaultWorktreeManagerDeps,
  removeManagedWorktree,
  updateWorktreeProtection,
  type WorktreeManagerDeps,
  type WorktreeRemovalRequest,
} from '../worktree-manager'

export function registerWorktreeManagerHandlers(
  host: BackendHost,
  deps: WorktreeManagerDeps = defaultWorktreeManagerDeps(),
): void {
  // Sizes are only measured for paths an inventory returned, so the channel
  // cannot be pointed at an arbitrary directory.
  const listed = new Set<string>()

  host.handle(WorktreeManagerChannels.INVENTORY, async (projectPaths?: string[]) => {
    const inventory = await buildWorktreeInventory(projectPaths, deps)
    for (const row of inventory.rows) listed.add(row.path)
    return inventory
  })

  host.handle(WorktreeManagerChannels.SIZE, async (path: string, opts?: { refresh?: boolean }) => {
    if (typeof path !== 'string' || !isAbsolute(path) || !listed.has(resolve(path))) return { bytes: null }
    return { bytes: await deps.sizes.get(resolve(path), opts) }
  })

  host.handle(WorktreeManagerChannels.REMOVE, async (request: WorktreeRemovalRequest) => {
    return removeManagedWorktree(request, deps)
  })

  host.handle(WorktreeManagerChannels.GET_PROTECTION, async () => deps.readProtection())

  host.handle(WorktreeManagerChannels.SET_PROTECTION, async (patch: WorktreeProtectionPatch) => {
    return updateWorktreeProtection(patch, deps)
  })
}
