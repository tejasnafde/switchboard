/**
 * File-tree pane backend primitives. Three jobs:
 *
 *   - listDirAnnotated: enumerate a directory and tag each entry with
 *     `isDir` + `isGitignored`. We *annotate* rather than filter so the
 *     renderer can render gitignored entries at 50% opacity (VS Code style)
 *     while keeping them interactable.
 *
 *   - readFileCapped: read up to N bytes of a file. Returns `truncated:true`
 *     if the file was larger so the viewer can show a "load full file"
 *     banner without OOMing on a 50 MB log dump.
 *
 *   - getCachedGitignore: parse `.gitignore` once per (path, mtimeMs).
 *     Hot directories don't re-parse the same file on every tree expand;
 *     editing `.gitignore` invalidates the cache automatically via mtime.
 */
import { promises as fs } from 'node:fs'
import { join, relative } from 'node:path'
import { parseGitignore, isIgnored, type GitignoreRule } from './gitignore'

export interface DirEntry {
  name: string
  isDir: boolean
  isGitignored: boolean
}

interface CacheEntry {
  mtimeMs: number
  rules: GitignoreRule[]
}
const gitignoreCache = new Map<string, CacheEntry>()

export async function getCachedGitignore(absPath: string): Promise<GitignoreRule[]> {
  let stat
  try {
    stat = await fs.stat(absPath)
  } catch {
    return []
  }
  const cached = gitignoreCache.get(absPath)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.rules
  let content = ''
  try {
    content = await fs.readFile(absPath, 'utf8')
  } catch {
    return []
  }
  const rules = parseGitignore(content)
  gitignoreCache.set(absPath, { mtimeMs: stat.mtimeMs, rules })
  return rules
}

export async function listDirAnnotated(dirAbs: string, repoRoot: string): Promise<DirEntry[]> {
  const rules = await getCachedGitignore(join(repoRoot, '.gitignore'))
  const dirents = await fs.readdir(dirAbs, { withFileTypes: true })
  const out: DirEntry[] = []
  for (const d of dirents) {
    const abs = join(dirAbs, d.name)
    const rel = relative(repoRoot, abs).split(/[\\/]/).join('/')
    const isDir = d.isDirectory()
    out.push({
      name: d.name,
      isDir,
      isGitignored: isIgnored(rel, isDir, rules),
    })
  }
  // Stable sort: directories first, then case-insensitive name.
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

export interface CappedRead {
  content: string
  truncated: boolean
  totalBytes: number
  /** On-disk mtime at the moment of the read — passed through to the editor
   *  so save-conflict detection uses the real file mtime, not Date.now(). */
  mtimeMs: number
}

/**
 * Recursive walk of `repoRoot`, returning repo-relative paths. Used by
 * the ⌘P quick-open modal — gitignored files are *included* (the user
 * explicitly asked to skim build output / lockfiles too) but the giant
 * always-noise dirs `.git` and `node_modules` are skipped to keep the
 * traversal under a few seconds even on monorepos.
 */
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

export async function readFileCapped(absPath: string, capBytes: number): Promise<CappedRead> {
  const stat = await fs.stat(absPath)
  const handle = await fs.open(absPath, 'r')
  try {
    const size = Math.min(stat.size, capBytes)
    const buf = Buffer.alloc(size)
    await handle.read(buf, 0, size, 0)
    return {
      content: buf.toString('utf8'),
      truncated: stat.size > capBytes,
      totalBytes: stat.size,
      mtimeMs: stat.mtimeMs,
    }
  } finally {
    await handle.close()
  }
}
