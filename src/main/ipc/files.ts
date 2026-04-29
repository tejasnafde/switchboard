/**
 * File-tree pane IPC. Backs the right-pane "Files" mode:
 *   - list-dir: directory listing annotated with isGitignored (renderer
 *     greys them out instead of filtering — VS Code-style)
 *   - read-file: capped read (2 MB hard cap) for the viewer
 *   - resolve: existence + abs-path lookup for inline FileChip pills,
 *     batched/debounced on the renderer side
 *
 * Pure logic lives in `../files/listing.ts` so it's unit-tested without
 * spinning up Electron.
 */
import { ipcMain } from 'electron'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { FilesChannels } from '@shared/ipc-channels'
import { listDirAnnotated, readFileCapped } from '../files/listing'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('ipc:files')

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2 MB hard cap for viewer

/**
 * Reject any subPath that escapes repoRoot via `..` or absolute paths.
 * Returns the normalized absolute path on success, throws on traversal.
 */
function resolveWithinRepo(repoRoot: string, subPath: string): string {
  const root = resolve(repoRoot)
  const candidate = isAbsolute(subPath) ? normalize(subPath) : resolve(root, subPath)
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes repo root: ${subPath}`)
  }
  return candidate
}

export function registerFilesHandlers(): void {
  for (const ch of Object.values(FilesChannels)) {
    ipcMain.removeHandler(ch)
  }

  ipcMain.handle(FilesChannels.LIST_DIR, async (_e, repoRoot: string, subPath = '') => {
    try {
      const abs = resolveWithinRepo(repoRoot, subPath)
      const entries = await listDirAnnotated(abs, repoRoot)
      return { ok: true, entries }
    } catch (err) {
      log.warn('list-dir failed', { repoRoot, subPath, err: (err as Error).message })
      return { ok: false, error: (err as Error).message, entries: [] }
    }
  })

  ipcMain.handle(FilesChannels.READ_FILE, async (_e, repoRoot: string, subPath: string) => {
    try {
      const abs = resolveWithinRepo(repoRoot, subPath)
      const out = await readFileCapped(abs, MAX_READ_BYTES)
      return { ok: true, ...out }
    } catch (err) {
      log.warn('read-file failed', { repoRoot, subPath, err: (err as Error).message })
      return { ok: false, error: (err as Error).message, content: '', truncated: false, totalBytes: 0 }
    }
  })

  ipcMain.handle(FilesChannels.RESOLVE, async (_e, repoRoot: string, subPath: string) => {
    try {
      const abs = resolveWithinRepo(repoRoot, subPath)
      await fs.access(abs)
      return { ok: true, exists: true, absPath: abs }
    } catch {
      return { ok: true, exists: false }
    }
  })
}
