/**
 * Per-thread branch picker IPC. Wraps the pure git CLI primitives in
 * src/main/git/refs.ts behind the GitChannels:
 *
 *   - LIST_REFS    → Ref[] for the picker popover
 *   - SWITCH_REF   → checkout (validated ref name; no shell injection)
 *   - CURRENT_BRANCH → trigger-chip label
 *
 * All handlers return a discriminated `{ ok: true, ... } | { ok: false, error }`
 * shape so the renderer never has to wrap calls in try/catch — same
 * convention as the FilesChannels handlers.
 */
import { app, ipcMain } from 'electron'
import { GitChannels } from '@shared/ipc-channels'
import { listRefs, switchRef, getCurrentBranch, type Ref } from '../git/refs'
import { createSessionWorktree } from '../worktree'
import { createMainLogger } from '../logger'

const log = createMainLogger('ipc:git')

export function registerGitHandlers(): void {
  for (const ch of Object.values(GitChannels)) {
    ipcMain.removeHandler(ch)
  }

  ipcMain.handle(
    GitChannels.LIST_REFS,
    async (_e, cwd: string): Promise<{ ok: true; refs: Ref[] } | { ok: false; error: string }> => {
      try {
        const refs = await listRefs(cwd)
        return { ok: true, refs }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`list-refs failed: ${msg}`)
        return { ok: false, error: msg }
      }
    },
  )

  ipcMain.handle(
    GitChannels.SWITCH_REF,
    async (_e, cwd: string, refName: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      try {
        await switchRef(cwd, refName)
        return { ok: true }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`switch-ref failed: ${msg}`)
        return { ok: false, error: msg }
      }
    },
  )

  ipcMain.handle(
    GitChannels.CURRENT_BRANCH,
    async (_e, cwd: string): Promise<{ ok: true; branch: string | null } | { ok: false; error: string }> => {
      try {
        const branch = await getCurrentBranch(cwd)
        return { ok: true, branch }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`current-branch failed: ${msg}`)
        return { ok: false, error: msg }
      }
    },
  )

  ipcMain.handle(
    GitChannels.CREATE_SESSION_WORKTREE,
    async (
      _e,
      args: { projectPath: string; branchSlug: string; baseRef?: string },
    ): Promise<{ ok: true; path: string; branch: string } | { ok: false; error: string }> => {
      try {
        const out = await createSessionWorktree({
          projectPath: args.projectPath,
          branchSlug: args.branchSlug,
          baseRef: args.baseRef,
          userDataDir: app.getPath('userData'),
        })
        return { ok: true, ...out }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`create-session-worktree failed: ${msg}`)
        return { ok: false, error: msg }
      }
    },
  )
}
