/**
 * Recursive walk of `repoRoot`, returning repo-relative paths. Used by the
 * chat input's @-mention autocomplete - gitignored files are *included* (the
 * user explicitly asked to reference build output / lockfiles too) but the
 * giant always-noise dirs `.git` and `node_modules` are skipped to keep the
 * traversal under a few seconds even on monorepos.
 */
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'

const ALWAYS_SKIP = new Set(['.git', 'node_modules'])
export async function listAllFiles(repoRoot: string, cap = 10000): Promise<string[]> {
  const out: string[] = []
  const stack: string[] = [repoRoot]
  while (stack.length > 0 && out.length < cap) {
    const dir = stack.pop() as string
    let dirents
    try { dirents = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const d of dirents) {
      if (ALWAYS_SKIP.has(d.name)) continue
      const abs = join(dir, d.name)
      if (d.isDirectory()) stack.push(abs)
      else if (d.isFile()) {
        const rel = relative(repoRoot, abs).split(/[\\/]/).join('/')
        out.push(rel)
        if (out.length >= cap) break
      }
    }
  }
  return out
}

export interface DirEntry {
  name: string
  isDir: boolean
}

/**
 * Lean directory listing: names + isDir, directories first. Survives the
 * CodeMirror-pane removal because the remote add-project modal autocompletes
 * paths with it (routed to the remote backend's registerFilesHandlers).
 */
export async function listDirEntries(dirAbs: string): Promise<DirEntry[]> {
  const dirents = await fs.readdir(dirAbs, { withFileTypes: true })
  const out = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }))
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}
