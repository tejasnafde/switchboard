/**
 * Checks for the ACP `fs/read_text_file` and `fs/write_text_file` requests an
 * agent sends back to us. The agent process already runs as the user, so the
 * session folder is not a boundary here; what we enforce is the protocol's
 * absolute-path rule, a live session, and plan mode staying read-only.
 */
import path from 'path'
import type { RuntimeMode } from '../../types'

export function acpFsProblem(op: 'read' | 'write', filePath: string, mode: RuntimeMode | undefined): string | null {
  if (mode === undefined) return 'No active session for this request.'
  if (!filePath || !path.isAbsolute(filePath)) return 'The path must be absolute.'
  if (op === 'write' && mode === 'plan') return 'Plan mode is read-only: the file was not written.'
  return null
}

/**
 * The lines an ACP read asks for: `line` is 1-based (default the first line)
 * and `limit` caps the count (default no cap). Neither set returns the file
 * unchanged.
 */
export function sliceTextLines(content: string, line?: number | null, limit?: number | null): string {
  if (line == null && limit == null) return content
  const start = Math.max(1, line ?? 1) - 1
  const lines = content.split('\n')
  const end = limit == null ? lines.length : start + Math.max(0, limit)
  return lines.slice(start, end).join('\n')
}
