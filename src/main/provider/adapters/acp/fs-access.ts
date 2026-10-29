/**
 * Checks for the ACP `fs/read_text_file` and `fs/write_text_file` requests an
 * agent sends back to us. The agent process already runs as the user, so the
 * session folder is not a boundary here; what we enforce is the protocol's
 * absolute-path rule, a live session, and plan mode staying read-only.
 */
import { existsSync, realpathSync } from 'fs'
import path from 'path'
import type { RuntimeMode } from '../../types'
import { createMainLogger } from '../../../logger'

const log = createMainLogger('provider:acp-fs')

/**
 * `secretsRoot` is where Switchboard keeps the secrets a user gave an agent
 * (`<userData>/secrets`): a write there is refused, so this handler cannot
 * replace one. Reads stay allowed.
 */
export function acpFsProblem(
  op: 'read' | 'write',
  filePath: string,
  mode: RuntimeMode | undefined,
  secretsRoot?: string,
): string | null {
  if (mode === undefined) return 'No active session for this request.'
  if (!filePath || !path.isAbsolute(filePath)) return 'The path must be absolute.'
  if (op === 'write' && mode === 'plan') return 'Plan mode is read-only: the file was not written.'
  if (op === 'write' && secretsRoot && isInside(realish(filePath), realish(secretsRoot)))
    return 'Switchboard keeps secrets in that folder: the file was not written.'
  return null
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(dir, file)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** The path with its nearest existing ancestor resolved through symlinks, so a link into the folder is caught. */
function realish(filePath: string): string {
  const rest: string[] = []
  let current = path.resolve(filePath)
  while (!existsSync(current) && path.dirname(current) !== current) {
    rest.unshift(path.basename(current))
    current = path.dirname(current)
  }
  try {
    return path.join(realpathSync.native(current), ...rest)
  } catch (err) {
    log.warn('could not resolve a path for the secrets folder check', (err as NodeJS.ErrnoException).code)
    return path.resolve(filePath)
  }
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
