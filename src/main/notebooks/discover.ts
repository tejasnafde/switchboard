/**
 * Bounded .ipynb discovery for a repo root. Feeds the session's mirror set
 * and the notebook system prompt - capped so a data-dump repo with hundreds
 * of notebooks cannot balloon session start or the prompt.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createMainLogger } from '../logger'

const log = createMainLogger('notebooks:discover')

/** Directories that never contain user notebooks worth mirroring. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '.switchboard', '.ipynb_checkpoints'])

const DEFAULT_CAP = 50

export function discoverNotebooks(repoRoot: string, opts: { cap?: number } = {}): string[] {
  const cap = opts.cap ?? DEFAULT_CAP
  const found: string[] = []

  const walk = (relDir: string): void => {
    if (found.length >= cap) return
    let entries
    try {
      entries = readdirSync(join(repoRoot, relDir), { withFileTypes: true })
    } catch (err) {
      log.warn('discover skipped unreadable dir', { relDir, error: String(err) })
      return
    }
    for (const entry of entries) {
      if (found.length >= cap) return
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(rel)
      } else if (entry.name.endsWith('.ipynb')) {
        found.push(rel)
      }
    }
  }

  walk('')
  return found.sort()
}
