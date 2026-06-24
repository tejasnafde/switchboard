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
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { FilesChannels } from '@shared/ipc-channels'
import { listDirAnnotated, readFileCapped, listAllFiles } from '../files/listing'
import { writeFileSafe, deleteFileSafe } from '../files/writing'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('ipc:files')

const MAX_READ_BYTES = 2 * 1024 * 1024 // 2 MB hard cap for viewer
const MAX_WRITE_BYTES = 8 * 1024 * 1024 // 8 MB cap on writes — caps a runaway buffer wiping the disk

/** Realpath the nearest existing ancestor (leaf may not exist for a new-file
 *  write) and re-append the tail, so symlinks are resolved for the check below. */
async function realpathOrAncestor(p: string): Promise<string> {
  let dir = p
  const tail: string[] = []
  for (;;) {
    try {
      const real = await fs.realpath(dir)
      return tail.length ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return p
      tail.push(basename(dir))
      dir = parent
    }
  }
}

/**
 * Reject a subPath escaping repoRoot via `..`, an absolute path, or a symlink
 * pointing outside the repo (lexical checks alone miss the symlink case).
 */
export async function resolveWithinRepo(repoRoot: string, subPath: string): Promise<string> {
  const root = resolve(repoRoot)
  const candidate = isAbsolute(subPath) ? normalize(subPath) : resolve(root, subPath)
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path escapes repo root: ${subPath}`)
  }
  const realRoot = await realpathOrAncestor(root)
  const realCandidate = await realpathOrAncestor(candidate)
  const realRel = relative(realRoot, realCandidate)
  if (realRel.startsWith('..') || isAbsolute(realRel)) {
    throw new Error(`Path escapes repo root via symlink: ${subPath}`)
  }
  return candidate
}

export function registerFilesHandlers(): void {
  for (const ch of Object.values(FilesChannels)) {
    ipcMain.removeHandler(ch)
  }

  ipcMain.handle(FilesChannels.LIST_DIR, async (_e, repoRoot: string, subPath = '') => {
    try {
      const abs = await resolveWithinRepo(repoRoot, subPath)
      const entries = await listDirAnnotated(abs, repoRoot)
      return { ok: true, entries }
    } catch (err) {
      log.warn('list-dir failed', { repoRoot, subPath, err: (err as Error).message })
      return { ok: false, error: (err as Error).message, entries: [] }
    }
  })

  ipcMain.handle(FilesChannels.READ_FILE, async (_e, repoRoot: string, subPath: string) => {
    try {
      const abs = await resolveWithinRepo(repoRoot, subPath)
      const out = await readFileCapped(abs, MAX_READ_BYTES)
      return { ok: true, ...out }
    } catch (err) {
      log.warn('read-file failed', { repoRoot, subPath, err: (err as Error).message })
      return { ok: false, error: (err as Error).message, content: '', truncated: false, totalBytes: 0 }
    }
  })

  ipcMain.handle(FilesChannels.LIST_ALL, async (_e, repoRoot: string) => {
    try {
      const root = resolve(repoRoot)
      const files = await listAllFiles(root)
      return { ok: true, files }
    } catch (err) {
      log.warn('list-all failed', { repoRoot, err: (err as Error).message })
      return { ok: false, error: (err as Error).message, files: [] }
    }
  })

  ipcMain.handle(
    FilesChannels.WRITE_FILE,
    async (
      _e,
      repoRoot: string,
      subPath: string,
      content: string,
      expectedMtimeMs?: number,
    ) => {
      try {
        if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
          return { ok: false, error: `File too large to write (cap ${MAX_WRITE_BYTES} bytes)` }
        }
        const abs = await resolveWithinRepo(repoRoot, subPath)
        const res = await writeFileSafe(abs, content, { expectedMtimeMs })
        return res
      } catch (err) {
        log.warn('write-file failed', { repoRoot, subPath, err: (err as Error).message })
        return { ok: false, error: (err as Error).message }
      }
    },
  )

  ipcMain.handle(FilesChannels.DELETE_FILE, async (_e, repoRoot: string, subPath: string) => {
    try {
      const abs = await resolveWithinRepo(repoRoot, subPath)
      return await deleteFileSafe(abs)
    } catch (err) {
      log.warn('delete-file failed', { repoRoot, subPath, err: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    FilesChannels.READ_BATCH,
    async (_e, repoRoot: string, subPaths: string[]) => {
      const out: Array<{ path: string; content: string; mtimeMs: number; truncated: boolean }> = []
      for (const sub of subPaths) {
        try {
          const abs = await resolveWithinRepo(repoRoot, sub)
          const r = await readFileCapped(abs, MAX_READ_BYTES)
          out.push({ path: sub, content: r.content, mtimeMs: r.mtimeMs, truncated: r.truncated })
        } catch (err) {
          log.warn('read-batch: skipping unreadable entry', { sub, err: (err as Error).message })
        }
      }
      return { ok: true, files: out }
    },
  )

  ipcMain.handle(FilesChannels.RESOLVE, async (_e, repoRoot: string, subPath: string) => {
    try {
      const abs = await resolveWithinRepo(repoRoot, subPath)
      await fs.access(abs)
      return { ok: true, exists: true, absPath: abs }
    } catch {
      return { ok: true, exists: false }
    }
  })
}
