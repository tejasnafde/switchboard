/**
 * Which files a tool call of this chat's agent wrote, so a diff card offers
 * Reject only for those. Anything else that changed during the turn (another
 * chat on the same checkout, the user in the IDE, a shell command) is shown
 * without Reject. Unknown shapes give no paths: the safe side is no Reject.
 */
import { isAbsolute, posix, resolve, win32 } from 'node:path'

/** Edit tools across the three agents, lower-cased (Claude, Codex `fileChange` as Edit, OpenCode tool ids). */
const WRITE_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit', 'apply_patch', 'patch'])

const PATCH_FILE_LINE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

/** Paths named by a `tool.started` input, absolute against `cwd`. */
export function agentWrittenPaths(toolName: string, input: unknown, cwd: string): string[] {
  if (!WRITE_TOOLS.has(toolName.toLowerCase()) || typeof input !== 'object' || input === null) return []
  const record = input as Record<string, unknown>
  const paths: string[] = []
  for (const key of ['file_path', 'filePath', 'notebook_path', 'move_path', 'path']) {
    const value = record[key]
    if (typeof value === 'string' && value) paths.push(value)
  }
  for (const key of ['patchText', 'patch', 'input']) {
    const value = record[key]
    if (typeof value === 'string') for (const match of value.matchAll(PATCH_FILE_LINE)) paths.push(match[1].trim())
  }
  return absolutePaths(paths, cwd)
}

export function absolutePaths(paths: readonly string[], cwd: string): string[] {
  return paths.map((p) => pathKey(isAbsolute(p) ? p : resolve(cwd, p)))
}

/**
 * One comparable form for a path on every platform: resolved, forward slashes,
 * and lower case on Windows, whose paths are case-insensitive (a tool may say
 * `C:\repo` where git's root says `c:/repo`).
 */
export function pathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = (platform === 'win32' ? win32 : posix).resolve(path).replace(/\\/g, '/')
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}
