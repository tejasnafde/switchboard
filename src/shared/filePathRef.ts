/**
 * Shared file-path reference helpers — used by:
 *   - MessageBubble post-processing to detect `<code>src/main/x.ts:42-58</code>`
 *     and turn it into a clickable FileChip pill
 *   - File viewer's selection-to-pill flow (build a `path:start-end` ref
 *     from a current selection)
 *   - Context bridge serialization
 *
 * Pure, no DOM, no fs. The on-disk existence check is done in the renderer
 * via a debounced IPC `files:resolve` round-trip.
 */

export interface FilePathRef {
  path: string
  startLine?: number
  endLine?: number
}

/**
 * Cheap heuristic: does this string look like a project-relative file path?
 *
 * Conservative on purpose — false positives turn random inline `<code>` like
 * `config.json` or "a/b/c" into broken file pills.
 *
 * Rules:
 *   1. No whitespace
 *   2. Must contain a `/` (single-token filenames excluded)
 *   3. Must end in `.<ext>` OR carry a `:line[-line]` suffix
 *   4. Must NOT start with `/` (absolute paths excluded — repo-relative only)
 *   5. Must NOT match a URL scheme
 */
export function looksLikeRepoPath(text: string): boolean {
  if (!text || /\s/.test(text)) return false
  if (text.startsWith('/')) return false
  if (/^[a-z]+:\/\//i.test(text)) return false // url scheme
  // Strip optional :line or :line-line suffix to validate the path part.
  const m = text.match(/^([^\s:]+?)(?::\d+(?:-\d+)?)?$/)
  if (!m) return false
  const pathPart = m[1]
  if (!pathPart.includes('/')) return false
  // Path part must have a file extension (last segment contains `.<chars>`).
  const last = pathPart.split('/').pop() ?? ''
  if (!/\.[a-zA-Z0-9]+$/.test(last)) return false
  return true
}

/**
 * Parse `path[:line[-line]]` into a FilePathRef. Returns null if the input
 * isn't path-shaped at all. If the `:N` suffix has invalid line numbers
 * (zero/negative), we leave them as part of the path string rather than
 * silently coercing — caller can decide whether to still render a pill.
 */
export function parseFilePathRef(text: string): FilePathRef | null {
  if (!looksLikeRepoPath(text)) return null
  const range = text.match(/^([^\s:]+):(\d+)(?:-(\d+))?$/)
  if (!range) {
    return { path: text }
  }
  const start = parseInt(range[2], 10)
  const end = range[3] !== undefined ? parseInt(range[3], 10) : start
  if (!Number.isFinite(start) || start <= 0 || !Number.isFinite(end) || end <= 0) {
    // Malformed line range — leave intact as part of the path.
    return { path: text }
  }
  return { path: range[1], startLine: start, endLine: end }
}

/** Inverse of parseFilePathRef. */
export function formatFilePathRef(ref: FilePathRef): string {
  if (ref.startLine == null) return ref.path
  if (ref.endLine == null || ref.endLine === ref.startLine) {
    return `${ref.path}:${ref.startLine}`
  }
  return `${ref.path}:${ref.startLine}-${ref.endLine}`
}
