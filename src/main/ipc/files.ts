/**
 * File IPC surviving the CodeMirror-pane removal (the embedded IDE owns
 * browsing/reading now):
 *   - list-dir: lean listing for remote add-project path autocomplete
 *   - list-all: recursive file list for chat @-mentions
 *   - write-file / delete-file: FileDiffCard hunk accept/reject
 *   - resolve: existence + abs-path lookup for inline FileChip pills
 *
 * Pure logic lives in `../files/listing.ts` / `../files/writing.ts`.
 */
import type { BackendHost } from '../backend/host'
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path'
import { promises as fs } from 'node:fs'
import { FilesChannels } from '@shared/ipc-channels'
import { listAllFiles, listDirEntries } from '../files/listing'
import { writeFileSafe, deleteFileSafe } from '../files/writing'
import { createMainLogger as createLogger } from '../logger'

const log = createLogger('ipc:files')

const MAX_WRITE_BYTES = 8 * 1024 * 1024 // 8 MB cap on writes - caps a runaway buffer wiping the disk

/** Realpath the nearest existing ancestor (leaf may not exist for a new-file
 *  write) and re-append the tail, so symlinks are resolved for the check below. */
export async function realpathOrAncestor(p: string): Promise<string> {
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

export function registerFilesHandlers(host: BackendHost): void {
  host.handle(FilesChannels.LIST_DIR, async (repoRoot: string, subPath: string = '') => {
    try {
      const abs = await resolveWithinRepo(repoRoot, subPath)
      const entries = await listDirEntries(abs)
      return { ok: true, entries }
    } catch (err) {
      log.warn('list-dir failed', { repoRoot, subPath, err: (err as Error).message })
      return { ok: false, error: (err as Error).message, entries: [] }
    }
  })

  host.handle(FilesChannels.LIST_ALL, async (repoRoot: string) => {
    try {
      const root = resolve(repoRoot)
      const files = await listAllFiles(root)
      return { ok: true, files }
    } catch (err) {
      log.warn('list-all failed', { repoRoot, err: (err as Error).message })
      return { ok: false, error: (err as Error).message, files: [] }
    }
  })

  host.handle(
    FilesChannels.WRITE_FILE,
    async (repoRoot: string, subPath: string, content: string, expectedMtimeMs?: number) => {
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

  host.handle(FilesChannels.DELETE_FILE, async (repoRoot: string, subPath: string) => {
    try {
      const abs = await resolveWithinRepo(repoRoot, subPath)
      return await deleteFileSafe(abs)
    } catch (err) {
      log.warn('delete-file failed', { repoRoot, subPath, err: (err as Error).message })
      return { ok: false, error: (err as Error).message }
    }
  })

  host.handle(FilesChannels.RESOLVE, async (repoRoot: string, subPath: string) => {
    try {
      const abs = await resolveWithinRepo(repoRoot, subPath)
      await fs.access(abs)
      return { ok: true, exists: true, absPath: abs }
    } catch {
      return { ok: true, exists: false }
    }
  })
}
