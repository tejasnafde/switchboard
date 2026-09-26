/**
 * IPC for Settings > Archive & data > Worktrees and the kanban board's
 * worktree dialog. The logic lives in `../worktree-manager`.
 */
import { isAbsolute } from 'node:path'
import type { BackendHost } from '../backend/host'
import { WorktreeManagerChannels } from '@shared/ipc-channels'
import { parseProtectionPatch } from '@shared/worktree-manager'
import {
  buildWorktreeInventory,
  defaultWorktreeManagerDeps,
  removeManagedWorktree,
  updateWorktreeProtection,
  type WorktreeManagerDeps,
  type WorktreeRemovalRequest,
} from '../worktree-manager'
import { pathKey } from '../worktree'

export function registerWorktreeManagerHandlers(
  host: BackendHost,
  deps: WorktreeManagerDeps = defaultWorktreeManagerDeps(),
): void {
  // Sizes are only measured for paths an inventory returned, so the channel
  // cannot be pointed at an arbitrary directory.
  const listed = new Map<string, string>()

  host.handle(WorktreeManagerChannels.INVENTORY, async (projectPaths?: string[]) => {
    const inventory = await buildWorktreeInventory(projectPaths, deps)
    for (const row of inventory.rows) listed.set(pathKey(row.path), row.path)
    return inventory
  })

  host.handle(WorktreeManagerChannels.SIZE, async (path: string, opts?: { refresh?: boolean }) => {
    const listedPath = typeof path === 'string' && isAbsolute(path) ? listed.get(pathKey(path)) : undefined
    if (!listedPath) return { bytes: null }
    return { bytes: await deps.sizes.get(listedPath, opts) }
  })

  host.handle(WorktreeManagerChannels.REMOVE, async (request: WorktreeRemovalRequest) => {
    return removeManagedWorktree(request, deps)
  })

  host.handle(WorktreeManagerChannels.GET_PROTECTION, async () => deps.readProtection())

  host.handle(WorktreeManagerChannels.SET_PROTECTION, async (raw: unknown) => {
    const patch = parseProtectionPatch(raw)
    if (!patch) throw new Error('Invalid worktree protection change: needs target project|worktree, an absolute path and protected true|false.')
    return updateWorktreeProtection(patch, deps)
  })
}
